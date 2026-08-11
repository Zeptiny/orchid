import { createDraftOverrideStore } from './draft-override-store';

export const {
  set: setDraftTierOverride,
  get: getDraftTierOverride,
  clear: clearDraftTierOverrides,
  take: takeDraftTierOverride,
} = createDraftOverrideStore<string>();
