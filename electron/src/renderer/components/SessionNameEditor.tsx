import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

interface SessionNameEditorProps {
  name: string;
  className?: string;
  title?: string;
  onRename: (nextName: string) => void | Promise<void>;
  /** Single-click / Enter / Space: select the session without renaming. */
  onSelect?: () => void;
  /** Optional: run when edit begins (e.g. ensure session is selected). */
  onBeginEdit?: () => void;
}

/**
 * Displays a session name; double-click or F2 enters inline rename.
 * Enter commits, Escape cancels, blur commits when non-empty.
 */
export function SessionNameEditor({
  name,
  className,
  title,
  onRename,
  onSelect,
  onBeginEdit,
}: SessionNameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  const commit = async () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed || trimmed === name) {
      setDraft(name);
      return;
    }
    await onRename(trimmed);
  };

  const cancel = () => {
    setDraft(name);
    setEditing(false);
  };

  const beginEdit = () => {
    onBeginEdit?.();
    setDraft(name);
    setEditing(true);
  };

  const startEditFromPointer = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    beginEdit();
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`session-name-editor-input ${className ?? ''}`}
        value={draft}
        aria-label="Rename session"
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          void commit();
        }}
      />
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className={`session-name-editor-label ${className ?? ''}`}
      title={title ?? `${name} (double-click or F2 to rename)`}
      onClick={(e) => {
        // Let parent row/tab handle select; optional onSelect for nested cases.
        if (onSelect) {
          e.stopPropagation();
          onSelect();
        }
      }}
      onDoubleClick={startEditFromPointer}
      onKeyDown={(e: ReactKeyboardEvent<HTMLSpanElement>) => {
        if (e.key === 'F2') {
          e.preventDefault();
          e.stopPropagation();
          beginEdit();
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onSelect?.();
        }
      }}
    >
      {name}
    </span>
  );
}
