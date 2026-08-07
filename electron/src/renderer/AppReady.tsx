/** Ready-only application tree. This module must not load before startup is ready. */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ChatView } from './components/ChatView';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { Alert } from './components/ui/Alert';
import { Button } from './components/ui/Button';
import { StateMessage } from './components/ui/StateMessage';
import { applyTheme, type ThemeName, THEME_NAMES } from './themes';
import { onOrchidEvent } from './utils/events';
import type { Notify, NotifySeverity } from './utils/notify';
import { useSessionActivity } from './hooks/useSessionActivity';
import type { Config } from '../shared/types/ipc-boundary';

type SettingsTab = 'general' | 'providers' | 'mcp' | 'tier-models' | 'rag' | 'skills' | 'agents' | 'personalities';

const ConfigView = lazy(() => import('./components/ConfigView').then((module) => ({
  default: module.ConfigView,
})));
const AnalyticsView = lazy(() => import('./components/AnalyticsView').then((module) => ({
  default: module.AnalyticsView,
})));
const OnboardingScreen = lazy(() => import('./components/Onboarding/OnboardingScreen').then((module) => ({
  default: module.OnboardingScreen,
})));

interface Toast {
  message: string;
  severity: NotifySeverity;
}

function AppReady() {
  const [theme, setThemeState] = useState<ThemeName>('default');
  const [configOpen, setConfigOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [bootstrapConfig, setBootstrapConfig] = useState<Config | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activity = useSessionActivity();

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
    setAnalyticsOpen(false);
    setConfigOpen(true);
  }), []);

  useEffect(() => onOrchidEvent('orchid:open-analytics', () => {
    setConfigOpen(false);
    setAnalyticsOpen(true);
  }), []);

  const setTheme = useCallback(async (name: ThemeName) => {
    setThemeState(name);
    try {
      if (window.orchid?.config?.save) await window.orchid.config.save({ updates: { theme: name } });
    } catch {
      // Non-fatal — theme is still applied visually.
    }
  }, []);

  const notify: Notify = useCallback((message, severity = 'info') => {
    console.log(`[${severity.toUpperCase()}] ${message}`);
    if (severity === 'error') console.error(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, severity });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
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

  const chatVisible = !configOpen && !analyticsOpen && !(onboardingOpen && onboardingChecked);

  return (
    <div className="app-root relative h-screen min-h-0 overflow-hidden bg-base-100 text-base-content" data-theme={theme}>
      {toast && (
        <Alert
          tone={toast.severity}
          variant="soft"
          className={`command-toast command-toast-${toast.severity} orchid-state-enter py-2 text-sm`}
          role="status"
          aria-live="polite"
          action={
            <Button
              variant="ghost"
              size="xs"
              shape="circle"
              onClick={() => setToast(null)}
              aria-label="Dismiss"
            >
              ×
            </Button>
          }
        >
          <span className="command-toast-message min-w-0 flex-1">{toast.message}</span>
        </Alert>
      )}
      {/* Keep ChatView mounted under Config so selection and draft state stay shared. */}
      <div className={chatVisible ? 'contents' : 'hidden'} aria-hidden={!chatVisible}>
        <ChatView isVisible={chatVisible} bootstrapConfig={bootstrapConfig} onNotify={notify} activity={activity} />
      </div>
      {configOpen && (
        <ErrorBoundary title="Settings could not load">
          <Suspense fallback={<div className="flex h-screen min-h-0 items-center justify-center bg-base-100"><StateMessage kind="loading" title="Loading Settings…" role="status" aria-live="polite" /></div>}>
            <ConfigView initialTab={settingsTab} onClose={() => setConfigOpen(false)} onNotify={notify} onOpenAnalytics={() => { setConfigOpen(false); setAnalyticsOpen(true); }} activity={activity} />
          </Suspense>
        </ErrorBoundary>
      )}
      {analyticsOpen && (
        <ErrorBoundary title="Analytics could not load">
          <Suspense fallback={<div className="flex h-screen min-h-0 items-center justify-center bg-base-100"><StateMessage kind="loading" title="Loading Analytics…" role="status" aria-live="polite" /></div>}>
            <AnalyticsView onClose={() => setAnalyticsOpen(false)} onOpenSettings={() => { setAnalyticsOpen(false); setConfigOpen(true); }} activity={activity} />
          </Suspense>
        </ErrorBoundary>
      )}
      {onboardingOpen && onboardingChecked ? (
        <ErrorBoundary title="Setup could not load" className="onb-overlay">
          <Suspense fallback={<div className="onb-overlay"><StateMessage kind="loading" title="Loading setup…" role="status" aria-live="polite" /></div>}>
            <OnboardingScreen isOpen onComplete={() => setOnboardingOpen(false)} onSkip={() => setOnboardingOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      ) : null}
    </div>
  );
}

export default AppReady;
