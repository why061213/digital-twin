import { RoadConstant } from '@/config/roadConstant';
import type { RoadGroupStrategy } from './types';

const DEFAULT_POSITION_QUERY_INTERVAL_MS = 60_000;
const DEFAULT_REAL_POSITION_QUERY_INTERVAL_MS = 1_800_000;
const DEFAULT_SLOW_POSITION_QUERY_INTERVAL_MS = 15_000;
const DEFAULT_REAL_SLOW_POSITION_QUERY_INTERVAL_MS = 300_000;
const DEFAULT_POSITION_RENDER_TICK_MS = 500;
const DEFAULT_LOW_SPEED_THRESHOLD_KMH = 50;
const DEFAULT_MAP_VIEW_TRANSITION_MS = 800;
const DEFAULT_ROAD_GROUP_TRANSITION_MS = 420;
const ROAD_GROUP_DISPLAY_MAX_MS = 30_000;
const DEFAULT_RM1_SINGLE_GROUP_DISPLAY_MIN_MS = 20_000;

export const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

function readPositiveEnv(key: string, fallback: number) {
    const raw = import.meta.env[key];
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SIMULATION_PROFILE = String(import.meta.env.VITE_TRUCK_SIMULATION_PROFILE || 'test').toLowerCase();
export const POSITION_QUERY_INTERVAL_MS = SIMULATION_PROFILE === 'real'
    ? readPositiveEnv('VITE_TRUCK_POSITION_QUERY_INTERVAL_REAL_MS', DEFAULT_REAL_POSITION_QUERY_INTERVAL_MS)
    : readPositiveEnv('VITE_TRUCK_POSITION_QUERY_INTERVAL_TEST_MS', DEFAULT_POSITION_QUERY_INTERVAL_MS);
export const SLOW_POSITION_QUERY_INTERVAL_MS = SIMULATION_PROFILE === 'real'
    ? readPositiveEnv('VITE_TRUCK_SLOW_POSITION_QUERY_INTERVAL_REAL_MS', DEFAULT_REAL_SLOW_POSITION_QUERY_INTERVAL_MS)
    : readPositiveEnv('VITE_TRUCK_SLOW_POSITION_QUERY_INTERVAL_TEST_MS', DEFAULT_SLOW_POSITION_QUERY_INTERVAL_MS);
export const LOW_SPEED_THRESHOLD_KMH = readPositiveEnv('VITE_TRUCK_LOW_SPEED_THRESHOLD_KMH', DEFAULT_LOW_SPEED_THRESHOLD_KMH);
export const POSITION_RENDER_TICK_MS = readPositiveEnv('VITE_TRUCK_POSITION_RENDER_TICK_MS', DEFAULT_POSITION_RENDER_TICK_MS);
export const MAP_VIEW_TRANSITION_MS = readPositiveEnv('VITE_MAP_VIEW_TRANSITION_MS', DEFAULT_MAP_VIEW_TRANSITION_MS);
export const MAP_VIEW_RELEASE_DELAY_MS = Math.max(220, Math.round(MAP_VIEW_TRANSITION_MS * 0.45));
export const ROAD_GROUP_TRANSITION_MS = readPositiveEnv('VITE_ROAD_GROUP_TRANSITION_MS', DEFAULT_ROAD_GROUP_TRANSITION_MS);
export const ROAD_GROUP_SWAP_DELAY_MS = Math.max(120, Math.round(ROAD_GROUP_TRANSITION_MS * 0.45));
export const RM1_SINGLE_GROUP_DISPLAY_MIN_MS = readPositiveEnv(
    'VITE_RM1_SINGLE_GROUP_DISPLAY_MIN_MS',
    DEFAULT_RM1_SINGLE_GROUP_DISPLAY_MIN_MS,
);
export const MAX_ROADS_PER_GROUP = 24; // 画布运输上限

export function roadGroupDisplayMs(routeCount: number, singleGroup = false) {
    const safeRouteCount = Math.max(0, routeCount);
    const displayMs = Math.max(1_000, RoadConstant.displayBase + safeRouteCount * RoadConstant.displayAdd);
    const effectiveDisplayMs = singleGroup
        ? Math.max(displayMs, RM1_SINGLE_GROUP_DISPLAY_MIN_MS)
        : displayMs;
    return Math.min(ROAD_GROUP_DISPLAY_MAX_MS, effectiveDisplayMs);
}

export const ROAD_GROUP_STRATEGIES: Array<{ value: RoadGroupStrategy; label: string; badge?: string }> = [
    { value: 'business-priority', label: '综合', badge: '荐' },
    { value: 'by-order', label: '订单' },
    { value: 'by-path', label: '共路' },
    { value: 'by-route', label: '城市' },
];
