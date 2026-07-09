/**
 * Per-window chat message history — shared by chat and session IPC.
 *
 * Kept separate from chat.ts / session.ts to avoid circular imports.
 */
import type { Message } from '../../shared/types/message';

const messageHistory = new Map<string, Message[]>();

export function getChatHistory(windowId: string): Message[] | undefined {
  return messageHistory.get(windowId);
}

export function seedChatHistory(windowId: string, messages: Message[]): void {
  messageHistory.set(windowId, [...messages]);
}

export function setChatHistory(windowId: string, messages: Message[]): void {
  messageHistory.set(windowId, messages);
}

export function clearChatHistory(windowId: string): void {
  messageHistory.delete(windowId);
}

export function clearAllChatHistory(): void {
  messageHistory.clear();
}
