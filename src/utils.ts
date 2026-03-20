import { ChatMessage } from "./services/Chat";

export function msgShouldBePersisted(msg: ChatMessage) {
  if (msg.revalidateOnly) {
    return false;
  }

  return true;
}

export function isRoomExpired(expiresAt: number): boolean {
  return Date.now() > expiresAt;
}

/**
 * Normalize a chatCode value that may be a string or an array into a string array.
 * Filters out any non-string entries.
 */
export function parseChatCodes(raw: unknown): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((c): c is string => typeof c === "string");
}
