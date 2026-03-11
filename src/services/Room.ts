import { redis } from "../redis";

export interface RoomMetadata {
  participantUserIds: number[];
  chatUsers: {
    username: string;
    discordId: string;
    discordAvatar: string | null;
    pronouns: { subject: string; object: string } | null;
    chatNameHue: string | null;
    title?: string;
  }[];
  expiresAt: number;
  header: string;
  subtitle?: string;
  url?: string;
}

export interface RoomInfo {
  chatCode: string;
  metadata: RoomMetadata;
  lastMessageTimestamp: number | null;
  totalMessageCount: number;
}

const metaKey = (chatCode: string) => `room_meta__${chatCode}`;
const userRoomsKey = (userId: number) => `user_rooms__${userId}`;

const ONE_WEEK_SECONDS = 60 * 60 * 24 * 7;

export async function setMetadata(
  chatCode: string,
  metadata: RoomMetadata
): Promise<void> {
  const key = metaKey(chatCode);
  await redis.hset(key, {
    participantUserIds: JSON.stringify(metadata.participantUserIds),
    chatUsers: JSON.stringify(metadata.chatUsers),
    expiresAt: String(metadata.expiresAt),
    header: metadata.header,
    subtitle: metadata.subtitle ?? "",
    url: metadata.url ?? "",
  });

  const ttlSeconds =
    Math.floor((metadata.expiresAt - Date.now()) / 1000) + ONE_WEEK_SECONDS;
  if (ttlSeconds > 0) {
    await redis.expire(key, ttlSeconds);
  }
}

export async function getMetadata(
  chatCode: string
): Promise<RoomMetadata | null> {
  const raw = await redis.hgetall(metaKey(chatCode));
  if (!raw || Object.keys(raw).length === 0) return null;

  return {
    participantUserIds: JSON.parse(raw["participantUserIds"]!),
    chatUsers: JSON.parse(raw["chatUsers"]!),
    expiresAt: Number(raw["expiresAt"]),
    header: raw["header"]!,
    subtitle: raw["subtitle"] || undefined,
    url: raw["url"] || undefined,
  };
}

export async function getUserRoomCodes(userId: number): Promise<string[]> {
  return redis.smembers(userRoomsKey(userId));
}

export async function addUserToRoom(
  userId: number,
  chatCode: string
): Promise<void> {
  await redis.sadd(userRoomsKey(userId), chatCode);
}

export async function removeUserFromRoom(
  userId: number,
  chatCode: string
): Promise<void> {
  await redis.srem(userRoomsKey(userId), chatCode);
}
