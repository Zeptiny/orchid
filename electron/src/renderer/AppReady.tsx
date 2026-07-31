/** Ready-only application tree. This module must not load before startup is ready. */
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
import { onOrchidEvent } from './utils/events';
import type { Config } from '../shared/types/ipc-boundary';

type SettingsTab = 'general' | 'providers' | 'mcp' | 'tier-models' | 'rag' | 'skills' | 'agents' | 'personalities';

const ConfigView = lazy(() => import('./components/ConfigView').then((module) => ({
  default: module.ConfigView,
})));
const OnboardingScreen = lazy(() => import('./components/Onboarding/OnboardingScreen').then((module) => ({
  default: module.OnboardingScreen,
})));

function AppReady() {
  const [theme, setThemeState] = useState<ThemeName>('default');
  const [configOpen, setConfigOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [bootstrapConfig, setBootstrapConfig] = useState<Config | null>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // First-run wizard opens only until finish/skip; provider recovery after
  // completion uses Settings / composer setup paths.
  useEffect(() => {
    async function loadBootstrapConfig() {
      try {
        if (window.orchid?.config?.get) {
          const config = await window.orchid.config.get();
          setBootstrapConfig(config);
          const savedTheme = config.theme as ThemeName;
          if (THEME_NAMES.includes(savedTheme)) setThemeState(savedTheme);
          setOnboardingOpen(config.has_completed_onboarding !== true);
        }
      } catch {
        // Non-fatal — use the default theme and skip onboarding.
      } finally {
        setOnboardingChecked(true);
      }
    }

    void loadBootstrapConfig();
  }, []);

  useEffect(() => onOrchidEvent('orchid:open-settings', (detail) => {
    const tab = detail?.tab as SettingsTab | undefined;
    if (tab) setSettingsTab(tab);
    setConfigOpen(true);
  }), []);

  const setTheme = useCallback(async (name: ThemeName) => {
    setThemeState(name);
    try {
      if (window.orchid?.config?.save) await window.orchid.config.save({ updates: { theme: name } });
    } catch {
      // Non-fatal — theme is still applied visually.
    }
  }, []);

  useEffect(() => onOrchidEvent('orchid:set-theme', (detail) => {
    const name = detail.theme as ThemeName | undefined;
    if (name && THEME_NAMES.includes(name)) {
      if (detail.persist === false) setThemeState(name);
      else void setTheme(name);
    }
  }), [setTheme]);

  useEffect(() => {
    if (configOpen) document.documentElement.dataset.orchidSettingsOpen = '1';
    else delete document.documentElement.dataset.orchidSettingsOpen;
    return () => { delete document.documentElement.dataset.orchidSettingsOpen; };
  }, [configOpen]);

  const chatVisible = !configOpen && !(onboardingOpen && onboardingChecked);

  return (
    <div className="app-root h-screen min-h-0 overflow-hidden bg-base-100 text-base-content" data-theme={theme}>
      {/* Keep ChatView mounted under Config so selection and draft state stay shared. */}
      <div className={chatVisible ? 'contents' : 'hidden'} aria-hidden={!chatVisible}>
        <ChatView isVisible={chatVisible} bootstrapConfig={bootstrapConfig} />
      </div>
      {configOpen && (
        <Suspense fallback={<div className="flex h-screen min-h-0 items-center justify-center bg-base-100"><StateMessage kind="loading" title="Loading Settings…" role="status" aria-live="polite" /></div>}>
          <ConfigView initialTab={settingsTab} onClose={() => setConfigOpen(false)} />
        </Suspense>
      )}
      {onboardingOpen && onboardingChecked ? (
        <Suspense fallback={<div className="onb-overlay"><StateMessage kind="loading" title="Loading setup…" role="status" aria-live="polite" /></div>}>
          <OnboardingScreen isOpen onComplete={() => setOnboardingOpen(false)} onSkip={() => setOnboardingOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

export default AppReady;
