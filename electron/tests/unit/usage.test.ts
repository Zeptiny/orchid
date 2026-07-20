import { describe, expect, it } from 'vitest';
import {
  addStepUsage,
  addUsage,
  contextUsedTokens,
  hasUsage,
  latestUsageFromMessages,
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

  it('keeps the newest context while summing message usages', () => {
    const context = {
      input_tokens: 20,
      output_tokens: 3,
      used_tokens: 23,
      system_tokens: 2,
      tools_tokens: 4,
      tool_use_tokens: 6,
      user_tokens: 5,
      assistant_tokens: 6,
    };

    expect(sumMessageUsages([
      msg({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 1 }),
      msg({
        prompt_tokens: 20,
        completion_tokens: 3,
        total_tokens: 23,
        cached_tokens: 4,
        context,
      }),
    ])).toEqual({
      prompt_tokens: 30,
      completion_tokens: 5,
      total_tokens: 35,
      cached_tokens: 5,
      context,
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

  it('addStepUsage sums counters and retains the newest context snapshot', () => {
    const firstContext = {
      input_tokens: 10,
      output_tokens: 2,
      used_tokens: 12,
      system_tokens: 1,
      tools_tokens: 2,
      tool_use_tokens: 3,
      user_tokens: 4,
      assistant_tokens: 2,
    };
    const secondContext = {
      input_tokens: 20,
      output_tokens: 3,
      used_tokens: 23,
      system_tokens: 2,
      tools_tokens: 4,
      tool_use_tokens: 6,
      user_tokens: 5,
      assistant_tokens: 6,
    };

    const accumulated = addStepUsage(
      {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        cached_tokens: 1,
        context: firstContext,
      },
      {
        prompt_tokens: 20,
        completion_tokens: 3,
        total_tokens: 23,
        cached_tokens: 4,
        context: secondContext,
      },
    );

    expect(accumulated).toEqual({
      prompt_tokens: 30,
      completion_tokens: 5,
      total_tokens: 35,
      cached_tokens: 5,
      context: secondContext,
    });
  });

  it('latestUsageFromMessages returns newest non-zero usage', () => {
    const older = {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      cached_tokens: 0,
    };
    const newer = {
      prompt_tokens: 500,
      completion_tokens: 50,
      total_tokens: 550,
      cached_tokens: 20,
    };
    expect(
      latestUsageFromMessages([
        msg(older),
        msg(null),
        msg(newer),
        msg(null),
      ]),
    ).toEqual(newer);
  });

  it('latestUsageFromMessages skips zero usage and empty lists', () => {
    expect(latestUsageFromMessages([])).toBeNull();
    expect(
      latestUsageFromMessages([
        msg(null),
        msg({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cached_tokens: 0,
        }),
      ]),
    ).toBeNull();
  });

  it('uses a context snapshot for preview occupancy without changing cumulative usage', () => {
    const usage = {
      prompt_tokens: 300,
      completion_tokens: 50,
      total_tokens: 350,
      cached_tokens: 100,
      context: {
        input_tokens: 200,
        output_tokens: 50,
        used_tokens: 250,
        system_tokens: 50,
        tools_tokens: 25,
        tool_use_tokens: 25,
        user_tokens: 75,
        assistant_tokens: 75,
      },
    };

    expect(contextUsedTokens(usage)).toBe(250);
    expect(contextUsedTokens({ ...usage, context: undefined })).toBe(350);
    expect(addUsage(usage, usage)).toEqual({
      prompt_tokens: 600,
      completion_tokens: 100,
      total_tokens: 700,
      cached_tokens: 200,
    });
  });
});
