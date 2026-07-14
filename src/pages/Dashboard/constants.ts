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

export const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api').replace(/\/$/, '');

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
/** 批量位置查询间隔（真实环境 60 秒，测试环境可调低） */
export const POSITION_BATCH_POLL_MS = readPositiveEnv('VITE_POSITION_BATCH_POLL_MS',
    SIMULATION_PROFILE === 'real' ? 60_000 : 30_000);
/** WebSocket 正常时 REST 兜底间隔（2~5 分钟） */
export const POSITION_WS_FALLBACK_POLL_MS = readPositiveEnv('VITE_POSITION_WS_FALLBACK_POLL_MS', 180_000);
/** WebSocket 超时未收到消息视为断开（毫秒） */
export const WS_POSITION_TIMEOUT_MS = readPositiveEnv('VITE_WS_POSITION_TIMEOUT_MS', 90_000);
/** 批量请求最小间隔：避免 prefetch 后立即 poll */
export const POSITION_BATCH_MIN_INTERVAL_MS = readPositiveEnv('VITE_POSITION_BATCH_MIN_INTERVAL_MS', 10_000);
/** 路线组最大可见线路数 */
export const ROUTE_DISPLAY_MAX_COUNT = readPositiveEnv('VITE_ROUTE_DISPLAY_MAX_COUNT', 12);
export const MAP_VIEW_TRANSITION_MS = readPositiveEnv('VITE_MAP_VIEW_TRANSITION_MS', DEFAULT_MAP_VIEW_TRANSITION_MS);
export const MAP_VIEW_RELEASE_DELAY_MS = Math.max(220, Math.round(MAP_VIEW_TRANSITION_MS * 0.45));
export const ROAD_GROUP_TRANSITION_MS = readPositiveEnv('VITE_ROAD_GROUP_TRANSITION_MS', DEFAULT_ROAD_GROUP_TRANSITION_MS);
export const ROAD_GROUP_SWAP_DELAY_MS = Math.max(120, Math.round(ROAD_GROUP_TRANSITION_MS * 0.45));
export const MAX_ROADS_PER_GROUP = 24; // 画布运输上限

export function roadGroupDisplayMs(routeCount: number) {
    const safeRouteCount = Math.max(0, routeCount);
    const displayMs = Math.max(1_000, RoadConstant.displayBase + safeRouteCount * RoadConstant.displayAdd);
    return Math.min(ROAD_GROUP_DISPLAY_MAX_MS, displayMs);
}

export const ROAD_GROUP_STRATEGIES: Array<{ value: RoadGroupStrategy; label: string; badge?: string }> = [
    { value: 'business-priority', label: '综合', badge: '荐' },
    { value: 'by-order', label: '订单' },
    { value: 'by-path', label: '共路' },
    { value: 'by-route', label: '城市' },
];
