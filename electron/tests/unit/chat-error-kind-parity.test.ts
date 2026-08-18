/**
 * Parity guard between the main-process `ChatErrorKind` union
 * (src/shared/types/ipc.ts) and the preload boundary's `chatErrorEventSchema`
 * `kind` enum (src/shared/types/ipc-schemas.ts).
 *
 * Regression: the schema enum once omitted `context_length_exceeded` while the
 * main-process classification already emitted it, so the preload's inbound
 * `chat:error` validation safeParse-failed and silently dropped every error
 * carrying the new kind. The schema now derives its enum from CHAT_ERROR_KINDS
 * (with a compile-time exhaustiveness guard in src); these runtime tests pin
 * both directions of that parity and parse a representative payload per kind.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_ERROR_KINDS,
  chatErrorEventSchema,
} from '../../src/shared/types/ipc-schemas';
import type { ChatErrorKind, Message } from '../../src/shared/types/ipc';

/** The union mirror the schema enum is derived from. */
const ALL_KINDS: readonly ChatErrorKind[] = CHAT_ERROR_KINDS;

/** The runtime enum options compiled into chatErrorEventSchema. */
const SCHEMA_OPTIONS: readonly string[] = chatErrorEventSchema.shape.kind
  .unwrap()
  .options.map(String);

/** Minimal message satisfying the strict durable-history message schema. */
function minimalMessage(): Message {
  return {
    id: 'message-user',
    role: 'user',
    content: 'hello',
    type: 'text',
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: '2026-08-18T00:00:00.000Z',
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

function chatErrorPayload(kind: ChatErrorKind): Record<string, unknown> {
  return {
    sessionId: '6b7ed8a2-3f3f-4c4f-9b3a-9f0a1b2c3d4e',
    turnId: 'turn-1',
    sequence: 0,
    type: 'error',
    error: 'the request exceeded the context window',
    messages: [minimalMessage()],
    kind,
  };
}

describe('chat:error kind enum parity with ChatErrorKind', () => {
  it('accepts every ChatErrorKind member — including context_length_exceeded', () => {
    expect(SCHEMA_OPTIONS).toContain('context_length_exceeded');
    for (const kind of ALL_KINDS) {
      expect(SCHEMA_OPTIONS).toContain(kind);
    }
  });

  it('contains no option outside the ChatErrorKind union', () => {
    const unionMembers = new Set<string>(ALL_KINDS);
    for (const option of SCHEMA_OPTIONS) {
      expect(unionMembers.has(option)).toBe(true);
    }
  });

  it('parses a chat:error payload for every kind', () => {
    for (const kind of ALL_KINDS) {
      const result = chatErrorEventSchema.safeParse(chatErrorPayload(kind));
      expect(result.success, `kind "${kind}" should parse`).toBe(true);
      if (result.success) {
        expect(result.data.kind).toBe(kind);
      }
    }
  });

  it('still rejects unknown kinds', () => {
    const result = chatErrorEventSchema.safeParse(chatErrorPayload('nope' as ChatErrorKind));
    expect(result.success).toBe(false);
  });
});
