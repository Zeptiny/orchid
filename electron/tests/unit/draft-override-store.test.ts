import { beforeEach, describe, expect, it } from 'vitest';

import { createDraftOverrideStore } from '../../src/main/session/draft-override-store';
import {
  clearDraftReasoningOverrides,
  getDraftReasoningOverride,
  setDraftReasoningOverride,
  takeDraftReasoningOverride,
} from '../../src/main/session/draft-reasoning';
import {
  clearDraftTierOverrides,
  getDraftTierOverride,
  setDraftTierOverride,
  takeDraftTierOverride,
} from '../../src/main/session/draft-tier';

describe('createDraftOverrideStore', () => {
  it('sets, gets, and takes a value per window id', () => {
    const store = createDraftOverrideStore<string>();
    expect(store.get('window-1')).toBeNull();
    store.set('window-1', 'fast');
    expect(store.get('window-1')).toBe('fast');
    expect(store.take('window-1')).toBe('fast');
    expect(store.take('window-1')).toBeUndefined();
    expect(store.get('window-1')).toBeNull();
  });

  it('keeps overrides independent per window id', () => {
    const store = createDraftOverrideStore<string>();
    store.set('window-1', 'fast');
    store.set('window-2', 'quality');
    expect(store.get('window-1')).toBe('fast');
    expect(store.get('window-2')).toBe('quality');
    expect(store.take('window-2')).toBe('quality');
    expect(store.get('window-1')).toBe('fast');
    expect(store.get('window-2')).toBeNull();
  });

  it('clears all overrides at once', () => {
    const store = createDraftOverrideStore<string>();
    store.set('window-1', 'fast');
    store.set('window-2', 'quality');
    store.clear();
    expect(store.get('window-1')).toBeNull();
    expect(store.get('window-2')).toBeNull();
    expect(store.take('window-1')).toBeUndefined();
  });

  it('distinguishes an explicit null override from absence on take', () => {
    const store = createDraftOverrideStore<string>();
    store.set('window-1', null);
    expect(store.get('window-1')).toBeNull();
    expect(store.take('window-1')).toBeNull();
    expect(store.take('window-1')).toBeUndefined();
  });
});

describe('draft-tier overrides', () => {
  beforeEach(() => clearDraftTierOverrides());

  it('parks a tier per window id until a session promotes it', () => {
    setDraftTierOverride('window-1', 'fast');
    setDraftTierOverride('window-2', 'quality');
    expect(getDraftTierOverride('window-1')).toBe('fast');
    expect(getDraftTierOverride('window-2')).toBe('quality');
    expect(takeDraftTierOverride('window-2')).toBe('quality');
    expect(takeDraftTierOverride('window-2')).toBeUndefined();
    expect(getDraftTierOverride('window-1')).toBe('fast');
  });

  it('clears all parked tiers', () => {
    setDraftTierOverride('window-1', 'fast');
    clearDraftTierOverrides();
    expect(getDraftTierOverride('window-1')).toBeNull();
  });
});

describe('draft-reasoning overrides', () => {
  beforeEach(() => clearDraftReasoningOverrides());

  it('parks a reasoning effort per window id until a session promotes it', () => {
    setDraftReasoningOverride('window-1', 'high');
    setDraftReasoningOverride('window-2', 3);
    expect(getDraftReasoningOverride('window-1')).toBe('high');
    expect(getDraftReasoningOverride('window-2')).toBe(3);
    expect(takeDraftReasoningOverride('window-2')).toBe(3);
    expect(takeDraftReasoningOverride('window-2')).toBeUndefined();
    expect(getDraftReasoningOverride('window-1')).toBe('high');
  });

  it('clears all parked reasoning efforts', () => {
    setDraftReasoningOverride('window-1', 'high');
    clearDraftReasoningOverrides();
    expect(getDraftReasoningOverride('window-1')).toBeNull();
  });

  it('keeps tier and reasoning stores independent', () => {
    setDraftTierOverride('window-1', 'fast');
    setDraftReasoningOverride('window-1', 'high');
    expect(getDraftTierOverride('window-1')).toBe('fast');
    expect(getDraftReasoningOverride('window-1')).toBe('high');
    expect(takeDraftTierOverride('window-1')).toBe('fast');
    expect(getDraftReasoningOverride('window-1')).toBe('high');
    expect(takeDraftReasoningOverride('window-1')).toBe('high');
  });
});
