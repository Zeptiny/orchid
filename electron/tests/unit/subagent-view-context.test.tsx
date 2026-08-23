// @vitest-environment jsdom
/**
 * SubagentView context ring (issue 168): the selected subagent's detail header
 * shows the same context radial as the main agent footer, with the context
 * window resolved from the subagent chain's persisted model selection.
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentView } from '../../src/renderer/components/SubagentView';
import { buildSubagentDetail, type UseSubagentsReturn } from '../../src/renderer/hooks/useSubagents';
import { contextTokensForSelection } from '../../src/renderer/utils/provider-selection';
import type { ProviderModelOption } from '../../src/shared/types/ipc';
import type { Chain } from '../../src/shared/types/chain';
import type { ModelSelection } from '../../src/shared/types/provider';
import { MessageRole, MessageType, type Message, type Usage } from '../../src/shared/types/message';
import type {
  SubagentLiveProjection,
  SubagentRecord,
  SubagentSummary,
} from '../../src/shared/types/subagent';
import { EMPTY_SUBAGENT_USAGE_SUMMARY } from '../../src/shared/usage';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const SELECTION: ModelSelection = { connectionId: CONNECTION_ID, modelId: 'sonnet' };
const SELECTION_KEY = `${CONNECTION_ID}\u001fsonnet`;

const MODEL_DETAILS: Readonly<Record<string, ProviderModelOption>> = {
  [SELECTION_KEY]: {
    selection: SELECTION,
    connectionName: 'Main',
    providerId: 'anthropic',
    providerDisplayName: 'Anthropic',
    model: {
      id: 'sonnet',
      displayName: 'Sonnet',
      protocol: 'anthropic-messages',
      lifecycle: 'active',
      source: 'catalog',
      capabilities: null,
      limits: { contextTokens: 200_000, outputTokens: 8_192 },
    },
    enabled: true,
    customized: false,
    discoveredAt: null,
    available: true,
    unavailableReason: null,
  },
};

const USAGE: Usage = {
  prompt_tokens: 900,
  completion_tokens: 100,
  total_tokens: 1_000,
  cached_tokens: 0,
  context: {
    input_tokens: 800,
    output_tokens: 200,
    used_tokens: 100_000,
    system_tokens: 10_000,
    tools_tokens: 5_000,
    tool_use_tokens: 20_000,
    user_tokens: 30_000,
    assistant_tokens: 35_000,
  },
};

function message(id: string, content: string): Message {
  return {
    id,
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: '2026-08-21T00:00:00.000Z',
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

function makeChain(selection: ModelSelection | null): Chain {
  return {
    id: 'chain-1',
    sessionId: 'session-1',
    status: 'completed',
    messages: [message('m-1', 'explored the repo')],
    selection,
    modelLabel: selection?.modelId ?? null,
    agentName: 'explorer',
    agentType: 'explorer',
    agentTier: 'bloom',
    startTime: '2026-08-21T00:00:00.000Z',
    endTime: '2026-08-21T00:01:00.000Z',
    subagentRecord: null,
  };
}

function makeRecord(chain: Chain, id = 'sub-1'): SubagentRecord {
  return {
    id,
    agent_name: 'explorer',
    agent_type: 'explorer',
    agent_tier: 'bloom',
    task: 'explore',
    status: 'completed',
    chain_id: chain.id,
    start_time: '2026-08-21T00:00:00.000Z',
    end_time: '2026-08-21T00:01:00.000Z',
    result: null,
    error: null,
    parentChainIndex: null,
    usage: USAGE,
    closed: false,
    chain,
  };
}

function makeSummary(): SubagentSummary {
  return {
    id: 'sub-1',
    agent_name: 'explorer',
    agent_type: 'explorer',
    agent_tier: 'bloom',
    agentRole: 'explorer',
    task: 'explore',
    status: 'completed',
    chain_id: 'chain-1',
    start_time: '2026-08-21T00:00:00.000Z',
    end_time: '2026-08-21T00:01:00.000Z',
    parentChainIndex: null,
    usage: USAGE,
  };
}

function makeHook(record: SubagentRecord, live: SubagentLiveProjection | null = null): UseSubagentsReturn {
  const summary = makeSummary();
  return {
    state: { status: 'ready', subagents: [summary] },
    subagents: [summary],
    groups: { queued: [], running: [], ended: [summary] },
    totalUsage: USAGE,
    usageByParentChain: new Map(),
    usageSummary: EMPTY_SUBAGENT_USAGE_SUMMARY,
    refresh: vi.fn(),
    retry: vi.fn(),
    isRetrying: false,
    selectedId: 'sub-1',
    select: vi.fn(),
    getDetail: (id: string) => (id === 'sub-1' ? buildSubagentDetail(summary, Date.parse('2026-08-21T00:01:00.000Z'), live) : null),
    transcript: { status: 'ready', record },
    retryTranscript: vi.fn(),
    live: new Map(),
    getLive: () => live,
  };
}

function liveWithOpenThinking(usage: Usage, thinkingChars: number): SubagentLiveProjection {
  return {
    sessionId: 'session-1',
    subagentId: 'sub-1',
    runId: 'run-1',
    sequence: 1,
    state: 'running',
    segments: [
      // Closed segments must never contribute to the streaming estimate.
      { kind: 'thinking', id: 'seg-closed', content: 'y'.repeat(500_000), startedAt: '2026-08-21T00:00:10.000Z', endedAt: '2026-08-21T00:00:20.000Z' },
      { kind: 'thinking', id: 'seg-open', content: 'x'.repeat(thinkingChars), startedAt: '2026-08-21T00:00:21.000Z', endedAt: null },
    ],
    toolCalls: [],
    usage,
    result: null,
    error: null,
    compactionProgress: null,
  };
}

function renderView(hook: UseSubagentsReturn, modelDetails?: Readonly<Record<string, ProviderModelOption>>) {
  return render(
    <SubagentView
      subagents={hook}
      openRequest={{ generation: 0, id: 'sub-1' }}
      modelDetails={modelDetails}
      onBackToChat={() => {}}
    />,
  );
}

afterEach(cleanup);

/** The context panel is portaled to document.body by ContextRadialButton. */
function queryPanel(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

describe('contextTokensForSelection', () => {
  it('resolves the window from typed model metadata', () => {
    expect(contextTokensForSelection(SELECTION, MODEL_DETAILS)).toBe(200_000);
  });

  it('returns null without a selection or matching metadata', () => {
    expect(contextTokensForSelection(null, MODEL_DETAILS)).toBeNull();
    expect(contextTokensForSelection(SELECTION, undefined)).toBeNull();
    expect(contextTokensForSelection(SELECTION, {})).toBeNull();
  });
});

describe('SubagentView context ring', () => {
  it('renders the radial for the selected subagent with the chain model window', () => {
    const { container } = renderView(makeHook(makeRecord(makeChain(SELECTION))), MODEL_DETAILS);
    const radial = container.querySelector('.orchid-footer-context-radial');
    expect(radial).not.toBeNull();
    expect(radial?.getAttribute('aria-valuenow')).toBe('50');

    fireEvent.click(container.querySelector('.orchid-footer-context-btn')!);
    expect(queryPanel()?.textContent).toContain('200.0k window');
  });

  it('degrades to the unknown-window state for legacy chains without a selection', () => {
    const { container } = renderView(makeHook(makeRecord(makeChain(null))), MODEL_DETAILS);
    const radial = container.querySelector('.orchid-footer-context-radial');
    expect(radial).not.toBeNull();
    expect(container.querySelector('.footer-context-value')?.textContent).toBe('—');
    expect(radial?.getAttribute('aria-label')).toContain('context window loading');
  });

  it('degrades to the unknown-window state when model metadata is unavailable', () => {
    const { container } = renderView(makeHook(makeRecord(makeChain(SELECTION))), undefined);
    expect(container.querySelector('.footer-context-value')?.textContent).toBe('—');
  });

  it('counts only open thinking chars that arrived after the last usage event', () => {
    const record = makeRecord(makeChain(SELECTION));
    const view = renderView(makeHook(record, liveWithOpenThinking(USAGE, 800)), MODEL_DETAILS);
    fireEvent.click(view.container.querySelector('.orchid-footer-context-btn')!);
    // The usage event covered the open segment's 800 chars: free stays 100.0k
    // (used 100k of the 200k window) with no double-counted estimate.
    expect(queryPanel()?.textContent).toContain('100.0k');
    // The segment grows by 40,000 chars with the same usage reference → only
    // the growth (10k tokens) joins the estimate: free drops to 90.0k.
    view.rerender(
      <SubagentView
        subagents={makeHook(record, liveWithOpenThinking(USAGE, 40_800))}
        openRequest={{ generation: 0, id: 'sub-1' }}
        modelDetails={MODEL_DETAILS}
        onBackToChat={() => {}}
      />,
    );
    const panel = queryPanel();
    expect(panel?.textContent).toContain('90.0k');
    expect(panel?.textContent).not.toContain('100.0k');
  });

  it('ignores a stale transcript that belongs to another subagent', () => {
    const otherRecord = makeRecord(makeChain(SELECTION), 'sub-other');
    const { container } = renderView(makeHook(otherRecord), MODEL_DETAILS);
    const radial = container.querySelector('.orchid-footer-context-radial');
    expect(radial).not.toBeNull();
    // Window cannot resolve from another row's chain selection.
    expect(container.querySelector('.footer-context-value')?.textContent).toBe('—');
    fireEvent.click(container.querySelector('.orchid-footer-context-btn')!);
    expect(queryPanel()?.textContent).not.toContain('200.0k window');
  });
});
