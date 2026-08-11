/**
 * ServiceTierSelector — compact footer combo for the per-session service tier
 * override (R21). Mirrors ReasoningSelector: the session override wins over
 * the connection's per-model selection, and clearing returns to it. Rendered
 * only when the active model's driver declares a tier mechanism.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { SessionServiceTierConfigResult } from '../../shared/types/ipc';
import { Icon } from './Icon';
import { Button } from './ui/Button';

interface ServiceTierSelectorProps {
  readonly config: SessionServiceTierConfigResult;
  readonly onChange: (tier: string | null) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

/** The footer renders the selector only when the driver declares tiers. */
export function shouldShowServiceTierSelector(
  config: Pick<SessionServiceTierConfigResult, 'mechanism' | 'tiers'> | null | undefined,
): boolean {
  return config?.mechanism != null && config.tiers.length > 0;
}

function tierLabel(config: SessionServiceTierConfigResult, tierId: string | null): string {
  if (!tierId) return 'Standard';
  return config.tiers.find((tier) => tier.id === tierId)?.displayName ?? tierId;
}

export function ServiceTierSelector({
  config,
  onChange,
  disabled = false,
  className = '',
}: ServiceTierSelectorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
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
  }, [open]);

  const overridden = config.override != null;
  const effective = config.effective;

  const choose = (tier: string | null) => {
    onChange(tier);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`relative shrink-0 ${className}`.trim()}>
      <Button
        variant="ghost"
        size="xs"
        className="gap-1"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Service tier"
        title={`Service tier: ${tierLabel(config, effective)}${overridden ? ' (session override)' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="layers" size={12} className="shrink-0 opacity-70" />
        <span>{tierLabel(config, effective)}</span>
        <Icon
          name="chevronDown"
          size={12}
          className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </Button>

      {open && (
        <div
          id={menuId}
          role="dialog"
          aria-label="Service tier"
          className="orchid-popover-enter absolute bottom-full right-0 z-50 mb-1 flex w-52 flex-col gap-1 rounded-box border border-base-300 bg-base-200 p-1.5 shadow-lg"
        >
          <div className="px-1 pb-0.5 text-xs font-medium text-base-content/60">
            Service tier
          </div>
          <Button
            variant={effective == null ? 'primary' : 'ghost'}
            size="xs"
            className="w-full justify-start"
            aria-pressed={effective == null}
            onClick={() => choose(null)}
          >
            Standard
          </Button>
          {config.tiers.map((tier) => {
            const selected = effective === tier.id;
            return (
              <Button
                key={tier.id}
                variant={selected ? 'primary' : 'ghost'}
                size="xs"
                className="w-full justify-start"
                aria-pressed={selected}
                title={tier.description ?? undefined}
                onClick={() => choose(tier.id)}
              >
                {tier.displayName ?? tier.id}
              </Button>
            );
          })}
          {overridden && (
            <Button
              variant="ghost"
              size="xs"
              className="w-full justify-start"
              onClick={() => choose(null)}
            >
              Reset to connection selection
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
