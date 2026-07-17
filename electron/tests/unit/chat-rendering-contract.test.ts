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
  shouldAutoScroll,
} from '../../src/renderer/components/ChatStream';

const RENDERER = path.resolve(__dirname, '../../src/renderer');
const COMPONENTS = path.join(RENDERER, 'components');

function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER, rel), 'utf8');
}

describe('chat rendering contract (U5)', () => {
  describe('flat chat presentation', () => {
    it('MessageWidget keeps flat msg classes and never uses DaisyUI chat shells', () => {
      const src = read('components/MessageWidget.tsx');
      expect(src).toMatch(/msg-user/);
      expect(src).toMatch(/msg-assistant/);
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
      expect(tool).toMatch(/loading loading-spinner/);
      expect(thought).toMatch(/loading loading-spinner|streaming-cursor/);
      expect(error).toMatch(/alert/);
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
      // Must not reset isUserScrolledUp when entering streaming
      expect(src).not.toMatch(/setIsUserScrolledUp\(false\)/);
      // New stream start still respects shouldAutoScroll
      expect(src).toMatch(/shouldAutoScroll\(isUserScrolledUp\)/);
    });
  });

  describe('stream defect fixes', () => {
    it('send failure cleanup removes optimistic bubble on throw', () => {
      const src = read('hooks/useChat.ts');
      expect(src).toMatch(/Drop the optimistic user bubble when send never started/);
      // Both structured error and catch paths
      const throwCleanup =
        src.includes('catch (err)') &&
        src.includes('last.id === userMessage.id') &&
        src.includes('prev.slice(0, -1)');
      expect(throwCleanup).toBe(true);
    });

    it('null live snapshot drains buffered hydration events', () => {
      const src = read('hooks/useChat.ts');
      expect(src).toMatch(/if \(!live\)/);
      expect(src).toMatch(/buffered target-session events|hydration\.events/);
    });

    it('streaming cursor remains on assistant and thought paths', () => {
      const src = read('components/MessageWidget.tsx');
      expect(src).toMatch(/streaming-cursor/);
      const exceptions = read('styles/exceptions.css');
      expect(exceptions).toMatch(/\.streaming-cursor/);
      expect(exceptions).toMatch(/@keyframes blink/);
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
