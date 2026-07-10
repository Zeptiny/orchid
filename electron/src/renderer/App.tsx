/**
 * App root — theme provider + ChatView layout + Preferences + Onboarding.
 *
 * U19 provides the shell with theme switching.
 * U20 replaces SpikeChat with the full ChatStream + Sidebar.
 * U24 adds Preferences modal and Onboarding first-run flow.
 */
import { useState, useEffect, useCallback } from 'react';
import { ChatView } from './components/ChatView';
import { ConfigView } from './components/ConfigView';
import { OnboardingScreen } from './components/Onboarding/OnboardingScreen';
import { applyTheme, THEMES, type ThemeName, THEME_NAMES } from './themes';
import './styles/chat.css';

// ─── Theme Context ───────────────────────────────────────────────────────────

interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (name: ThemeName) => void;
  themes: typeof THEMES;
}

// Simple theme context (no React.createContext needed for this shell)
let themeContext: ThemeContextValue = {
  theme: 'default',
  setTheme: () => {},
  themes: THEMES,
};

export function useTheme(): ThemeContextValue {
  return themeContext;
}

// ─── Component ───────────────────────────────────────────────────────────────

function App() {
  const [theme, setThemeState] = useState<ThemeName>('default');
  const [configOpen, setConfigOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  // Apply theme on mount and when it changes
  useEffect(() => {
    applyTheme(theme);

    // Update the context
    themeContext = {
      ...themeContext,
      theme,
    };
  }, [theme]);

  // Load saved theme from config on mount + check onboarding
  useEffect(() => {
    async function loadTheme() {
      try {
        if (window.orchid?.config?.get) {
          const config = await window.orchid.config.get();
          const savedTheme = config.theme as ThemeName;
          if (THEME_NAMES.includes(savedTheme)) {
            setThemeState(savedTheme);
          }
        }
      } catch {
        // Use default theme if config fails
      }
    }

    async function checkOnboarding() {
      try {
        if (window.orchid?.session?.list) {
          const sessions = await window.orchid.session.list();
          // Show onboarding if no sessions exist (first launch)
          if (sessions.length === 0) {
            setOnboardingOpen(true);
          }
        }
      } catch {
        // Non-fatal — skip onboarding check
      }
      setOnboardingChecked(true);
    }

    loadTheme();
    checkOnboarding();
  }, []);

  // Listen for `orchid:open-settings` event (from /settings command)
  useEffect(() => {
    const handleOpenSettings = () => {
      setConfigOpen(true);
    };
    window.addEventListener('orchid:open-settings', handleOpenSettings);
    return () => window.removeEventListener('orchid:open-settings', handleOpenSettings);
  }, []);

  const setTheme = useCallback(async (name: ThemeName) => {
    setThemeState(name);

    // Persist to config
    try {
      if (window.orchid?.config?.save) {
        await window.orchid.config.save({ updates: { theme: name } });
      }
    } catch {
      // Non-fatal — theme is still applied visually
    }
  }, []);

  // Live theme apply from /theme command (palette or slash menu)
  useEffect(() => {
    const handleSetTheme = (event: Event) => {
      const detail = (event as CustomEvent<{ theme?: string; persist?: boolean }>).detail;
      const name = detail?.theme as ThemeName | undefined;
      if (name && THEME_NAMES.includes(name)) {
        if (detail.persist === false) setThemeState(name);
        else void setTheme(name);
      }
    };
    window.addEventListener('orchid:set-theme', handleSetTheme);
    return () => window.removeEventListener('orchid:set-theme', handleSetTheme);
  }, [setTheme]);

  // Update context with the setter
  useEffect(() => {
    themeContext = {
      ...themeContext,
      setTheme,
    };
  }, [setTheme]);

  return (
    <div className="app-root" data-theme={theme}>
      {configOpen ? (
        <ConfigView onClose={() => setConfigOpen(false)} />
      ) : (
        <ChatView />
      )}
      <OnboardingScreen
        isOpen={onboardingOpen && onboardingChecked}
        onComplete={async (config) => {
          // Save the onboarding config
          try {
            if (window.orchid?.config?.save) {
              await window.orchid.config.save({ updates: config });
            }
          } catch {
            // Non-fatal
          }
          setOnboardingOpen(false);
        }}
        onSkip={() => setOnboardingOpen(false)}
      />
    </div>
  );
}

export default App;
