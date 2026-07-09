import { describe, expect, it } from 'vitest';
import {
  addUsage,
  hasUsage,
  sumMessageUsages,
  sumSubagentUsage,
  sumSubagentsUsage,
  subUsageByParentChain,
} from '../../src/shared/usage';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';

function msg(usage: Message['usage']): Message {
  return {
    id: 'm',
    role: MessageRole.ASSISTANT,
    content: 'x',
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage,
    hidden: false,
  };
}

describe('usage helpers', () => {
  it('hasUsage is false for empty/zero', () => {
    expect(hasUsage(null)).toBe(false);
    expect(
      hasUsage({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
      }),
    ).toBe(false);
  });

  it('sums message usages', () => {
    const total = sumMessageUsages([
      msg({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 4 }),
      msg({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cached_tokens: 1 }),
      msg(null),
    ]);
    expect(total).toEqual({
      prompt_tokens: 15,
      completion_tokens: 5,
      total_tokens: 20,
      cached_tokens: 5,
    });
  });

  it('aggregates subagent usage by parent chain', () => {
    const map = subUsageByParentChain([
      {
        parentChainIndex: 4,
        chain: {
          messages: [
            msg({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 50 }),
          ],
        },
      },
      {
        parentChainIndex: 4,
        chain: {
          messages: [
            msg({ prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, cached_tokens: 0 }),
          ],
        },
      },
      {
        parentChainIndex: null,
        chain: {
          messages: [
            msg({ prompt_tokens: 7, completion_tokens: 1, total_tokens: 8, cached_tokens: 0 }),
          ],
        },
      },
    ]);

    expect(map.get(4)).toEqual({
      prompt_tokens: 120,
      completion_tokens: 15,
      total_tokens: 135,
      cached_tokens: 50,
    });
    expect(map.get(-1)).toEqual({
      prompt_tokens: 7,
      completion_tokens: 1,
      total_tokens: 8,
      cached_tokens: 0,
    });
  });

  it('sumSubagentsUsage totals everything', () => {
    const total = sumSubagentsUsage([
      {
        parentChainIndex: 0,
        chain: {
          messages: [
            msg({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 }),
          ],
        },
      },
      {
        parentChainIndex: 1,
        chain: {
          messages: [
            msg({ prompt_tokens: 2, completion_tokens: 2, total_tokens: 4, cached_tokens: 0 }),
          ],
        },
      },
    ]);
    expect(total?.prompt_tokens).toBe(3);
    expect(sumSubagentUsage({ chain: { messages: [] } })).toBeNull();
  });

  it('addUsage treats null as zero', () => {
    expect(
      addUsage(null, {
        prompt_tokens: 3,
        completion_tokens: 0,
        total_tokens: 3,
        cached_tokens: 0,
      }),
    ).toEqual({
      prompt_tokens: 3,
      completion_tokens: 0,
      total_tokens: 3,
      cached_tokens: 0,
    });
  });
});
