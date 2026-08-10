import { API_BASE_URL } from '../constants';
import { getDashboardAccessToken } from './dashboardAuth';

export type BootstrapStatus = {
    instanceId?: string;
    processStartedAt?: string;
    ready: boolean;
    backendReady: boolean;
    dataInitialized: boolean;
    authorized: boolean;
    phase: 'connecting' | 'starting' | 'synchronizing' | 'retrying' | 'ready';
    authorizationState?: 'pending' | 'verified' | 'denied';
    authorizationMessage?: string;
    message: string;
    lastError?: string | null;
    rawCount: number;
    routeCount: number;
    verificationMethod?: string;
    authorizationCode?: string;
    remoteAddress?: string | null;
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
        let message = '';
        try {
            const body = await response.json() as { message?: unknown };
            if (typeof body.message === 'string') message = body.message.trim();
        } catch {
            // Use the status-specific fallback below when the body is not JSON.
        }
        const fallback = response.status === 401
            ? '验证会话无效或已经过期'
            : response.status === 403
                ? '后端拒绝当前设备访问'
                : response.status >= 500
                    ? '后端服务发生异常，请查看服务日志'
                    : `验证状态请求失败（HTTP ${response.status}）`;
        throw new Error(message || fallback);
    }
    return response.json() as Promise<BootstrapStatus>;
}
