/**
 * TierPicker — model-picker style dropdown for agent tiers with short descriptions.
 */
import {
  AgentTier,
  TIER_DESCRIPTIONS,
} from '../../../shared/types/agent';
import { PopoverList, type PopoverListOption } from '../ui/PopoverList';

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

const TIER_OPTIONS: readonly PopoverListOption<AgentTier>[] = TIER_ORDER.map((tier) => ({
  value: tier,
  label: tier,
  description: TIER_SHORT[tier],
}));

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
  return (
    <PopoverList<AgentTier>
      value={value}
      options={TIER_OPTIONS}
      onChange={onChange}
      label="Select agent tier"
      title="Model tier"
      searchPlaceholder="Search tiers…"
      emptyMessage="No tiers available"
      disabled={disabled}
      className={className}
      menuClassName="tier-picker-menu searchable-picker-menu"
      triggerIcon="layers"
      align="start"
      renderTriggerLabel={(selected, current) => (
        <>
          <span className="font-medium">{selected?.label ?? current}</span>
          {selected?.description && (
            <span className="opacity-60 font-normal"> · {selected.description}</span>
          )}
        </>
      )}
      filterOption={(option, query) => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return true;
        const full = TIER_DESCRIPTIONS[option.value] ?? '';
        return `${option.label} ${option.description ?? ''} ${full}`
          .toLowerCase()
          .includes(normalized);
      }}
    />
  );
}
