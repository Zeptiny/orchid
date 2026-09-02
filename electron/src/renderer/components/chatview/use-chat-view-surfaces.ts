/**
 * Transient ChatView surface state: overlay visibility, the inspector focus
 * request, which center pane is showing, and the running-tab close confirm.
 *
 * Setters are returned unwrapped so callers keep the exact state transitions
 * they owned before the extraction (overlay toggles stay mutually exclusive).
 */
import { useCallback, useRef, useState } from 'react';
import { emitOrchidEvent } from '../../utils/events';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { SubagentOpenRequest } from '../SubagentView';

export interface UseChatViewSurfacesReturn {
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  helpOpen: boolean;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  /** One-shot inspector section focus from command-palette navigation. */
  inspectorFocusSection: string | null;
  setInspectorFocusSection: Dispatch<SetStateAction<string | null>>;
  /** Session id awaiting a "close running tab?" confirmation. */
  closeConfirmId: string | null;
  setCloseConfirmId: Dispatch<SetStateAction<string | null>>;
  closeConfirmRef: RefObject<HTMLDivElement | null>;
  closeConfirmCancelRef: RefObject<HTMLButtonElement | null>;
  draftTabVisible: boolean;
  setDraftTabVisible: Dispatch<SetStateAction<boolean>>;
  /** Remount key for the composer draft. */
  composerDraftKey: number;
  setComposerDraftKey: Dispatch<SetStateAction<number>>;
  /** A palette, the shortcut sheet, or a close confirmation owns the keyboard. */
  overlayOwnsKeyboard: boolean;
  contentMode: 'chat' | 'subagents';
  setContentMode: Dispatch<SetStateAction<'chat' | 'subagents'>>;
  projectConfigDir: string | null;
  setProjectConfigDir: Dispatch<SetStateAction<string | null>>;
  subagentOpenRequest: SubagentOpenRequest;
  openSubagentView: (id?: string) => void;
  togglePalette: () => void;
  toggleHelp: () => void;
  closePalette: () => void;
  closeHelp: () => void;
  /** Back out of the running-tab close confirmation without closing. */
  declineCloseConfirm: () => void;
  /** Drop a consumed inspector focus request. */
  clearInspectorFocusSection: () => void;
  openSettings: () => void;
  openAnalytics: () => void;
  openProviderSettings: () => void;
}

/** Own the shell's view state so ChatView only wires it to the surfaces. */
export function useChatViewSurfaces(): UseChatViewSurfacesReturn {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorFocusSection, setInspectorFocusSection] = useState<string | null>(null);
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  const closeConfirmRef = useRef<HTMLDivElement>(null);
  const closeConfirmCancelRef = useRef<HTMLButtonElement>(null);
  const [draftTabVisible, setDraftTabVisible] = useState(false);
  const [composerDraftKey, setComposerDraftKey] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [contentMode, setContentMode] = useState<'chat' | 'subagents'>('chat');
  const [projectConfigDir, setProjectConfigDir] = useState<string | null>(null);
  const [subagentOpenRequest, setSubagentOpenRequest] = useState<SubagentOpenRequest>({
    generation: 0,
    id: null,
  });

  const openSubagentView = useCallback((id?: string) => {
    setSubagentOpenRequest((previous) => ({ generation: previous.generation + 1, id: id ?? null }));
    setContentMode('subagents');
  }, []);

  const togglePalette = useCallback(() => {
    setHelpOpen(false);
    setPaletteOpen((prev) => !prev);
  }, []);

  const toggleHelp = useCallback(() => {
    setPaletteOpen(false);
    setHelpOpen((prev) => !prev);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
  }, []);

  const declineCloseConfirm = useCallback(() => {
    setCloseConfirmId(null);
  }, []);

  const clearInspectorFocusSection = useCallback(() => {
    setInspectorFocusSection(null);
  }, []);

  const openSettings = useCallback(() => {
    emitOrchidEvent('orchid:open-settings');
  }, []);

  const openAnalytics = useCallback(() => {
    emitOrchidEvent('orchid:open-analytics');
  }, []);

  const openProviderSettings = useCallback(() => {
    emitOrchidEvent('orchid:open-settings', { tab: 'providers' });
  }, []);

  return {
    paletteOpen,
    setPaletteOpen,
    helpOpen,
    setHelpOpen,
    inspectorFocusSection,
    setInspectorFocusSection,
    closeConfirmId,
    setCloseConfirmId,
    closeConfirmRef,
    closeConfirmCancelRef,
    draftTabVisible,
    setDraftTabVisible,
    composerDraftKey,
    setComposerDraftKey,
    overlayOwnsKeyboard: paletteOpen || helpOpen || closeConfirmId !== null,
    contentMode,
    setContentMode,
    projectConfigDir,
    setProjectConfigDir,
    subagentOpenRequest,
    openSubagentView,
    togglePalette,
    toggleHelp,
    closePalette,
    closeHelp,
    declineCloseConfirm,
    clearInspectorFocusSection,
    openSettings,
    openAnalytics,
    openProviderSettings,
  };
}
