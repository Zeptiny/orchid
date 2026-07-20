/**
 * Chat rendering contract — U5 flat chat + stream safety.
 *
 * Source-level contracts for flat message presentation (no DaisyUI chat bubbles),
 * history/live-tail memoization, auto-scroll threshold, and stream defect fixes.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AUTO_SCROLL_THRESHOLD_PX,
  isUserScrolledAwayFromBottom,
  shouldRenderChainFooter,
  shouldAutoScroll,
} from '../../src/renderer/components/ChatStream';
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

    it('activity widgets use DaisyUI surrounding states (badge/loading/alert)', () => {
      const tool = read('components/ToolCallBlock.tsx');
      const thought = read('components/MessageWidget.tsx');
      const error = read('components/ErrorBanner.tsx');
      expect(tool).toMatch(/StatusBadge|badge/);
      // Migrated to Spinner primitive — source uses <Spinner> instead of raw loading classes
      expect(tool).toMatch(/<Spinner\b/);
      expect(thought).toMatch(/<Spinner\b|streaming-cursor/);
      // Migrated to Alert primitive — source uses <Alert> instead of raw alert classes
      expect(error).toMatch(/<Alert\b/);
      // Guard against raw class regression
      expect(tool).not.toMatch(/loading loading-spinner/);
      expect(error).not.toMatch(/className=.*alert\b/);
    });

    it('thinking content collapses when clicked', () => {
      const src = read('components/MessageWidget.tsx');
      const contentStart = src.indexOf('className="orchid-thought-content"');
      const contentSource = src.slice(contentStart, contentStart + 500);

      expect(contentStart).toBeGreaterThanOrEqual(0);
      expect(contentSource).toContain('onClick={collapse}');
      expect(contentSource).toContain('role="button"');
      expect(contentSource).toContain('title="Click to collapse"');
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
      expect(scrollHook).toMatch(/setIsUserScrolledUp\(false\)/);
      expect(scrollHook).toMatch(/enabled, resetKey/);
      expect(src).not.toMatch(
        /status === 'streaming'[\s\S]{0,200}setIsUserScrolledUp\(false\)/,
      );
      // New stream start still respects shouldAutoScroll
      expect(src).toMatch(/shouldAutoScroll\(isUserScrolledUp\)/);
    });

    it('binds the scroll listener to a late-mounted container', () => {
      const scrollHook = read('hooks/useSmartAutoScroll.ts');
      expect(scrollHook).toMatch(/const \[container, setContainer\]/);
      expect(scrollHook).toMatch(/const containerRef = useCallback/);
      expect(scrollHook).toMatch(/\[container, enabled\]/);
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
  });

  describe('stream defect fixes', () => {
    it('send failure cleanup removes optimistic bubble on throw', () => {
      const src = read('hooks/useChat.ts');
      expect(src).toMatch(/Drop the optimistic user bubble when send never started/);
      // Shared residual helper + drop helper on both structured error and catch paths
      expect(src).toMatch(/residualStateAfterSendFailure/);
      expect(src).toMatch(/dropOptimisticUserMessageIfLast/);
      const sendStart = src.indexOf('const send = useCallback');
      const sendEnd = src.indexOf('const cancel = useCallback', sendStart);
      const sendSource = src.slice(sendStart, sendEnd);
      expect(sendSource).toMatch(/result\.status === 'error'/);
      expect(sendSource).toMatch(/catch \(err\)/);
      // Both branches call the same residual + drop helpers
      const residualHits = sendSource.match(/residualStateAfterSendFailure\(\)/g) ?? [];
      const dropHits = sendSource.match(/dropOptimisticUserMessageIfLast/g) ?? [];
      expect(residualHits.length).toBeGreaterThanOrEqual(2);
      expect(dropHits.length).toBeGreaterThanOrEqual(2);
    });

    it('null live snapshot drains buffered events through sequence affinity', () => {
      const src = read('hooks/useChat.ts');
      expect(src).toMatch(/if \(!live\)/);
      expect(src).toMatch(/drainBufferedHydrationEvents|replayHydrationBuffer/);
      expect(src).toMatch(/BufferedHydrationEvent/);
      // Structured error path clears residual stream state like the throw path
      expect(src).toMatch(/result\.status === 'error'/);
      const errorBranch = src.slice(
        src.indexOf("if (result.status === 'error')"),
        src.indexOf('// Only adopt send resolution'),
      );
      expect(errorBranch).toMatch(/applyStreamSegments\(\[\]\)/);
      expect(errorBranch).toMatch(/residualStateAfterSendFailure/);
      expect(errorBranch).toMatch(/setStreamingContent\(residual\.streamingContent\)/);
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
