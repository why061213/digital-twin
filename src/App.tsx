import { useCallback, useState } from 'react';
import DashboardPage from './pages/Dashboard/DashboardPage'
import { DashboardVerificationGate } from './pages/Dashboard/components/DashboardVerificationGate';

function App() {
  const [verified, setVerified] = useState(false);
  const handleVerified = useCallback(() => setVerified(true), []);

  return verified
    ? <DashboardPage />
    : <DashboardVerificationGate onVerified={handleVerified} />;
}

export default App
