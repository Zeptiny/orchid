/**
 * ReasoningSelector — compact footer combo for reasoning effort.
 *
 * Picks from configured text levels or accepts free-text entry, where a bare
 * number is treated as a token budget. Clearing the input resets to the
 * connection default. Rendered by the footer only for reasoning-capable models.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { parseReasoningNumeric } from '../utils/reasoning';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import { TextInput } from './ui/TextInput';

export type ReasoningEffortValue = string | number | null;

interface ReasoningSelectorProps {
  /** Configured text levels for the active model. */
  levels: readonly string[];
  /** Session override (null = inherit the connection default). */
  value: ReasoningEffortValue;
  /** Connection/model default effort. */
  defaultValue: ReasoningEffortValue;
  onChange: (value: ReasoningEffortValue) => void;
  disabled?: boolean;
  className?: string;
  /** Controlled open state (defaults to uncontrolled). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Parse free-text entry: empty → null, valid digits → token budget, else text level. */
export function parseReasoningInput(raw: string): ReasoningEffortValue {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const num = parseReasoningNumeric(trimmed);
  if (num !== null) return num;
  if (/^\d+$/.test(trimmed)) return null;
  return trimmed;
}

/** Effective effort: session override wins, then the connection default. */
export function effectiveReasoningValue(
  override: ReasoningEffortValue,
  defaultValue: ReasoningEffortValue,
): ReasoningEffortValue {
  return override ?? defaultValue ?? null;
}

/** True when a session override is active (vs. inheriting the default). */
export function isReasoningOverridden(override: ReasoningEffortValue): boolean {
  return override != null;
}

/** Display string for an effort value. */
export function formatReasoningValue(value: ReasoningEffortValue): string {
  if (value == null) return 'Default';
  return typeof value === 'number' ? String(value) : value;
}

/** Commit free-text entry through the change callback. */
export function commitReasoningText(
  raw: string,
  onChange: (value: ReasoningEffortValue) => void,
): void {
  onChange(parseReasoningInput(raw));
}

/** The footer renders the selector only for reasoning-capable models. */
export function shouldShowReasoningSelector(
  config: { supportsReasoning: boolean } | null | undefined,
): boolean {
  return config?.supportsReasoning === true;
}

export function ReasoningSelector({
  levels,
  value,
  defaultValue,
  onChange,
  disabled = false,
  className = '',
  open: controlledOpen,
  onOpenChange,
}: ReasoningSelectorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const [text, setText] = useState('');
  const menuId = useId();

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!isOpen) return;
    const close = () => {
      if (!isControlled) setInternalOpen(false);
      onOpenChange?.(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, isControlled, onOpenChange]);

  const overridden = isReasoningOverridden(value);
  const effective = effectiveReasoningValue(value, defaultValue);

  const selectLevel = (level: string) => {
    onChange(level);
    setOpen(false);
  };

  const commitText = () => {
    commitReasoningText(text, onChange);
    setText('');
    setOpen(false);
  };

  const reset = () => {
    onChange(null);
    setText('');
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`relative shrink-0 ${className}`.trim()}>
      <Button
        variant="ghost"
        size="xs"
        className="orchid-reasoning-trigger gap-1"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-label="Reasoning effort"
        title={`Reasoning effort: ${formatReasoningValue(effective)}${overridden ? ' (session override)' : ''}`}
        disabled={disabled}
        onClick={() => setOpen(!isOpen)}
      >
        <Icon name="zap" size={12} className="shrink-0 opacity-70" />
        <span>
          {formatReasoningValue(effective)}
        </span>
        <Icon
          name="chevronDown"
          size={12}
          className={`shrink-0 opacity-60 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </Button>

      {isOpen && (
        <div
          id={menuId}
          role="dialog"
          aria-label="Reasoning effort"
          className="absolute bottom-full right-0 z-50 mb-1 flex w-56 flex-col gap-1 rounded-box border border-base-300 bg-base-200 p-1.5 shadow-lg"
        >
          <div className="px-1 pb-0.5 text-xs font-medium text-base-content/60">
            Reasoning effort
          </div>
          {levels.map((level) => {
            const selected = value === level;
            return (
              <Button
                key={level}
                variant={selected ? 'primary' : 'ghost'}
                size="xs"
                className="w-full justify-start"
                aria-pressed={selected}
                onClick={() => selectLevel(level)}
              >
                {level}
              </Button>
            );
          })}
          <TextInput
            size="xs"
            className="w-full min-w-0"
            type="text"
            value={text}
            placeholder="Level or token budget"
            aria-label="Reasoning effort level or token budget"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitText();
              }
            }}
            onBlur={() => {
              if (text.trim() !== '') commitText();
            }}
          />
          <Button
            variant="ghost"
            size="xs"
            className="w-full justify-start"
            disabled={!overridden}
            onClick={reset}
          >
            Reset to default
          </Button>
        </div>
      )}
    </div>
  );
}
