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

export function routeTone(route?: RouteOrder, groupRoutes: RouteOrder[] = []) {
    const colorKey = routeColorKey(route);
    const orderKeys = Array.from(new Set(groupRoutes.map(routeColorKey)));
    const orderIndex = orderKeys.indexOf(colorKey);
    const isBranch = route?.isRouteBranch || colorKey.startsWith('branch:');
    const toneIndex = isBranch
        ? 3 + (Array.from(colorKey).reduce((sum, char) => sum + char.charCodeAt(0), 0) % Math.max(1, ROUTE_TONES.length - 3))
        : orderIndex >= 0
        ? orderIndex % Math.min(3, ROUTE_TONES.length)
        : Array.from(colorKey).reduce((sum, char) => sum + char.charCodeAt(0), 0) % ROUTE_TONES.length;
    return ROUTE_TONES[toneIndex];
}
