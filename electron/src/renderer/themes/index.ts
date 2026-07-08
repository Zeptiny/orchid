/**
 * Theme loader — imports and applies CSS themes.
 *
 * Each theme sets CSS custom properties on :root.
 * Theme switching is done by swapping the stylesheet link.
 */

export type ThemeName = 'default' | 'solarized-light' | 'bluey' | 'windows-xp' | 'green-terminal';

export const THEMES: Record<ThemeName, string> = {
  default: 'Default (Dark)',
  'solarized-light': 'Solarized Light',
  bluey: 'Bluey',
  'windows-xp': 'Windows XP',
  'green-terminal': 'Green Terminal',
};

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

/**
 * Apply a theme by loading its CSS file.
 * In dev mode, uses dynamic import. In production, styles are inlined.
 */
export function applyTheme(name: ThemeName): void {
  // Remove any existing theme link
  const existingLink = document.getElementById('orchid-theme');
  if (existingLink) {
    existingLink.remove();
  }

  // Create new link element
  const link = document.createElement('link');
  link.id = 'orchid-theme';
  link.rel = 'stylesheet';
  link.href = `./themes/${name}.css`;
  document.head.appendChild(link);
}

/**
 * Get the current theme from the document.
 * Returns the theme name or 'default' if not set.
 */
export function getCurrentTheme(): ThemeName {
  const link = document.getElementById('orchid-theme') as HTMLLinkElement | null;
  if (!link) return 'default';

  const href = link.href;
  for (const name of THEME_NAMES) {
    if (href.includes(`/${name}.css`)) {
      return name;
    }
  }
  return 'default';
}
