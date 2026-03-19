import { redis } from "../redis";

export interface ChatMessage {
  id: string;
  type?: string;
  contents?: any;
  revalidateOnly?: boolean;
  context?: any;
  userId?: number;
  timestamp: number;
  room: string;
}

interface ChatService {
  saveMessage(message: ChatMessage): Promise<number>;
  getMessages(room: string): Promise<ChatMessage[]>;
}

const getKey = (message: ChatMessage) => `chat__${message.room}`;

const saveMessage: ChatService["saveMessage"] = async (message) => {
  const count = await redis.rpush(getKey(message), JSON.stringify(message));
  await redis.expire(getKey(message), 60 * 60 * 24 * 30); // 30 days, refreshes on new messages
  return count;
};

const getMessages: ChatService["getMessages"] = async (room) => {
  // we only load the last 250 messages not to blow up frontend
  // in normal usage nobody should reach that anyway
  const rawMessages = await redis.lrange(
    getKey({ room } as ChatMessage),
    -250,
    -1
  );

  return rawMessages.map((msg) => JSON.parse(msg));
};

const getLastMessageTimestamp = async (
  room: string
): Promise<number | null> => {
  const raw = await redis.lindex(`chat__${room}`, -1);
  if (!raw) return null;

  const msg = JSON.parse(raw);
  return msg.timestamp ?? null;
};

const getMessageCount = async (room: string): Promise<number> => {
  return redis.llen(`chat__${room}`);
};

export { saveMessage, getMessages, getLastMessageTimestamp, getMessageCount };
