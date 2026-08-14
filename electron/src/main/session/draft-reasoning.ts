import { createDraftOverrideStore } from './draft-override-store';

export const {
  set: setDraftReasoningOverride,
  get: getDraftReasoningOverride,
  clear: clearDraftReasoningOverrides,
  take: takeDraftReasoningOverride,
} = createDraftOverrideStore<string | number>();
