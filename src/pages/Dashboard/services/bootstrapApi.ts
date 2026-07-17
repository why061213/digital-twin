import { API_BASE_URL } from '../constants';
import { getDashboardAccessToken } from './dashboardAuth';

export type BootstrapStatus = {
    ready: boolean;
    backendReady: boolean;
    dataInitialized: boolean;
    authorized: boolean;
    phase: 'connecting' | 'starting' | 'synchronizing' | 'retrying' | 'unauthorized' | 'ready';
    message: string;
    lastError?: string | null;
    rawCount: number;
    routeCount: number;
    verificationMethod?: string;
    deviceIdentity?: string | null;
    retryAfterMs?: number;
    serverTime: string;
};

export async function fetchBootstrapStatus(signal?: AbortSignal): Promise<BootstrapStatus> {
    const deviceToken = String(import.meta.env.VITE_DASHBOARD_DEVICE_TOKEN || '').trim();
    const accessToken = getDashboardAccessToken();
    const headers = new Headers();
    if (deviceToken) headers.set('X-Dashboard-Device-Token', deviceToken);
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    const response = await fetch(`${API_BASE_URL}/bootstrap/status`, {
        signal,
        headers,
    });
    if (!response.ok) {
        throw new Error(`Bootstrap status request failed: ${response.status}`);
    }
    return response.json() as Promise<BootstrapStatus>;
}
