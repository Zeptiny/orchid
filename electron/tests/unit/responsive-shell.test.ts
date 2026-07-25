import { describe, expect, it } from 'vitest';
import { resolveResponsiveShell } from '../../src/renderer/hooks/use-responsive-shell';

describe('responsive shell layout', () => {
  it('uses the saved panel preferences when the shell has adequate width', () => {
    expect(resolveResponsiveShell({
      rightConstrained: false,
      leftConstrained: false,
      rightExpandedPreference: true,
      leftCollapsedPreference: false,
      rightOverlayOpen: false,
      leftOverlayOpen: false,
    })).toEqual({
      rightOpen: true,
      leftCollapsed: false,
      rightOverlay: false,
      leftOverlay: false,
      rightTrack: '300px',
      leftTrack: '260px',
    });
  });

  it('collapses the inspector track without overwriting its wide-screen preference', () => {
    const constrained = resolveResponsiveShell({
      rightConstrained: true,
      leftConstrained: false,
      rightExpandedPreference: true,
      leftCollapsedPreference: false,
      rightOverlayOpen: false,
      leftOverlayOpen: false,
    });
    const restored = resolveResponsiveShell({
      rightConstrained: false,
      leftConstrained: false,
      rightExpandedPreference: true,
      leftCollapsedPreference: false,
      rightOverlayOpen: false,
      leftOverlayOpen: false,
    });

    expect(constrained).toMatchObject({
      rightOpen: false,
      rightOverlay: true,
      rightTrack: '48px',
    });
    expect(restored).toMatchObject({
      rightOpen: true,
      rightOverlay: false,
      rightTrack: '300px',
    });
  });

  it('opens constrained panels as overlays while retaining compact grid tracks', () => {
    expect(resolveResponsiveShell({
      rightConstrained: true,
      leftConstrained: true,
      rightExpandedPreference: true,
      leftCollapsedPreference: false,
      rightOverlayOpen: true,
      leftOverlayOpen: false,
    })).toMatchObject({
      rightOpen: true,
      leftCollapsed: true,
      rightOverlay: true,
      leftOverlay: true,
      rightTrack: '48px',
      leftTrack: '56px',
    });

    expect(resolveResponsiveShell({
      rightConstrained: true,
      leftConstrained: true,
      rightExpandedPreference: true,
      leftCollapsedPreference: false,
      rightOverlayOpen: false,
      leftOverlayOpen: true,
    })).toMatchObject({
      rightOpen: false,
      leftCollapsed: false,
      rightOverlay: true,
      leftOverlay: true,
      rightTrack: '48px',
      leftTrack: '56px',
    });
  });
});
