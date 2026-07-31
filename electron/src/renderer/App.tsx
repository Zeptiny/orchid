/** Renderer root. The ready-only application graph stays behind startup IPC. */
import { lazy, Suspense, useCallback, useState } from 'react';
import { StartupScreen } from './components/StartupScreen';
import { StateMessage } from './components/ui/StateMessage';

const AppReady = lazy(() => import('./AppReady'));

function App() {
  const [ready, setReady] = useState(false);
  const enterApplication = useCallback(() => setReady(true), []);

  if (!ready) return <StartupScreen onReady={enterApplication} />;

  return (
    <Suspense
      fallback={(
        <main className="flex h-screen items-center justify-center bg-base-100 text-base-content" aria-label="Preparing Orchid">
          <StateMessage kind="loading" title="Preparing Orchid…" role="status" aria-live="polite" />
        </main>
      )}
    >
      <AppReady />
    </Suspense>
  );
}

export default App;
