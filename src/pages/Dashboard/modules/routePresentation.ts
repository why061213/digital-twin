import type { RouteOrder } from '../hooks/useDashboardRealtime';

const ROUTE_TONES = [
    // 主路线：蓝、黄、绿
    {
        color: '#3b82f6',
        surface: 'rgba(59, 130, 246, 0.08)',
        glow: 'rgba(59, 130, 246, 0.18)',
    },
    {
        color: '#f59e0b',
        surface: 'rgba(245, 158, 11, 0.08)',
        glow: 'rgba(245, 158, 11, 0.18)',
    },
    {
        color: '#22c55e',
        surface: 'rgba(34, 197, 94, 0.08)',
        glow: 'rgba(34, 197, 94, 0.18)',
    },
    // 分支路线备用色
    {
        color: '#a78bfa',
        surface: 'rgba(167, 139, 250, 0.08)',
        glow: 'rgba(167, 139, 250, 0.18)',
    },
    {
        color: '#fb7185',
        surface: 'rgba(251, 113, 133, 0.08)',
        glow: 'rgba(251, 113, 133, 0.18)',
    },
    {
        color: '#2dd4bf',
        surface: 'rgba(45, 212, 191, 0.08)',
        glow: 'rgba(45, 212, 191, 0.18)',
    },
] as const;

export function routeColorKey(route?: RouteOrder) {
    return route?.colorKey?.trim() || route?.orderId?.trim() || route?.lineId || 'default-route';
}

function stableHash(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function routeTone(route?: RouteOrder, _groupRoutes: RouteOrder[] = []) {
    const key = routeColorKey(route);
    const isBranch = route?.isRouteBranch || key.startsWith('branch:');
    // 主路线和分支统一用 hash 取色，与 3D 路线一致
    const baseIndex = stableHash(key) % (isBranch ? ROUTE_TONES.length - 3 : ROUTE_TONES.length);
    const toneIndex = isBranch ? 3 + baseIndex : baseIndex;
    return ROUTE_TONES[toneIndex];
}
