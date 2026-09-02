/**
 * Presentation configuration mirrored by ChatView: theme, personality list,
 * tool-group expansion, and the configured default model for new chats.
 *
 * The effective configuration snapshot stays App-owned; this hook mirrors it
 * and keeps it in sync with `orchid:config-updated` broadcasts.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ModelSelection } from '../../../shared/types/provider';
import { emitOrchidEvent, onOrchidEvent } from '../../utils/events';

export interface UseChatViewConfigOptions {
  readonly paletteOpen: boolean;
}

export interface UseChatViewConfigReturn {
  readonly currentTheme: string;
  readonly currentPersonality: string;
  readonly personalityNames: readonly string[];
  readonly alwaysExpandToolGroups: boolean;
  /** Configured default model for new chats / draft mode. */
  readonly defaultSelection: ModelSelection | null;
  readonly setDefaultSelection: (selection: ModelSelection | null) => void;
  readonly setCurrentTheme: (name: string) => void;
  readonly setCurrentPersonality: (name: string) => void;
  readonly setAlwaysExpandToolGroups: (expand: boolean) => void;
  /** Push a theme choice to the shell and every other window. */
  readonly applyTheme: (name: string) => Promise<void>;
  /** Persist a personality choice to user config and mirror it locally. */
  readonly applyPersonality: (name: string) => Promise<void>;
}

/** Own the shell's mirrored settings so the composer/palette read one source. */
export function useChatViewConfig({
  paletteOpen,
}: UseChatViewConfigOptions): UseChatViewConfigReturn {
  const [currentTheme, setCurrentTheme] = useState('default');
  const [currentPersonality, setCurrentPersonality] = useState('default');
  const [personalityNames, setPersonalityNames] = useState<string[]>([]);
  const [defaultSelection, setDefaultSelection] = useState<ModelSelection | null>(null);
  const [alwaysExpandToolGroups, setAlwaysExpandToolGroups] = useState(false);

  const loadPersonalityNames = useCallback(async (isCancelled: () => boolean) => {
    if (!window.orchid?.config?.listPersonalities) return;
    try {
      const names = await window.orchid.config.listPersonalities();
      if (!isCancelled()) setPersonalityNames(names);
    } catch { /* Non-fatal */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadPersonalityNames(() => cancelled);
    return () => { cancelled = true; };
  }, [loadPersonalityNames]);

  useEffect(() => {
    return onOrchidEvent('orchid:config-updated', (detail) => {
      if (detail && typeof detail.always_expand_tool_groups === 'boolean') {
        setAlwaysExpandToolGroups(detail.always_expand_tool_groups);
      }
      if (detail && 'default_model' in detail) {
        setDefaultSelection(detail.default_model as ModelSelection | null);
      }
    });
  }, []);

  // Refresh personality list when the palette opens.
  useEffect(() => {
    if (!paletteOpen) return;
    let cancelled = false;
    void loadPersonalityNames(() => cancelled);
    return () => { cancelled = true; };
  }, [paletteOpen, loadPersonalityNames]);

  const applyTheme = useCallback(async (name: string) => {
    setCurrentTheme(name);
    emitOrchidEvent('orchid:set-theme', { theme: name });
  }, []);

  const applyPersonality = useCallback(async (name: string) => {
    setCurrentPersonality(name);
    try {
      if (window.orchid?.config?.save) {
        await window.orchid.config.save({ updates: { personality: name } });
      }
    } catch {
      // Non-fatal
    }
  }, []);

  return {
    currentTheme,
    currentPersonality,
    personalityNames,
    alwaysExpandToolGroups,
    defaultSelection,
    setDefaultSelection,
    setCurrentTheme,
    setCurrentPersonality,
    setAlwaysExpandToolGroups,
    applyTheme,
    applyPersonality,
  };
}
