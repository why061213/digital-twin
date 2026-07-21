import { useCallback, useEffect, useState } from 'react';
import DashboardPage from './pages/Dashboard/DashboardPage'
import { DashboardVerificationGate } from './pages/Dashboard/components/DashboardVerificationGate';
import {
  clearDashboardSession,
  startDashboardSessionMaintenance,
} from './pages/Dashboard/services/dashboardAuth';
import { fetchBootstrapStatus } from './pages/Dashboard/services/bootstrapApi';

const BACKEND_INSTANCE_KEY = 'jushen.dashboard.backend-instance.v1';
const BACKEND_INSTANCE_POLL_MS = 5_000;

function App() {
  const [verified, setVerified] = useState(false);
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const navigate = useCallback((path: string) => {
    window.history.replaceState(null, '', path);
    setPathname(path);
  }, []);
  const handleVerified = useCallback(() => {
    setVerified(true);
    navigate('/');
  }, [navigate]);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!verified) return;
    return startDashboardSessionMaintenance(() => {
      clearDashboardSession();
      setVerified(false);
      navigate('/');
    });
  }, [navigate, verified]);

  useEffect(() => {
    if (!verified) return;
    let disposed = false;
    let timer: number | null = null;
    let knownInstanceId = window.localStorage.getItem(BACKEND_INSTANCE_KEY);

    const pollBackendInstance = async () => {
      try {
        const status = await fetchBootstrapStatus();
        if (disposed) return;
        const nextInstanceId = status.instanceId?.trim();
        if (nextInstanceId) {
          if (knownInstanceId && knownInstanceId !== nextInstanceId) {
            window.localStorage.setItem(BACKEND_INSTANCE_KEY, nextInstanceId);
            clearDashboardSession();
            window.location.reload();
            return;
          }
          knownInstanceId = nextInstanceId;
          window.localStorage.setItem(BACKEND_INSTANCE_KEY, nextInstanceId);
        }
      } catch {
        // A temporary outage is not a restart. Compare instance IDs after recovery.
      }
      if (!disposed) timer = window.setTimeout(pollBackendInstance, BACKEND_INSTANCE_POLL_MS);
    };

    void pollBackendInstance();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [verified]);

  if (pathname === '/verify') {
    return <DashboardVerificationGate onVerified={handleVerified} standalone />;
  }
  return verified ? <DashboardPage /> : <DashboardVerificationGate onVerified={handleVerified} />;
}

export default App
