import type { ServerWebSocket } from "bun";
import type { ChatMessage } from "./services/Chat";
import { extractSession, getAuthenticatedUserId } from "./session";
import * as Chat from "./services/Chat";
import * as Room from "./services/Room";
import type { RoomInfo } from "./services/Room";
import invariant from "tiny-invariant";
import { msgShouldBePersisted, isRoomExpired, parseChatCodes } from "./utils";

const MESSAGE_MAX_LENGTH = 200;

type WsData = { authToken: string; userId: number };

/** userId -> set of active websocket connections */
const connectionMap = new Map<number, Set<ServerWebSocket<WsData>>>();

function addConnection(userId: number, ws: ServerWebSocket<WsData>) {
  let connections = connectionMap.get(userId);
  if (!connections) {
    connections = new Set();
    connectionMap.set(userId, connections);
  }
  connections.add(ws);
}

function removeConnection(userId: number, ws: ServerWebSocket<WsData>) {
  const connections = connectionMap.get(userId);
  if (!connections) return;
  connections.delete(ws);
  if (connections.size === 0) {
    connectionMap.delete(userId);
  }
}

async function buildRoomInfo(chatCode: string): Promise<RoomInfo | null> {
  const metadata = await Room.getMetadata(chatCode);
  if (!metadata) return null;

  const [lastMessageTimestamp, totalMessageCount] = await Promise.all([
    Chat.getLastMessageTimestamp(chatCode),
    Chat.getMessageCount(chatCode),
  ]);

  return { chatCode, metadata, lastMessageTimestamp, totalMessageCount };
}

/** Publish a message to the room channel (for observers) and to each participant's user channel */
async function publishToRoom(
  server: ReturnType<typeof Bun.serve<WsData>>,
  chatCode: string,
  data: string
) {
  // Room channel for non-participant observers (staff/TOs)
  server.publish(chatCode, data);

  // User channels for participants
  const metadata = await Room.getMetadata(chatCode);
  if (metadata) {
    for (const userId of metadata.participantUserIds) {
      server.publish(`user__${userId}`, data);
    }
  }
}

invariant(process.env["SKALOP_TOKEN"], "Missing env var: SKALOP_TOKEN");
const server = Bun.serve<WsData>({
  async fetch(req, server) {
    const url = new URL(req.url);

    // handle messages sent by sendou.ink backend
    if (url.pathname === "/system") {
      if (req.headers.get("Skalop-Token") !== process.env["SKALOP_TOKEN"]) {
        return new Response(null, { status: 401 });
      }

      const body = await req.json();

      const { action } = body as { action: string };

      if (action === "setMetadata") {
        const { chatCode, metadata } = body as {
          chatCode: string;
          metadata: Room.RoomMetadata;
        };

        await Room.setMetadata(chatCode, metadata);

        // Update reverse index for each participant
        for (const userId of metadata.participantUserIds) {
          await Room.addUserToRoom(userId, chatCode);
        }

        // Notify connected participants
        const roomInfo = await buildRoomInfo(chatCode);
        if (roomInfo) {
          for (const userId of metadata.participantUserIds) {
            const connections = connectionMap.get(userId);
            if (!connections) continue;

            for (const ws of connections) {
              ws.send(
                JSON.stringify({
                  event: "ROOM_JOINED",
                  room: roomInfo,
                })
              );
            }
          }
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "sendMessage") {
        const { messages } = body as { messages: ChatMessage[] };

        for (const msg of messages) {
          if (msgShouldBePersisted(msg)) await Chat.saveMessage(msg);
          await publishToRoom(server, msg.room, JSON.stringify(msg));
        }

        return new Response(null, { status: 200 });
      }

      if (action === "removeRoom") {
        const { chatCode } = body as { chatCode: string };

        const removedUserIds = await Room.removeRoom(chatCode);

        for (const userId of removedUserIds) {
          const connections = connectionMap.get(userId);
          if (!connections) continue;

          for (const ws of connections) {
            ws.send(
              JSON.stringify({
                event: "ROOM_REMOVED",
                chatCode,
              })
            );
          }
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(null, { status: 400 });
    }

    const session = extractSession(req.headers.get("Cookie"));
    if (!session) {
      console.warn("No session found");
      return new Response(null, { status: 401 });
    }

    const userId = await getAuthenticatedUserId(session);
    if (!userId) {
      console.warn("No userId found from session");
      return new Response(null, { status: 401 });
    }

    const success = server.upgrade(req, {
      data: {
        authToken: session,
        userId,
      },
    });
    if (success) {
      return undefined;
    }

    console.warn("Upgrade failed");
    return new Response(null, { status: 405 });
  },
  websocket: {
    async open(ws) {
      const { userId } = ws.data;

      addConnection(userId, ws);

      // Subscribe to personal channel
      ws.subscribe(`user__${userId}`);

      // Look up user's rooms (participants receive messages via user channel, not room channel)
      const roomCodes = await Room.getUserRoomCodes(userId);
      const roomInfos: RoomInfo[] = [];

      for (const chatCode of roomCodes) {
        const info = await buildRoomInfo(chatCode);
        if (!info) continue;
        if (isRoomExpired(info.metadata.expiresAt)) continue;

        roomInfos.push(info);
      }

      // Send initial payload with room list (no message history)
      ws.send(JSON.stringify({ rooms: roomInfos }));
    },
    publishToSelf: true,
    async message(ws, message) {
      // Ping to keep connection alive
      if (message === "") return;

      const parsed = JSON.parse(message as string);
      const { event } = parsed;

      if (event === "CHAT_HISTORY") {
        const { chatCode } = parsed;
        const messages = await Chat.getMessages(chatCode);
        ws.send(JSON.stringify({ event: "CHAT_HISTORY", chatCode, messages }));
        return;
      }

      if (event === "SUBSCRIBE") {
        for (const chatCode of parseChatCodes(parsed.chatCode)) {
          const metadata = await Room.getMetadata(chatCode);
          // Participants receive messages via user channel,
          // they fetch history explicitly via CHAT_HISTORY event.
          // Sometimes participant might call SUBSCRIBE
          // due to a race condition
          if (!metadata || metadata.participantUserIds.includes(ws.data.userId)) continue;

          ws.subscribe(chatCode);
          const messages = await Chat.getMessages(chatCode);
          ws.send(
            JSON.stringify({ event: "CHAT_HISTORY", chatCode, messages, metadata })
          );
        }
        return;
      }

      if (event === "UNSUBSCRIBE") {
        for (const chatCode of parseChatCodes(parsed.chatCode)) {
          ws.unsubscribe(chatCode);
        }
        return;
      }

      if (event === "MESSAGE") {
        const { chatCode, id, contents } = parsed;

        // Check room isn't expired
        const metadata = await Room.getMetadata(chatCode);
        if (metadata && isRoomExpired(metadata.expiresAt)) {
          ws.send(
            JSON.stringify({ event: "ERROR", message: "Room has expired" })
          );
          return;
        }

        const chatMessage: ChatMessage = {
          id,
          contents: contents.slice(0, MESSAGE_MAX_LENGTH),
          userId: ws.data.userId,
          room: chatCode,
          timestamp: Date.now(),
        };

        const totalMessageCount = await Chat.saveMessage(chatMessage);
        const payload = JSON.stringify({ ...chatMessage, totalMessageCount });
        await publishToRoom(server, chatCode, payload);
        return;
      }

    },
    close(ws) {
      const { userId } = ws.data;
      removeConnection(userId, ws);
      // Bun auto-unsubscribes from all channels on close
    },
  },
});

console.log(`Listening on localhost:${server.port}`);
