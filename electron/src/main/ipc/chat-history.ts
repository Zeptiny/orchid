/**
 * Per-session chat message history — shared by chat and session IPC.
 *
 * Kept separate from chat.ts / session.ts to avoid circular imports.
 * Keys are session IDs (not window IDs).
 */
import type { Message } from '../../shared/types/message';

const messageHistory = new Map<string, Message[]>();

export function getChatHistory(sessionId: string): Message[] | undefined {
  return messageHistory.get(sessionId);
}

export function seedChatHistory(sessionId: string, messages: Message[]): void {
  messageHistory.set(sessionId, [...messages]);
}

export function setChatHistory(sessionId: string, messages: Message[]): void {
  messageHistory.set(sessionId, messages);
}

export function clearChatHistory(sessionId: string): void {
  messageHistory.delete(sessionId);
}

export function clearAllChatHistory(): void {
  messageHistory.clear();
}
