import type { RouteOrder } from '../hooks/useDashboardRealtime';

const ROUTE_TONES = [
    {
        color: '#00ff88',
        surface: 'rgba(0, 255, 136, 0.08)',
        glow: 'rgba(0, 255, 136, 0.18)',
    },
    {
        color: '#00ccff',
        surface: 'rgba(0, 204, 255, 0.08)',
        glow: 'rgba(0, 204, 255, 0.18)',
    },
    {
        color: '#ffaa00',
        surface: 'rgba(255, 170, 0, 0.08)',
        glow: 'rgba(255, 170, 0, 0.18)',
    },
    {
        color: '#ff44aa',
        surface: 'rgba(255, 68, 170, 0.08)',
        glow: 'rgba(255, 68, 170, 0.18)',
    },
    {
        color: '#aaff00',
        surface: 'rgba(170, 255, 0, 0.08)',
        glow: 'rgba(170, 255, 0, 0.18)',
    },
    {
        color: '#00ffff',
        surface: 'rgba(0, 255, 255, 0.08)',
        glow: 'rgba(0, 255, 255, 0.18)',
    },
    {
        color: '#ff8800',
        surface: 'rgba(255, 136, 0, 0.08)',
        glow: 'rgba(255, 136, 0, 0.18)',
    },
    {
        color: '#44aaff',
        surface: 'rgba(68, 170, 255, 0.08)',
        glow: 'rgba(68, 170, 255, 0.18)',
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
