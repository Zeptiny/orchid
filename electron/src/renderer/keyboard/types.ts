/**
 * Shared keyboard shortcut types for the Electron renderer.
 */

export type ShortcutGroup =
  | 'global'
  | 'sessions'
  | 'layout'
  | 'composer'
  | 'config'
  | 'palette';

/** A single key chord, e.g. Mod+K or Escape. */
export interface KeyChord {
  /** Letter/digit/symbol or named key: "k", "1", "/", "\\", ",", "Escape", "Enter". */
  key: string;
  /** Primary accelerator: Ctrl on Linux/Win, Meta on macOS; matchers accept either. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutDef {
  id: string;
  /** Primary chord (and only chord unless `aliases` set). */
  chord: KeyChord;
  /** Optional alternate chords (same action). */
  aliases?: KeyChord[];
  label: string;
  /** Short footer-friendly action word, e.g. "commands". */
  footerLabel?: string;
  group: ShortcutGroup;
  /**
   * When true, fires even if focus is in input/textarea/contenteditable.
   * Default false for bare keys; global Mod chords should set true.
   */
  allowInEditable?: boolean;
  /** Shown in Shortcuts help. Default true. */
  showInHelp?: boolean;
}
