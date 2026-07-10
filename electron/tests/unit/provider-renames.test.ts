import { describe, expect, it } from 'vitest';
import {
  activeProviderRenames,
  mergeProviderRename,
} from '../../src/renderer/utils/provider-renames';

describe('mergeProviderRename', () => {
  it('records a provider rename', () => {
    expect(mergeProviderRename([], 'old', 'new')).toEqual([
      { from: 'old', to: 'new' },
    ]);
  });

  it('collapses multiple edits into the original and final aliases', () => {
    const first = mergeProviderRename([], 'old', 'middle');
    expect(mergeProviderRename(first, 'middle', 'new')).toEqual([
      { from: 'old', to: 'new' },
    ]);
  });

  it('drops rename metadata when the alias returns to its original value', () => {
    const first = mergeProviderRename([], 'old', 'new');
    expect(mergeProviderRename(first, 'new', 'old')).toEqual([]);
  });

  it('drops rename metadata when the renamed provider is deleted before save', () => {
    expect(
      activeProviderRenames(
        [{ from: 'old', to: 'new' }],
        { old: null },
      ),
    ).toEqual([]);
  });
});
