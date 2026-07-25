// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCumulativeUsage } from '../../src/renderer/hooks/useChat';
import type { Message, Usage } from '../../src/shared/types/message';

describe('useCumulativeUsage', () => {
  it('does not rescan persisted messages when only current-turn usage changes', () => {
    const persisted: Usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cached_tokens: 10,
    };
    let usageReads = 0;
    const message = {
      get usage() {
        usageReads += 1;
        return persisted;
      },
    } as Message;
    const messages = [message];

    const { result, rerender } = renderHook(
      ({ currentTurnUsage }: { currentTurnUsage: Usage | null }) =>
        useCumulativeUsage(messages, currentTurnUsage),
      { initialProps: { currentTurnUsage: null } },
    );
    const readsAfterPersistedTotal = usageReads;

    rerender({
      currentTurnUsage: {
        prompt_tokens: 25,
        completion_tokens: 5,
        total_tokens: 30,
        cached_tokens: 0,
      },
    });

    expect(usageReads).toBe(readsAfterPersistedTotal);
    expect(result.current).toMatchObject({
      prompt_tokens: 125,
      completion_tokens: 25,
      total_tokens: 150,
      cached_tokens: 10,
    });
  });
});
