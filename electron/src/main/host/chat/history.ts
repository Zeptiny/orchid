/**
 * Per-session chat message history — shared by the chat turn pipeline
 * (host/chat/*), the session-open path (host/session-ops.ts), and the host
 * protocol bindings (host/bindings/*), plus the Electron IPC facade.
 *
 * Electron-free domain state (relocated from ipc/chat-history.ts so the host
 * core no longer reaches into the IPC shell layer). Keys are session IDs
 * (not window/client IDs).
 */
import type { Message } from '../../../shared/types/message';

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
