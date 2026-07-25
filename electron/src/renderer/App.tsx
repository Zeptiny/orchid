/**
 * App root — theme provider + ChatView layout + ConfigView + Onboarding.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { ChatView } from './components/ChatView';
import { StateMessage } from './components/ui/StateMessage';
import { applyTheme, type ThemeName, THEME_NAMES } from './themes';

type SettingsTab = 'general' | 'providers' | 'mcp' | 'tier-models' | 'rag' | 'skills' | 'agents' | 'personalities';

const ConfigView = lazy(() => import('./components/ConfigView').then((module) => ({
  default: module.ConfigView,
})));
const OnboardingScreen = lazy(() => import('./components/Onboarding/OnboardingScreen').then((module) => ({
  default: module.OnboardingScreen,
})));

// ─── Component ───────────────────────────────────────────────────────────────

function App() {
  const [theme, setThemeState] = useState<ThemeName>('default');
  const [configOpen, setConfigOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  // Apply theme on mount and when it changes
  useEffect(() => {
    applyTheme(theme);

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
        if (window.orchid?.config?.get) {
          const config = await window.orchid.config.get();
          // First-run wizard opens only until finish/skip; provider recovery
          // after completion uses Settings / composer setup paths.
          setOnboardingOpen(config.has_completed_onboarding !== true);
        }
      } catch {
        // Non-fatal — skip onboarding check
      }
      setOnboardingChecked(true);
    }

    loadTheme();
    checkOnboarding();
  }, []);

  // Listen for `orchid:open-settings` event (from /settings and provider gates).
  useEffect(() => {
    const handleOpenSettings = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: SettingsTab }>).detail?.tab;
      if (tab) setSettingsTab(tab);
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

  // Let hidden ChatView (InputArea Esc cancel) know settings owns Escape.
  useEffect(() => {
    if (configOpen) {
      document.documentElement.dataset.orchidSettingsOpen = '1';
    } else {
      delete document.documentElement.dataset.orchidSettingsOpen;
    }
    return () => {
      delete document.documentElement.dataset.orchidSettingsOpen;
    };
  }, [configOpen]);

  const chatVisible =
    !configOpen && !(onboardingOpen && onboardingChecked);

  return (
    <div className="app-root h-screen min-h-0 overflow-hidden bg-base-100 text-base-content" data-theme={theme}>
      {/* Keep ChatView mounted under Config so selection/draft state is not
          wiped and the first session is not auto-selected again on close.
          Shared useSession store (useSyncExternalStore) keeps chat + settings
          on one active session / list / workspace snapshot. */}
      <div className={chatVisible ? 'contents' : 'hidden'} aria-hidden={!chatVisible}>
        <ChatView isVisible={chatVisible} />
      </div>
      {configOpen && (
        <Suspense
          fallback={(
            <div className="flex h-screen min-h-0 items-center justify-center bg-base-100">
              <StateMessage kind="loading" title="Loading Settings…" role="status" aria-live="polite" />
            </div>
          )}
        >
          <ConfigView
            initialTab={settingsTab}
            onClose={() => setConfigOpen(false)}
          />
        </Suspense>
      )}
      {onboardingOpen && onboardingChecked ? (
        <Suspense
          fallback={(
            <div className="onb-overlay">
              <StateMessage kind="loading" title="Loading setup…" role="status" aria-live="polite" />
            </div>
          )}
        >
          <OnboardingScreen
            isOpen
            onComplete={() => setOnboardingOpen(false)}
            onSkip={() => setOnboardingOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export default App;
