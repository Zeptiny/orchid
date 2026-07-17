/**
 * Composer / discovery contract — U6.
 *
 * Wiring + DaisyUI source contracts. Behavioral lock/navigate/popover
 * coverage lives in composer-send-lock, navigate-shell, and popover-listbox tests.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  evaluateComposerSend,
  shouldReleaseComposerSendLock,
} from '../../src/renderer/utils/composer-send-lock';
import {
  nextForceOpenEpoch,
  resolveOrchidNavigate,
  shouldOpenCollapseFromToken,
} from '../../src/renderer/utils/navigate-shell';

const RENDERER = path.resolve(__dirname, '../../src/renderer');

function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER, rel), 'utf8');
}

describe('composer contract (U6)', () => {
  describe('send lock recovery', () => {
    it('InputArea wires pure lock release and send admission helpers', () => {
      const src = read('components/InputArea.tsx');
      expect(src).toMatch(/shouldReleaseComposerSendLock/);
      expect(src).toMatch(/evaluateComposerSend/);
      expect(src).toMatch(/catch \{[\s\S]*isSendingRef\.current = false/);
      // Behavioral: error status releases lock so second send is admitted.
      expect(shouldReleaseComposerSendLock('error', 'idle')).toBe(true);
      expect(
        evaluateComposerSend({
          trimmed: 'retry',
          isStreaming: false,
          isSending: false,
          workspaceBound: true,
          providerAvailable: true,
          modelSelected: true,
        }).action,
      ).toBe('send');
    });

    it('useChat releases send lock on structured error and throw paths', () => {
      const src = read('hooks/useChat.ts');
      const sendStart = src.indexOf('const send = useCallback');
      const sendEnd = src.indexOf('const cancel = useCallback', sendStart);
      const sendSource = src.slice(sendStart, sendEnd);
      expect(sendSource).toMatch(/result\.status === 'error'/);
      // Shared residual helper sets isSending: false on both failure paths.
      expect(sendSource).toMatch(/residualStateAfterSendFailure/);
      expect(sendSource).toMatch(/isSendingRef\.current = residual\.isSending/);
      expect(sendSource).toMatch(/catch \(err\)/);
    });
  });

  describe('cancel serialization', () => {
    it('useChat serializes cancel and stages a second Esc while IPC is in flight', () => {
      const src = read('hooks/useChat.ts');
      expect(src).toMatch(/cancelQueueRef/);
      expect(src).toMatch(/beginCancelRequest/);
      expect(src).toMatch(/consumePendingCancel/);
      const cancelStart = src.indexOf('const cancel = useCallback');
      const cancelEnd = src.indexOf('const stop = useCallback', cancelStart);
      const cancelSource = src.slice(cancelStart, cancelEnd);
      expect(cancelSource).toMatch(/beginCancelRequest\(cancelQueueRef\.current\) === 'queued'/);
      expect(cancelSource).toMatch(/consumePendingCancel\(cancelQueueRef\.current\)/);
    });
  });

  describe('command palette navigation', () => {
    it('dispatches orchid:navigate and ChatView listens via resolveOrchidNavigate', () => {
      const palette = read('components/CommandPalette.tsx');
      const chatView = read('components/ChatView.tsx');
      const sidebar = read('components/Sidebar.tsx');
      expect(palette).toMatch(/orchid:navigate/);
      expect(palette).toMatch(/action === 'navigation'/);
      expect(chatView).toMatch(/addEventListener\('orchid:navigate'/);
      expect(chatView).toMatch(/resolveOrchidNavigate/);
      expect(sidebar).toMatch(/resolveInspectorSectionId|nextForceOpenEpoch/);
      expect(sidebar).toMatch(/forceOpenToken/);
      // Behavioral end-to-end contract on pure helpers.
      expect(resolveOrchidNavigate('subagents')).toEqual({
        kind: 'inspector',
        section: 'subagents',
      });
      expect(resolveOrchidNavigate('sessions')).toEqual({ kind: 'sessions' });
    });

    it('re-opens inspector section on same-section palette re-nav after collapse', () => {
      const sidebar = read('components/Sidebar.tsx');
      expect(sidebar).toMatch(/forceOpenEpoch|setForceOpenEpoch/);
      expect(sidebar).toMatch(/forceOpenToken/);
      expect(sidebar).toMatch(/shouldOpenCollapseFromToken|nextForceOpenEpoch/);
      // Epoch bumps on every focusSection so identical section re-nav re-triggers open.
      let epoch = 0;
      epoch = nextForceOpenEpoch(epoch);
      epoch = nextForceOpenEpoch(epoch);
      expect(shouldOpenCollapseFromToken(epoch)).toBe(true);
      expect(shouldOpenCollapseFromToken(0)).toBe(false);
    });

    it('guards command palette handleSelect against overlapping async selections', () => {
      const palette = read('components/CommandPalette.tsx');
      expect(palette).toMatch(/selectingRef/);
      const selectStart = palette.indexOf('const handleSelect = useCallback');
      const selectEnd = palette.indexOf('const handleKeyDown = useCallback', selectStart);
      const selectSource = palette.slice(selectStart, selectEnd);
      expect(selectSource).toMatch(/if \(selectingRef\.current\) return/);
      expect(selectSource).toMatch(/selectingRef\.current = true/);
      expect(selectSource).toMatch(/finally \{[\s\S]*selectingRef\.current = false/);
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
      expect(src).toMatch(/Spinner/);
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

    it('ModelPicker shares PopoverList listbox geometry via usePopoverListbox', () => {
      const modelPicker = read('components/ModelPicker.tsx');
      const popoverList = read('components/ui/PopoverList.tsx');
      const hook = read('components/ui/usePopoverListbox.ts');
      const logic = read('components/ui/popover-listbox-logic.ts');
      expect(modelPicker).toMatch(/usePopoverListbox/);
      expect(modelPicker).toMatch(/model-picker-table/);
      expect(popoverList).toMatch(/usePopoverListbox/);
      expect(popoverList).toMatch(/filterPopoverOptions|canSelectPopoverOption/);
      expect(hook).toMatch(/closeAndRestoreFocus/);
      expect(hook).toMatch(/applyPopoverListboxKey/);
      expect(logic).toMatch(/applyPopoverListboxKey/);
      expect(logic).toMatch(/isOutsidePopoverRoot/);
    });
  });
});
