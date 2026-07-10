/**
 * TierPicker — model-picker style dropdown for agent tiers with short descriptions.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  AgentTier,
  TIER_DESCRIPTIONS,
} from '../../../shared/types/agent';
import { Icon } from '../Icon';

const TIER_ORDER: AgentTier[] = [
  AgentTier.SEED,
  AgentTier.SPROUT,
  AgentTier.BLOOM,
  AgentTier.CROWN,
];

/** Compact one-line summaries for the list (full text remains in TIER_DESCRIPTIONS). */
export const TIER_SHORT: Record<AgentTier, string> = {
  [AgentTier.SEED]: 'Fast, simple mechanical tasks',
  [AgentTier.SPROUT]: 'Light reasoning & exploration',
  [AgentTier.BLOOM]: 'Standard implementation work',
  [AgentTier.CROWN]: 'Deep reasoning, review & design',
};

export interface TierPickerProps {
  value: AgentTier;
  onChange: (tier: AgentTier) => void;
  disabled?: boolean;
  className?: string;
}

export function TierPicker({
  value,
  onChange,
  disabled = false,
  className = '',
}: TierPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div
      ref={ref}
      className={`dropdown dropdown-start w-full ${open ? 'dropdown-open' : ''} ${className}`.trim()}
    >
      <button
        type="button"
        className="btn btn-ghost model-picker-trigger w-full"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Select agent tier"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="layers" size={13} className="shrink-0 opacity-70" />
        <span className="model-picker-trigger-label">
          <span className="font-medium">{value}</span>
          <span className="opacity-60 font-normal"> · {TIER_SHORT[value]}</span>
        </span>
        <Icon
          name="chevronDown"
          size={12}
          className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label="Agent tiers"
          className="dropdown-content tier-picker-menu z-50"
        >
          <div className="tier-picker-heading">
            <div className="model-picker-title">Model tier</div>
            <span className="model-picker-current">{value}</span>
          </div>
          <ul className="tier-picker-list">
            {TIER_ORDER.map((tier) => {
              const selected = tier === value;
              return (
                <li key={tier}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`tier-picker-option ${selected ? 'is-selected' : ''}`}
                    title={TIER_DESCRIPTIONS[tier]}
                    onClick={() => {
                      onChange(tier);
                      setOpen(false);
                    }}
                  >
                    <div className="tier-picker-option-name">{tier}</div>
                    <div className="tier-picker-option-desc">{TIER_SHORT[tier]}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
