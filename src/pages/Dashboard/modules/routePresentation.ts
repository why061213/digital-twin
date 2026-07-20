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
] as const;

export function routeColorKey(route?: RouteOrder) {
    return route?.orderId?.trim() || route?.lineId || 'default-route';
}

export function routeTone(route?: RouteOrder, groupRoutes: RouteOrder[] = []) {
    const colorKey = routeColorKey(route);
    const orderKeys = Array.from(new Set(groupRoutes.map(routeColorKey)));
    const orderIndex = orderKeys.indexOf(colorKey);
    const toneIndex = orderIndex >= 0
        ? orderIndex % ROUTE_TONES.length
        : Array.from(colorKey).reduce((sum, char) => sum + char.charCodeAt(0), 0) % ROUTE_TONES.length;
    return ROUTE_TONES[toneIndex];
}
