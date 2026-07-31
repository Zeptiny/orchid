/**
 * Chat rendering contract — U5 flat chat + stream safety.
 *
 * Source-level contracts for flat message presentation (no DaisyUI chat bubbles),
 * history/live-tail memoization, auto-scroll threshold, and stream defect fixes.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageRole, MessageType, type Message } from '../../src/shared/types/message';
import {
  AUTO_SCROLL_THRESHOLD_PX,
  isUserScrolledAwayFromBottom,
  shouldRenderChainFooter,
  shouldAutoScroll,
} from '../../src/renderer/components/ChatStream';
import { MessageWidget } from '../../src/renderer/components/MessageWidget';
import { MarkdownContent } from '../../src/renderer/components/MarkdownContent';
import { scrollContainerToLatest } from '../../src/renderer/hooks/useSmartAutoScroll';

const RENDERER = path.resolve(__dirname, '../../src/renderer');
const COMPONENTS = path.join(RENDERER, 'components');

function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER, rel), 'utf8');
}

describe('chat rendering contract (U5)', () => {
  describe('flat chat presentation', () => {
    it('MessageWidget keeps flat msg classes and never uses DaisyUI chat shells', () => {
      const src = read('components/MessageWidget.tsx');
      expect(src).toMatch(/orchid-msg-user/);
      expect(src).toMatch(/orchid-msg-assistant/);
      // Class attributes must not include DaisyUI chat / chat-start shells
      expect(src).not.toMatch(/className=["'`][^"'`]*(?:chat-bubble|chat-start|chat-end)\b/);
      expect(src).not.toMatch(/className=["'`][^"'`]*\bchat\b/);
    });

    it('ChatStream does not introduce DaisyUI chat wrappers', () => {
      const src = read('components/ChatStream.tsx');
      expect(src).not.toMatch(/className=["'`][^"'`]*(?:chat-bubble|chat-start|chat-end)\b/);
      expect(src).toMatch(/buildHistoryStreamItems|historyItems/);
      expect(src).toMatch(/buildLiveTailItems|liveGroupedItems|liveItems/);
    });

    it('activity widgets use surrounding state primitives (badge/loading/alert)', () => {
      const tool = read('components/ToolCallBlock.tsx');
      const toolShell = read('components/ToolResults/ToolResultShell.tsx');
      const thought = read('components/MessageWidget.tsx');
      const error = read('components/ErrorBanner.tsx');
      // Status badges live on the shared shell used by ToolCallBlock
      expect(tool).toMatch(/ToolResultShell/);
      expect(toolShell).toMatch(/StatusBadge/);
      // Migrated to Spinner primitive — source uses <Spinner> instead of raw loading classes
      expect(tool).toMatch(/<Spinner\b/);
      expect(thought).toMatch(/<Spinner\b|streaming-cursor/);
      // Migrated to Alert primitive — source uses <Alert> instead of raw alert classes
      expect(error).toMatch(/<Alert\b/);
      // Guard against raw class regression
      expect(tool).not.toMatch(/loading loading-spinner/);
      expect(error).not.toMatch(/className=.*alert\b/);
    });

    it('thinking content follows the live disclosure lifecycle and preserves line breaks', () => {
      const src = read('components/MessageWidget.tsx');
      const styles = read('styles/components.css');
      const contentStart = src.indexOf('className="orchid-thought-content"');
      const contentSource = src.slice(contentStart, contentStart + 500);

      expect(contentStart).toBeGreaterThanOrEqual(0);
      expect(src).toContain('setExpanded(Boolean(isStreaming))');
      expect(src).toContain('window.setInterval(updateElapsed, 100)');
      expect(src).toContain('if (isStreaming) return formatDurationMs(streamingElapsedMs)');
      expect(contentSource).toContain('onClick={collapse}');
      expect(contentSource).toContain('role="button"');
      expect(contentSource).toContain('title="Click to collapse"');
      expect(styles).toMatch(/\.orchid-thought-content\s*\{[\s\S]*?white-space:\s*pre-wrap;/);
    });

    it('starts live thinking expanded with elapsed time and settled thinking collapsed', () => {
      const message: Message = {
        id: 'thought-contract',
        role: MessageRole.ASSISTANT,
        content: 'first line\nsecond line',
        type: MessageType.THINKING,
        tool_calls: null,
        tool_call_id: null,
        name: null,
        thinking: 'first line\nsecond line',
        timestamp: new Date().toISOString(),
        usage: null,
        hidden: false,
        tool_result: null,
      };

      const live = renderToStaticMarkup(createElement(MessageWidget, { message, isStreaming: true }));
      const settled = renderToStaticMarkup(createElement(MessageWidget, { message, isStreaming: false }));

      expect(live).toContain('aria-expanded="true"');
      expect(live).toContain('Thinking… 0ms');
      expect(live).toContain('first line\nsecond line');
      expect(settled).toContain('aria-expanded="false"');
      expect(settled).toContain('orchid-thought-content');
      expect(settled).toContain('orchid-collapsible-region');
      expect(settled).toContain('aria-hidden="true"');
      expect(settled).toContain('inert=""');
    });
  });

  describe('memoization boundary', () => {
    it('ChatStream keeps committed history separate from live tail', () => {
      const src = read('components/ChatStream.tsx');
      // History memo must not depend on streamingContent
      expect(src).toMatch(/const history = useMemo/);
      expect(src).toMatch(/const liveItems = useMemo|buildLiveTailItems/);
      // Live path is gated by streaming status
      expect(src).toMatch(/status === 'streaming' \? streamingContent/);
      // SESSION_UPDATED can land before CHAT_DONE — suppress live text already in history
      expect(src).toMatch(/suppressLiveMessagesAlreadyInHistory/);
    });

    it('feeds history attribution from the low-frequency usage summary, not records', () => {
      const src = read('components/ChatStream.tsx');
      const builder = read('utils/stream-building.ts');
      const historyStart = src.indexOf('const history = useMemo');
      expect(historyStart).toBeGreaterThanOrEqual(0);
      // Balanced-parenthesis extraction: the first generic `');'` could cut an
      // inline call short, so scan from the opening paren of `useMemo(` to its
      // matching close (the dependency-array terminator).
      const openParen = src.indexOf('(', historyStart);
      let depth = 0;
      let end = -1;
      for (let i = openParen; i < src.length; i += 1) {
        const ch = src[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      expect(end).toBeGreaterThan(openParen);
      const historyMemo = src.slice(historyStart, end);
      // History memo depends on the usage summary, never the records array
      expect(historyMemo).toContain('subagentUsage');
      expect(historyMemo).not.toMatch(/\bsubagents\b/);
      // History builders consume the summary; record-derived usage computation
      // moved into the hook's memoized summary
      expect(builder).toMatch(/subagentUsage: SubagentUsageSummary;/);
      expect(src).not.toMatch(/subUsageByParentChain\(/);
      expect(src).not.toMatch(/sumSubagentsUsage\(/);
      // Render path keeps title-only records for wait/interrupt chips
      expect(src).toMatch(/subagents\?: readonly SubagentTitleRecord\[\]/);
    });
  });

  describe('auto-scroll threshold', () => {
    it('exports the exact 100px threshold contract', () => {
      expect(AUTO_SCROLL_THRESHOLD_PX).toBe(100);
      expect(isUserScrolledAwayFromBottom(500, 1000, 400)).toBe(false);
      expect(isUserScrolledAwayFromBottom(400, 1000, 400)).toBe(true);
      expect(shouldAutoScroll(true)).toBe(false);
      expect(shouldAutoScroll(false)).toBe(true);
    });

    it('does not force-scroll on every streaming status tick', () => {
      const src = read('components/ChatStream.tsx');
      const scrollHook = read('hooks/useSmartAutoScroll.ts');
      // Reset scroll-away only on session change — not when entering streaming
      expect(scrollHook).toMatch(/setFollowing\(true\)/);
      expect(scrollHook).toMatch(/\[container, resetKey, setFollowing\]/);
      expect(src).not.toMatch(
        /status === 'streaming'[\s\S]{0,200}setIsUserScrolledUp\(false\)/,
      );
      // New stream start still respects shouldAutoScroll
      expect(src).toMatch(/shouldAutoScroll\(isUserScrolledUp\)/);
      expect(src).toMatch(
        /if \(isVisible && status === 'streaming' && prev !== 'streaming'\)/,
      );
      expect(src).toMatch(
        /\[status, isVisible, isUserScrolledUp, followLatest\]/,
      );
    });

    it('binds the scroll listener to a late-mounted container', () => {
      const scrollHook = read('hooks/useSmartAutoScroll.ts');
      expect(scrollHook).toMatch(/const \[container, setContainer\]/);
      expect(scrollHook).toMatch(/const containerRef = useCallback/);
      expect(scrollHook).toMatch(
        /\[container, enabled, followLatest, setFollowing\]/,
      );
    });

    it('scrolls only the transcript container, never an outer document ancestor', () => {
      const calls: ScrollToOptions[] = [];
      scrollContainerToLatest({
        scrollHeight: 12_345,
        scrollTo: (options: ScrollToOptions) => calls.push(options),
      }, 'auto');
      expect(calls).toEqual([{ top: 12_345, behavior: 'auto' }]);
      expect(read('hooks/useSmartAutoScroll.ts')).not.toContain('scrollIntoView');
      expect(read('components/ChatStream.tsx')).not.toContain('scrollIntoView');
    });

    it('offers Jump to latest when the main chat is scrolled away from the bottom', () => {
      const src = read('components/ChatStream.tsx');

      expect(src).toContain('isUserScrolledUp ? (');
      expect(src).toContain('onClick={jumpToLatest}');
      expect(src).toContain('Jump to latest');
    });

    it('uses a bounded revision key and instant follow scrolling during live updates', () => {
      const stream = read('components/ChatStream.tsx');
      const scrollHook = read('hooks/useSmartAutoScroll.ts');
      const styles = read('styles/components.css');

      expect(stream).toMatch(/contentKey:\s*`\$\{messages\.length\}:\$\{streamRevision\}`/);
      expect(stream).not.toContain('JSON.stringify');
      expect(scrollHook).toMatch(
        /isFollowingRef\.current\)\s*scrollToLatest\('instant'\)/,
      );
      expect(scrollHook).toMatch(/jumpToLatest[\s\S]*scrollToLatest\('smooth'\)/);
      expect(styles).not.toMatch(
        /\.orchid-chat-scroll\s*\{[^}]*scroll-behavior:\s*smooth/,
      );
    });
  });

  describe('stream defect fixes', () => {
    it('batches normalized stream actions into one animation-frame reducer dispatch', () => {
      const src = read('hooks/useChat.ts');
      const subscriptions = src.slice(
        src.indexOf('const unsubChunk'),
        src.indexOf('const unsubState'),
      );

      expect(src).toContain('pendingFrameActionsRef');
      expect(src).toContain('window.requestAnimationFrame');
      expect(src).toContain('scheduleStreamFrame');
      expect(src).toMatch(/dispatchProjection\(\{ type: 'events', actions \}\)/);
      expect(subscriptions).toContain('queueFrameEvent(normalize(event))');
      expect(subscriptions).not.toContain('dispatchProjection');
    });

    it('syntax-highlights active streaming text', () => {
      const markdown = '```ts\nconst orchid = true;\n```';
      const streaming = renderToStaticMarkup(
        createElement(MarkdownContent, { content: markdown }),
      );

      expect(streaming).toContain('hljs');

      const messageWidget = read('components/MessageWidget.tsx');
      expect(messageWidget).toContain(
        '<MarkdownContent content={message.content} />',
      );
    });

    it('send failure cleanup clears the projection stream, sets local error, and removes optimistic bubbles', () => {
      const src = read('hooks/useChat.ts');
      expect(src).toMatch(/Drop the optimistic user bubble when send never started/);
      expect(src).toMatch(/dropOptimisticUserMessageIfLast/);
      const sendStart = src.indexOf('const send = useCallback');
      const sendEnd = src.indexOf('const cancel = useCallback', sendStart);
      const sendSource = src.slice(sendStart, sendEnd);
      expect(sendSource).toMatch(/result\.status === 'error'/);
      expect(sendSource).toMatch(/catch \(err\)/);
      // Both structured and thrown failures clear live projection state, set the
      // reducer's local error, and remove their own optimistic user bubble.
      const clearStreamHits = sendSource.match(/type: 'clear_stream', status: 'error'/g) ?? [];
      const localErrorHits = sendSource.match(/type: 'local_error'/g) ?? [];
      const dropHits = sendSource.match(/dropOptimisticUserMessageIfLast/g) ?? [];
      expect(clearStreamHits.length).toBeGreaterThanOrEqual(2);
      expect(localErrorHits.length).toBeGreaterThanOrEqual(2);
      expect(dropHits.length).toBeGreaterThanOrEqual(2);
    });

    it('null live snapshot drains buffered events through sequence affinity', () => {
      const src = read('hooks/useChat.ts');
      expect(src).toMatch(/if \(!live\)/);
      expect(src).toContain('BufferedProjectionEvent');
      expect(src).toContain('replayHydrationBuffer(bufferedEvents)');
      const replayStart = src.indexOf('const replayHydrationBuffer');
      const replayEnd = src.indexOf('const hydrateSnapshot', replayStart);
      const replaySource = src.slice(replayStart, replayEnd);
      expect(replaySource).toMatch(/acceptsEvent\(event\)/);
      expect(replaySource).toMatch(/applyLiveEvent\(event\)/);
    });

    it('does not render a vertical streaming cursor', () => {
      const src = read('components/MessageWidget.tsx');
      const exceptions = read('styles/exceptions.css');
      expect(src).not.toMatch(/streaming-cursor/);
      expect(exceptions).not.toMatch(/\.streaming-cursor/);
    });

    it('keeps the chain footer visible while a chain is active', () => {
      expect(
        shouldRenderChainFooter({
          isActive: true,
          isTerminal: false,
          hasBody: false,
          hasUser: true,
        }),
      ).toBe(true);
      expect(
        shouldRenderChainFooter({
          isActive: false,
          isTerminal: false,
          hasBody: false,
          hasUser: false,
        }),
      ).toBe(false);

      const src = read('components/ChatStream.tsx');
      expect(src).not.toMatch(/if \(isActive && liveStreaming\) \{\s*continue;/);
      expect(src).not.toMatch(/if \(isLastTurn && liveStreaming\) return;/);
    });

    it('updates chain-footer agent usage from live stream events mid-turn', () => {
      const src = read('components/ChatStream.tsx');
      const builder = read('utils/stream-building.ts');
      // Active/last-chain footers prefer live usage over persisted chain sums
      // so CHAT_USAGE events paint the agent: line before the turn commits.
      expect(src).toMatch(/const historyUsage = status === 'streaming' \? null : usage/);
      expect(src).toMatch(/currentTurnUsage/);
      expect(src).toMatch(/usage:\s*status === 'streaming'\s*\?\s*currentTurnUsage/);
      expect(builder).toMatch(/isLastChain \? liveUsage \?\? chainUsage/);
      // Must not gate live usage on idle/error only (regression: mid-stream stuck).
      expect(src).not.toMatch(
        /status === 'idle' \|\| status === 'error' \|\| interrupted\)\s*\?\s*liveUsage/,
      );
    });
  });

  describe('component surface files exist', () => {
    for (const file of [
      'ChatStream.tsx',
      'MessageWidget.tsx',
      'ToolActivityGroup.tsx',
      'ToolCallBlock.tsx',
      'CollapsedChainStub.tsx',
      'ChainFooter.tsx',
      'ErrorBanner.tsx',
      'MarkdownContent.tsx',
      'ContextGrid.tsx',
      'ToolWidgets/LiveCommandInline.tsx',
    ]) {
      it(`${file} exists`, () => {
        expect(fs.existsSync(path.join(COMPONENTS, file))).toBe(true);
      });
    }
  });
});
