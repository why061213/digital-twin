import { useCallback, useEffect, useState } from 'react';
import DashboardPage from './pages/Dashboard/DashboardPage'
import { DashboardVerificationGate } from './pages/Dashboard/components/DashboardVerificationGate';
import {
  clearDashboardSession,
  getDashboardSession,
  startDashboardSessionMaintenance,
} from './pages/Dashboard/services/dashboardAuth';

function App() {
  const [verified, setVerified] = useState(false);
  const [pathname, setPathname] = useState(() => {
    const current = window.location.pathname;
    if (current !== '/verify' && !getDashboardSession()) {
      window.history.replaceState(null, '', '/verify');
      return '/verify';
    }
    return current;
  });
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
      navigate('/verify');
    });
  }, [navigate, verified]);

  if (pathname === '/verify') {
    return <DashboardVerificationGate onVerified={handleVerified} standalone />;
  }
  return verified ? <DashboardPage /> : <DashboardVerificationGate onVerified={handleVerified} />;
}

export default App
