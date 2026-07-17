import { API_BASE_URL } from '../constants';

export type DashboardSession = {
    accessToken: string;
    tokenType: 'Bearer';
    issuedAt: string;
    refreshAfter: string;
    expiresAt: string;
    verificationMethod?: string;
    deviceIdentity?: string | null;
};

type SessionValidation = Omit<DashboardSession, 'accessToken'> & { valid: boolean };

const STORAGE_KEY = 'jushen.dashboard.session.v1';
const AUTH_LOST_EVENT = 'dashboard-auth-lost';
const REFRESH_LEAD_MS = 30_000;
let refreshPromise: Promise<DashboardSession> | null = null;

function isSession(value: unknown): value is DashboardSession {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<DashboardSession>;
    return typeof item.accessToken === 'string'
        && item.accessToken.length > 10
        && typeof item.refreshAfter === 'string'
        && typeof item.expiresAt === 'string';
}

export function getDashboardSession(): DashboardSession | null {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (!stored) return null;
        const parsed: unknown = JSON.parse(stored);
        if (!isSession(parsed)) {
            window.localStorage.removeItem(STORAGE_KEY);
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function getDashboardAccessToken() {
    return getDashboardSession()?.accessToken ?? '';
}

function saveSession(session: DashboardSession) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    return session;
}

export function clearDashboardSession() {
    window.localStorage.removeItem(STORAGE_KEY);
}

function deviceHeaders(): HeadersInit | undefined {
    const deviceToken = String(import.meta.env.VITE_DASHBOARD_DEVICE_TOKEN || '').trim();
    return deviceToken ? { 'X-Dashboard-Device-Token': deviceToken } : undefined;
}

async function readSessionResponse(response: Response): Promise<DashboardSession> {
    if (!response.ok) throw new Error(`Dashboard authorization failed: ${response.status}`);
    const session = await response.json() as DashboardSession;
    if (!isSession(session)) throw new Error('Dashboard authorization returned an invalid session');
    return saveSession(session);
}

export async function issueDashboardSession(signal?: AbortSignal): Promise<DashboardSession> {
    return readSessionResponse(await fetch(`${API_BASE_URL}/auth/session`, {
        method: 'POST',
        signal,
        headers: deviceHeaders(),
    }));
}

export async function adoptDashboardAccessKey(accessToken: string): Promise<DashboardSession> {
    const normalized = accessToken.trim();
    const response = await fetch(`${API_BASE_URL}/auth/session`, {
        headers: { Authorization: `Bearer ${normalized}` },
    });
    if (!response.ok) throw new Error('访问密钥无效或已过期');
    const validation = await response.json() as SessionValidation;
    return saveSession({
        accessToken: normalized,
        tokenType: 'Bearer',
        issuedAt: validation.issuedAt,
        refreshAfter: validation.refreshAfter,
        expiresAt: validation.expiresAt,
        verificationMethod: validation.verificationMethod,
        deviceIdentity: validation.deviceIdentity,
    });
}

async function renewSession(current: DashboardSession | null): Promise<DashboardSession> {
    if (current) {
        const response = await fetch(`${API_BASE_URL}/auth/session/refresh`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${current.accessToken}` },
        });
        if (response.ok) return readSessionResponse(response);
    }
    return issueDashboardSession();
}

export async function ensureFreshDashboardSession(force = false): Promise<DashboardSession> {
    const current = getDashboardSession();
    const refreshAt = current ? Date.parse(current.refreshAfter) - REFRESH_LEAD_MS : 0;
    const expiresAt = current ? Date.parse(current.expiresAt) : 0;
    const now = Date.now();
    if (!force && current && Number.isFinite(expiresAt) && expiresAt > now
        && Number.isFinite(refreshAt) && refreshAt > now) {
        return current;
    }
    if (refreshPromise) return refreshPromise;
    refreshPromise = renewSession(current)
        .catch((error) => {
            clearDashboardSession();
            window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT));
            throw error;
        })
        .finally(() => {
            refreshPromise = null;
        });
    return refreshPromise;
}

export async function dashboardFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const execute = async (session: DashboardSession) => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${session.accessToken}`);
        return fetch(input, { ...init, headers });
    };
    let response = await execute(await ensureFreshDashboardSession());
    if (response.status === 401) {
        response = await execute(await ensureFreshDashboardSession(true));
    }
    return response;
}

export function startDashboardSessionMaintenance(onAuthorizationLost: () => void) {
    let disposed = false;
    let timer: number | null = null;

    const schedule = () => {
        if (disposed) return;
        if (timer !== null) window.clearTimeout(timer);
        const session = getDashboardSession();
        const target = session ? Date.parse(session.refreshAfter) - REFRESH_LEAD_MS : Date.now();
        const delay = Number.isFinite(target) ? Math.max(5_000, target - Date.now()) : 5_000;
        timer = window.setTimeout(() => {
            void ensureFreshDashboardSession().then(schedule).catch(onAuthorizationLost);
        }, delay);
    };
    const checkNow = () => void ensureFreshDashboardSession().then(schedule).catch(onAuthorizationLost);
    const handleVisibility = () => {
        if (document.visibilityState === 'visible') checkNow();
    };
    const handleLost = () => onAuthorizationLost();
    window.addEventListener('focus', checkNow);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener(AUTH_LOST_EVENT, handleLost);
    schedule();
    return () => {
        disposed = true;
        if (timer !== null) window.clearTimeout(timer);
        window.removeEventListener('focus', checkNow);
        document.removeEventListener('visibilitychange', handleVisibility);
        window.removeEventListener(AUTH_LOST_EVENT, handleLost);
    };
}
