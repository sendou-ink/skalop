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
