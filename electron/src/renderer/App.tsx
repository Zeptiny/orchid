/**
 * App root — theme provider + ChatView layout + Preferences + Onboarding.
 *
 * U19 provides the shell with theme switching.
 * U20 replaces SpikeChat with the full ChatStream + Sidebar.
 * U24 adds Preferences modal and Onboarding first-run flow.
 */
import { useState, useEffect, useCallback } from 'react';
import { ChatView } from './components/ChatView';
import { PreferencesWindow } from './components/Preferences/PreferencesWindow';
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
  const [preferencesOpen, setPreferencesOpen] = useState(false);
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
      setPreferencesOpen(true);
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

  // Update context with the setter
  useEffect(() => {
    themeContext = {
      ...themeContext,
      setTheme,
    };
  }, [setTheme]);

  return (
    <div className="app-root" data-theme={theme}>
      <ChatView />
      <PreferencesWindow
        isOpen={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
      />
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
