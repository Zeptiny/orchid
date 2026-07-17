/**
 * Composer / discovery contract — U6.
 *
 * Source-level contracts for send-lock recovery, cancel serialization,
 * command-palette navigation wiring, and DaisyUI control usage.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RENDERER = path.resolve(__dirname, '../../src/renderer');

function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER, rel), 'utf8');
}

describe('composer contract (U6)', () => {
  describe('send lock recovery', () => {
    it('InputArea releases send lock on non-streaming status and catch path', () => {
      const src = read('components/InputArea.tsx');
      // Early gates return before isSendingRef is set
      expect(src).toMatch(/if \(!workspaceBound && !trimmed\.startsWith\('\/'\)\)/);
      expect(src).toMatch(/if \(!providerAvailable && !trimmed\.startsWith\('\/'\)\)/);
      expect(src).toMatch(/if \(!modelSelected && !trimmed\.startsWith\('\/'\)\)/);
      // Catch releases lock
      expect(src).toMatch(/catch \{[\s\S]*isSendingRef\.current = false/);
      // Status effect clears lock when not streaming
      expect(src).toMatch(/status !== 'streaming'/);
      expect(src).toMatch(/isSendingRef\.current = false/);
    });

    it('useChat releases send lock on structured error and throw paths', () => {
      const src = read('hooks/useChat.ts');
      const sendStart = src.indexOf('const send = useCallback');
      const sendEnd = src.indexOf('const cancel = useCallback', sendStart);
      const sendSource = src.slice(sendStart, sendEnd);
      expect(sendSource).toMatch(/result\.status === 'error'/);
      expect(sendSource).toMatch(/isSendingRef\.current = false/);
      expect(sendSource).toMatch(/catch \(err\)/);
    });
  });

  describe('cancel serialization', () => {
    it('useChat serializes cancel so repeated Escape cannot overlap phases', () => {
      const src = read('hooks/useChat.ts');
      expect(src).toMatch(/cancelInFlightRef/);
      const cancelStart = src.indexOf('const cancel = useCallback');
      const cancelEnd = src.indexOf('const stop = useCallback', cancelStart);
      const cancelSource = src.slice(cancelStart, cancelEnd);
      expect(cancelSource).toMatch(/if \(cancelInFlightRef\.current\) return/);
      expect(cancelSource).toMatch(/cancelInFlightRef\.current = true/);
      expect(cancelSource).toMatch(/finally \{[\s\S]*cancelInFlightRef\.current = false/);
    });
  });

  describe('command palette navigation', () => {
    it('dispatches orchid:navigate and ChatView listens', () => {
      const palette = read('components/CommandPalette.tsx');
      const chatView = read('components/ChatView.tsx');
      const sidebar = read('components/Sidebar.tsx');
      expect(palette).toMatch(/orchid:navigate/);
      expect(palette).toMatch(/action === 'navigation'/);
      expect(chatView).toMatch(/addEventListener\('orchid:navigate'/);
      expect(chatView).toMatch(/setInspectorFocusSection|inspectorFocusSection/);
      expect(sidebar).toMatch(/focusSection/);
      expect(sidebar).toMatch(/NAV_SECTION_MAP|inspector-subagents/);
    });
  });

  describe('DaisyUI controls', () => {
    it('composer uses textarea/btn primitives and IconButton', () => {
      const src = read('components/InputArea.tsx');
      expect(src).toMatch(/textarea textarea-bordered|className=.*textarea/);
      expect(src).toMatch(/IconButton/);
      expect(src).toMatch(/Enter to send/);
      expect(src).toMatch(/Shift\+Enter/);
    });

    it('footer uses radial-progress and loading spinner', () => {
      const src = read('components/Footer.tsx');
      expect(src).toMatch(/radial-progress/);
      expect(src).toMatch(/loading loading-spinner|loading-spinner/);
      expect(src).toMatch(/Keycaps/);
    });

    it('command palette avoids arbitrary Tailwind values for layout chrome', () => {
      const src = read('components/CommandPalette.tsx');
      expect(src).not.toMatch(/z-\[1000\]/);
      expect(src).not.toMatch(/rounded-\[10px\]/);
      expect(src).not.toMatch(/gap-\[1px\]/);
      expect(src).not.toMatch(/text-\[9px\]/);
      expect(src).not.toMatch(/text-\[12px\]/);
      expect(src).not.toMatch(/min-h-\[30px\]/);
      // Dynamic theme swatches remain as style exceptions
      expect(src).toMatch(/THEME_SWATCHES/);
      expect(src).toMatch(/style=\{\{ background:/);
    });

    it('textarea auto-resize remains a runtime height exception', () => {
      const input = read('components/InputArea.tsx');
      const exceptions = read('styles/exceptions.css');
      expect(input).toMatch(/TEXTAREA_MIN_HEIGHT_PX/);
      expect(input).toMatch(/scrollHeight/);
      expect(exceptions).toMatch(/composer-textarea|orchid-composer-textarea/);
      expect(exceptions).toMatch(/max-height:\s*160px/);
    });
  });
});
