import { useEffect, useId, useRef, useState } from 'react';
import type { PermissionMode } from '../../shared/types/permission';
import { Icon } from './Icon';
import { Button } from './ui/Button';

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'allow',
  'ask',
  'decide-for-me',
  'ask-when-flagged',
];

const MODE_LABELS: Record<PermissionMode, string> = {
  allow: 'Allow all',
  ask: 'Always ask',
  'decide-for-me': 'Decide for me',
  'ask-when-flagged': 'Ask when flagged',
};

const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  allow: 'Execute everything without asking',
  ask: 'Approve every tool call',
  'decide-for-me': 'AI evaluates safety',
  'ask-when-flagged': 'Prompt only for dangerous calls',
};

export function formatPermissionMode(mode: PermissionMode | null): string {
  if (mode == null) return 'Default';
  return MODE_LABELS[mode];
}

interface PermissionSelectorProps {
  value: PermissionMode | null;
  defaultValue: PermissionMode;
  onChange: (value: PermissionMode | null) => void;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function PermissionSelector({
  value,
  defaultValue,
  onChange,
  className = '',
  open: controlledOpen,
  onOpenChange,
}: PermissionSelectorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
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

  const overridden = value != null;
  const effective = value ?? defaultValue;

  const selectMode = (mode: PermissionMode) => {
    onChange(mode);
    setOpen(false);
  };

  const reset = () => {
    onChange(null);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`relative shrink-0 ${className}`.trim()}>
      <Button
        variant="ghost"
        size="xs"
        className="orchid-permission-trigger gap-1"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-label="Session permissions"
        title={`Session permissions: ${formatPermissionMode(effective)}${overridden ? ' (session override)' : ' (inherited)'}`}
        onClick={() => setOpen(!isOpen)}
      >
        <Icon name="shield" size={12} className="shrink-0 opacity-70" />
        <span className="inline-flex items-center gap-1">
          {formatPermissionMode(effective)}
          {!overridden && (
            <>
              <span className="size-1 rounded-full bg-base-content/40" aria-hidden />
              <span className="sr-only">(inherited)</span>
            </>
          )}
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
          aria-label="Session permissions"
          className="absolute bottom-full right-0 z-50 mb-1 flex w-60 flex-col gap-1 rounded-box border border-base-300 bg-base-200 p-1.5 shadow-lg"
        >
          <div className="px-1 pb-0.5 text-xs font-medium text-base-content/60">
            Session permissions
          </div>
          {PERMISSION_MODES.map((mode) => {
            const selected = value === mode;
            return (
              <Button
                key={mode}
                variant={selected ? 'primary' : 'ghost'}
                size="xs"
                className="h-auto w-full flex-col items-start gap-0.5 py-1.5"
                aria-pressed={selected}
                onClick={() => selectMode(mode)}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-semibold">{MODE_LABELS[mode]}</span>
                  {mode === defaultValue && <span className="opacity-60">(default)</span>}
                </span>
                <span className="text-left opacity-70">{MODE_DESCRIPTIONS[mode]}</span>
              </Button>
            );
          })}
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
