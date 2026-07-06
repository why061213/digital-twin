import { useCallback, useEffect, useRef, useState } from 'react';
import MainLayout from '@/components/Layout/MainLayout';
import Header from '@/components/Layout/Header';
import Warehouse3D from './modules/Warehouse3D';
import ChinaMap3D from './modules/ChinaMap3D/index';
import type { ChinaMap3DHandle } from './modules/ChinaMap3D';
import RoadMap3D from './modules/RoadMap3D';
import type { RoadMap3DHandle } from './modules/RoadMap3D';
import DashboardSidePanels from './modules/DashboardSidePanels';
import type { WarehouseFocusState, RoadGroupPanelState } from './modules/DashboardSidePanels';
import { useDashboardRealtime } from './hooks/useDashboardRealtime';
import type { RoadPathMessage, RouteOrder, TruckPositionMessage, WarehouseFocusPanel, WarehouseFocusStyle } from './hooks/useDashboardRealtime';
import type { PanelData } from './modules/ChinaMap3D/types';
import {
    loadTruckPositionsFromCache,
    saveTruckPositionToCache,
} from './modules/RoadMap3D/utils';
import { RoadConstant } from '@/config/roadConstant';


type ViewMode = 'warehouse' | 'chinaMap' | 'roadMap';
type LonLat = [number, number];
type RoadGroupStrategy = 'business-priority' | 'by-order' | 'by-path' | 'by-route';

type ActiveRoute = RouteOrder & {
    orderId?: string;
    orderName?: string;
    orderTotalTons?: number;
    orderVehicleCount?: number;
    pathKey?: string;
    startedAt: number;
    fallbackDuration: number;
    coordinates: LonLat[];
    calibratedAt: number;
    calibratedDistance: number;
    pathSpeed: number;
    pathLength: number;
    routeLengthKm: number;
    speedKmh: number | null;
    nextCalibrationAt: number;
    arrivalCheckRequested: boolean;
};

type RoadGroupSummary = {
    groupId: string;
    index: number;
    count: number;
    groupScenario?: string;
    displayTemplate?: string;
    scenarioReason?: string;
    groupKey?: string;
    orderIds?: string[];
};

type RoadGroupsResponse = {
    groupSize: number;
    strategy?: string;
    totalRoutes: number;
    groups: RoadGroupSummary[];
};

type RoadGroupRoutesResponse = {
    groupId: string;
    routes: RoadPathMessage[];
};

type RoadGroupNode = {
    groupId: string;
    next: RoadGroupNode | null;
};

type RoadGroupRing = {
    head: RoadGroupNode | null;
    tail: RoadGroupNode | null;
    current: RoadGroupNode | null;
    nodes: Map<string, RoadGroupNode>;
};

const DEFAULT_POSITION_QUERY_INTERVAL_MS = 60_000;
const DEFAULT_REAL_POSITION_QUERY_INTERVAL_MS = 1_800_000;
const DEFAULT_SLOW_POSITION_QUERY_INTERVAL_MS = 15_000;
const DEFAULT_REAL_SLOW_POSITION_QUERY_INTERVAL_MS = 300_000;
const DEFAULT_POSITION_RENDER_TICK_MS = 500;
const DEFAULT_LOW_SPEED_THRESHOLD_KMH = 50;
const DEFAULT_MAP_VIEW_TRANSITION_MS = 800;
const DEFAULT_ROAD_GROUP_TRANSITION_MS = 420;
const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api').replace(/\/$/, '');

function readPositiveEnv(key: string, fallback: number) {
    const raw = import.meta.env[key];
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SIMULATION_PROFILE = String(import.meta.env.VITE_TRUCK_SIMULATION_PROFILE || 'test').toLowerCase();
const POSITION_QUERY_INTERVAL_MS = SIMULATION_PROFILE === 'real'
    ? readPositiveEnv('VITE_TRUCK_POSITION_QUERY_INTERVAL_REAL_MS', DEFAULT_REAL_POSITION_QUERY_INTERVAL_MS)
    : readPositiveEnv('VITE_TRUCK_POSITION_QUERY_INTERVAL_TEST_MS', DEFAULT_POSITION_QUERY_INTERVAL_MS);
const SLOW_POSITION_QUERY_INTERVAL_MS = SIMULATION_PROFILE === 'real'
    ? readPositiveEnv('VITE_TRUCK_SLOW_POSITION_QUERY_INTERVAL_REAL_MS', DEFAULT_REAL_SLOW_POSITION_QUERY_INTERVAL_MS)
    : readPositiveEnv('VITE_TRUCK_SLOW_POSITION_QUERY_INTERVAL_TEST_MS', DEFAULT_SLOW_POSITION_QUERY_INTERVAL_MS);
const LOW_SPEED_THRESHOLD_KMH = readPositiveEnv('VITE_TRUCK_LOW_SPEED_THRESHOLD_KMH', DEFAULT_LOW_SPEED_THRESHOLD_KMH);
const POSITION_RENDER_TICK_MS = readPositiveEnv('VITE_TRUCK_POSITION_RENDER_TICK_MS', DEFAULT_POSITION_RENDER_TICK_MS);
const MAP_VIEW_TRANSITION_MS = readPositiveEnv('VITE_MAP_VIEW_TRANSITION_MS', DEFAULT_MAP_VIEW_TRANSITION_MS);
const MAP_VIEW_RELEASE_DELAY_MS = Math.max(220, Math.round(MAP_VIEW_TRANSITION_MS * 0.45));
const ROAD_GROUP_TRANSITION_MS = readPositiveEnv('VITE_ROAD_GROUP_TRANSITION_MS', DEFAULT_ROAD_GROUP_TRANSITION_MS);
const ROAD_GROUP_SWAP_DELAY_MS = Math.max(120, Math.round(ROAD_GROUP_TRANSITION_MS * 0.45));

function roadGroupDisplayMs(routeCount: number) {
    const safeRouteCount = Math.max(0, routeCount);
    return Math.max(1_000, RoadConstant.displayBase + safeRouteCount * RoadConstant.displayAdd);
}

const ROAD_GROUP_STRATEGIES: Array<{ value: RoadGroupStrategy; label: string; badge?: string }> = [
    { value: 'business-priority', label: '综合', badge: '荐' },
    { value: 'by-order', label: '订单' },
    { value: 'by-path', label: '共路' },
    { value: 'by-route', label: '城市' },
];

function createRoadGroupRing(): RoadGroupRing {
    return {head: null, tail: null, current: null, nodes: new Map()};
}

function ensureRoadGroupRing(rings: Map<RoadGroupStrategy, RoadGroupRing>, strategy: RoadGroupStrategy) {
    let ring = rings.get(strategy);
    if (!ring) {
        ring = createRoadGroupRing();
        rings.set(strategy, ring);
    }
    return ring;
}

function hashText(text: string) {
    return Array.from(text).reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function lerp(start: number, end: number, progress: number) {
    return start + (end - start) * progress;
}

function clamp01(value: number) {
    return Math.min(Math.max(value, 0), 1);
}

function waitFrame() {
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function waitMs(delay: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, delay));
}

function distance(a: LonLat, b: LonLat) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    return Math.sqrt(dx * dx + dy * dy);
}

function buildPlate(lineId: string) {
    const prefixes = ['粤A', '粤B', '湘E', '赣C', '苏E', '浙A'];
    const hash = hashText(lineId);
    return `${prefixes[hash % prefixes.length]}·${lineId.slice(0, 6).toUpperCase()}`;
}

function buildCargo(lineId: string) {
    const cargos = ['铝锭', '铜材', '钢材', '化工原料', '其他'];
    return cargos[hashText(lineId) % cargos.length];
}

function pathLength(coordinates: LonLat[]) {
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
        total += distance(coordinates[i - 1], coordinates[i]);
    }
    return total;
}

function distanceKm(a: LonLat, b: LonLat) {
    const earthRadiusKm = 6371;
    const lat1 = a[1] * Math.PI / 180;
    const lat2 = b[1] * Math.PI / 180;
    const deltaLat = (b[1] - a[1]) * Math.PI / 180;
    const deltaLng = (b[0] - a[0]) * Math.PI / 180;
    const h =
        Math.sin(deltaLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function pathLengthKm(coordinates: LonLat[]) {
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
        total += distanceKm(coordinates[i - 1], coordinates[i]);
    }
    return total;
}

function positionAtDistance(coordinates: LonLat[], targetDistance: number): LonLat {
    if (coordinates.length === 0) return [0, 0];
    if (coordinates.length === 1 || targetDistance <= 0) return coordinates[0];

    let walked = 0;
    for (let i = 1; i < coordinates.length; i++) {
        const start = coordinates[i - 1];
        const end = coordinates[i];
        const segmentLength = distance(start, end);
        if (segmentLength <= 0) continue;

        if (walked + segmentLength >= targetDistance) {
            const progress = clamp01((targetDistance - walked) / segmentLength);
            return [lerp(start[0], end[0], progress), lerp(start[1], end[1], progress)];
        }
        walked += segmentLength;
    }

    return coordinates[coordinates.length - 1];
}

function projectDistanceOnPath(coordinates: LonLat[], point: LonLat) {
    if (coordinates.length < 2) return 0;

    let walked = 0;
    let nearestDistance = 0;
    let nearestDistanceSq = Number.POSITIVE_INFINITY;

    for (let i = 1; i < coordinates.length; i++) {
        const start = coordinates[i - 1];
        const end = coordinates[i];
        const abX = end[0] - start[0];
        const abY = end[1] - start[1];
        const segmentLengthSq = abX * abX + abY * abY;
        if (segmentLengthSq <= 0) continue;

        const apX = point[0] - start[0];
        const apY = point[1] - start[1];
        const segmentProgress = clamp01((apX * abX + apY * abY) / segmentLengthSq);
        const projectedX = start[0] + abX * segmentProgress;
        const projectedY = start[1] + abY * segmentProgress;
        const dx = point[0] - projectedX;
        const dy = point[1] - projectedY;
        const currentDistanceSq = dx * dx + dy * dy;

        if (currentDistanceSq < nearestDistanceSq) {
            nearestDistanceSq = currentDistanceSq;
            nearestDistance = walked + Math.sqrt(segmentLengthSq) * segmentProgress;
        }

        walked += Math.sqrt(segmentLengthSq);
    }

    return nearestDistance;
}

function predictedPosition(route: ActiveRoute, now: number): LonLat {
    return positionAtDistance(route.coordinates, predictedDistance(route, now));
}

function predictedDistance(route: ActiveRoute, now: number) {
    if (route.pathLength <= 0) return 0;
    const elapsed = Math.max(0, now - route.calibratedAt);
    return Math.min(route.pathLength, route.calibratedDistance + route.pathSpeed * elapsed);
}

function nextQueryInterval(speedKmh: number | null) {
    if (speedKmh !== null && speedKmh < LOW_SPEED_THRESHOLD_KMH) {
        return SLOW_POSITION_QUERY_INTERVAL_MS;
    }
    return POSITION_QUERY_INTERVAL_MS;
}

function initialPositionQueryDelay(lineId: string) {
    return 800 + (hashText(lineId) % 4_200);
}

function routeProgressPatch(route: ActiveRoute, now: number) {
    const currentDistance = predictedDistance(route, now);
    return {
        progress: route.pathLength > 0 ? clamp01(currentDistance / route.pathLength) : 0,
        calibratedDistance: currentDistance,
        pathLength: route.pathLength,
        routeLengthKm: route.routeLengthKm,
        speedKmh: route.speedKmh,
    };
}

function applyTruckPositionToRoute(route: ActiveRoute, message: TruckPositionMessage, now: number) {
    const pushedVelocity = message.velocity ?? message.speed;
    const elapsedSinceLastCalibration = now - route.calibratedAt;
    const nextDistance = projectDistanceOnPath(route.coordinates, message.position);
    const measuredPathSpeed = elapsedSinceLastCalibration > 0
        ? Math.max(0, (nextDistance - route.calibratedDistance) / elapsedSinceLastCalibration)
        : route.pathSpeed;
    const measuredSpeedKmh = elapsedSinceLastCalibration > 0 && route.pathLength > 0
        ? measuredPathSpeed / route.pathLength * route.routeLengthKm * 3_600_000
        : null;
    const pushedPathSpeed = pushedVelocity
        ? Math.sqrt(pushedVelocity[0] * pushedVelocity[0] + pushedVelocity[1] * pushedVelocity[1])
        : null;

    route.pathSpeed = pushedPathSpeed ?? measuredPathSpeed ?? route.pathSpeed;
    route.speedKmh = message.speedKmh ?? measuredSpeedKmh ?? route.speedKmh;
    route.calibratedAt = now;
    route.calibratedDistance = nextDistance;
    route.nextCalibrationAt = now + nextQueryInterval(route.speedKmh);
    route.arrivalCheckRequested = false;
}

function mergeVisibleRouteOrders(previous: RouteOrder[], incoming: ActiveRoute[], completedIds: Set<string>) {
    const merged = new Map<string, RouteOrder>();

    previous.forEach((route) => {
        merged.set(route.lineId, route);
    });

    incoming.forEach((route) => {
        const old = merged.get(route.lineId);
        merged.set(route.lineId, {
            ...old,
            ...route,
            status: completedIds.has(route.lineId) ? '已完成' : route.status,
        });
    });

    completedIds.forEach((lineId) => {
        const route = merged.get(lineId);
        if (route) {
            merged.set(lineId, { ...route, status: '已完成' });
        }
    });

    return Array.from(merged.values());
}

function DashboardPage() {
    const [view, setView] = useState<ViewMode>('warehouse');
    const [routeOrders, setRouteOrders] = useState<RouteOrder[]>([]);
    const [roadGroups, setRoadGroups] = useState<RoadGroupSummary[]>([]);
    const [activeRoadGroupId, setActiveRoadGroupId] = useState<string | null>(null);
    const [roadGroupStrategy, setRoadGroupStrategy] = useState<RoadGroupStrategy>('business-priority');
    const [warehouseFocus, setWarehouseFocus] = useState<WarehouseFocusState | null>(null);
    const [isDispatching, setIsDispatching] = useState(false);
    const [isLoadingRoadGroup, setIsLoadingRoadGroup] = useState(false);
    const [chinaMapSession, setChinaMapSession] = useState(0);
    const [isPreparingChinaMap, setIsPreparingChinaMap] = useState(false);
    const [isRevealingChinaMap, setIsRevealingChinaMap] = useState(false);
    const [isChinaMapVisualReady, setIsChinaMapVisualReady] = useState(false);
    const [isChinaMapDataReady, setIsChinaMapDataReady] = useState(false);
    const [roadMapSession, setRoadMapSession] = useState(0);
    const [isPreparingRoadMap, setIsPreparingRoadMap] = useState(false);
    const [isRevealingRoadMap, setIsRevealingRoadMap] = useState(false);
    const [isRoadMapVisualReady, setIsRoadMapVisualReady] = useState(false);
    const [isRoadMapDataReady, setIsRoadMapDataReady] = useState(false);
    const [isRoadGroupFading, setIsRoadGroupFading] = useState(false);
    const [roadGroupAdvanceTick, setRoadGroupAdvanceTick] = useState(0);
    const [manualCarId, setManualCarId] = useState('');
    const [manualQueryStatus, setManualQueryStatus] = useState('');
    const [isManualQuerying, setIsManualQuerying] = useState(false);
    const mapRef = useRef<ChinaMap3DHandle>(null);
    const roadMapRef = useRef<RoadMap3DHandle>(null);
    const chinaMapPrepareRunRef = useRef(0);
    const chinaMapRevealTimerRef = useRef<number | null>(null);
    const roadMapPrepareRunRef = useRef(0);
    const roadMapRevealTimerRef = useRef<number | null>(null);
    const activeRoutesRef = useRef<Map<string, ActiveRoute>>(new Map());
    const routeOrdersRef = useRef<RouteOrder[]>([]);
    const positionRequestsRef = useRef<Set<string>>(new Set());
    const activeRoadGroupIdRef = useRef<string | null>(null);
    const roadGroupRingsRef = useRef<Map<RoadGroupStrategy, RoadGroupRing>>(new Map());
    const roadGroupSummariesByStrategyRef = useRef<Map<RoadGroupStrategy, Map<string, RoadGroupSummary>>>(new Map());
    const roadGroupRouteIdsByStrategyRef = useRef<Map<RoadGroupStrategy, Map<string, Set<string>>>>(new Map());
    const completedRouteIdsRef = useRef<Set<string>>(new Set());
    const routeGroupIdRef = useRef<Map<string, string>>(new Map());
    const roadGroupLoadingRef = useRef(false);
    const warehouseDisplayDataRef = useRef<Map<string, Record<string, any>>>(new Map());
    const roadPathRefreshTimerRef = useRef<number | null>(null);
    const pendingRoadGroupRefreshIdRef = useRef<string | undefined>(undefined);
    const roadGroupRefreshInFlightRef = useRef(false);
    const queuedRoadGroupRefreshIdRef = useRef<string | null | undefined>(undefined);
    const roadGroupAdvanceTimerRef = useRef<number | null>(null);
    const skipNextRoadMapRefreshRef = useRef(false);

    useEffect(() => {
        routeOrdersRef.current = routeOrders;
    }, [routeOrders]);

    const currentRoadGroupRing = useCallback(
        () => ensureRoadGroupRing(roadGroupRingsRef.current, roadGroupStrategy),
        [roadGroupStrategy]
    );
    const currentRoadGroupSummaries = useCallback(() => {
        let summaries = roadGroupSummariesByStrategyRef.current.get(roadGroupStrategy);
        if (!summaries) {
            summaries = new Map();
            roadGroupSummariesByStrategyRef.current.set(roadGroupStrategy, summaries);
        }
        return summaries;
    }, [roadGroupStrategy]);
    const currentRoadGroupRouteIds = useCallback(() => {
        let routeIds = roadGroupRouteIdsByStrategyRef.current.get(roadGroupStrategy);
        if (!routeIds) {
            routeIds = new Map();
            roadGroupRouteIdsByStrategyRef.current.set(roadGroupStrategy, routeIds);
        }
        return routeIds;
    }, [roadGroupStrategy]);

    const removeRoadGroupFromRing = useCallback((groupId: string) => {
        const ring = currentRoadGroupRing();
        const target = ring.nodes.get(groupId);
        if (!target) return;

        if (ring.nodes.size === 1) {
            ring.head = null;
            ring.tail = null;
            ring.current = null;
        } else {
            let previous = ring.head;
            while (previous?.next && previous.next !== target) {
                previous = previous.next;
                if (previous === ring.head) break;
            }

            if (previous?.next === target) {
                previous.next = target.next;
            }
            if (ring.head === target) {
                ring.head = target.next;
            }
            if (ring.tail === target) {
                ring.tail = previous;
            }
            // current 保持在被删节点的前驱，这样下一次 advance 会准确走到被删节点的后继。
            if (ring.current === target) {
                ring.current = previous ?? target.next;
            }
            if (ring.tail) {
                ring.tail.next = ring.head;
            }
        }

        ring.nodes.delete(groupId);
        currentRoadGroupSummaries().delete(groupId);
        currentRoadGroupRouteIds().delete(groupId);
        setRoadGroups((prev) => prev.filter((group) => group.groupId !== groupId));
        if (activeRoadGroupIdRef.current === groupId) {
            activeRoadGroupIdRef.current = null;
            setActiveRoadGroupId(null);
            routeOrdersRef.current = [];
            setRouteOrders([]);
        }
    }, [currentRoadGroupRing, currentRoadGroupRouteIds, currentRoadGroupSummaries]);

    const syncRoadGroupRing = useCallback((groups: RoadGroupSummary[]) => {
        const ring = currentRoadGroupRing();
        const summaries = currentRoadGroupSummaries();
        groups.forEach((group) => {
            summaries.set(group.groupId, group);
            if (ring.nodes.has(group.groupId)) return;

            const node: RoadGroupNode = {groupId: group.groupId, next: null};
            ring.nodes.set(group.groupId, node);
            if (!ring.head || !ring.tail) {
                ring.head = node;
                ring.tail = node;
                node.next = node;
            } else {
                node.next = ring.head;
                ring.tail.next = node;
                ring.tail = node;
            }
        });
    }, [currentRoadGroupRing, currentRoadGroupSummaries]);

    const isRoadGroupComplete = useCallback((groupId: string) => {
        const routeIds = currentRoadGroupRouteIds().get(groupId);
        if (!routeIds || routeIds.size === 0) return false;
        return Array.from(routeIds).every((lineId) => completedRouteIdsRef.current.has(lineId));
    }, [currentRoadGroupRouteIds]);

    const setCurrentRoadGroup = useCallback((groupId: string | null) => {
        activeRoadGroupIdRef.current = groupId;
        setActiveRoadGroupId(groupId);

        if (!groupId) return;
        const node = currentRoadGroupRing().nodes.get(groupId);
        if (node) {
            currentRoadGroupRing().current = node;
        }
    }, [currentRoadGroupRing]);

    const cancelChinaMapTransition = useCallback(() => {
        if (chinaMapRevealTimerRef.current !== null) {
            window.clearTimeout(chinaMapRevealTimerRef.current);
            chinaMapRevealTimerRef.current = null;
        }
        chinaMapPrepareRunRef.current += 1;
        setIsPreparingChinaMap(false);
        setIsRevealingChinaMap(false);
        setIsChinaMapVisualReady(false);
        setIsChinaMapDataReady(false);
    }, []);

    const cancelRoadMapTransition = useCallback(() => {
        if (roadMapRevealTimerRef.current !== null) {
            window.clearTimeout(roadMapRevealTimerRef.current);
            roadMapRevealTimerRef.current = null;
        }
        roadMapPrepareRunRef.current += 1;
        skipNextRoadMapRefreshRef.current = false;
        setIsPreparingRoadMap(false);
        setIsRevealingRoadMap(false);
        setIsRoadMapVisualReady(false);
        setIsRoadMapDataReady(false);
    }, []);

    const handleCityRaise = useCallback((cityName: string) => {
        mapRef.current?.riseCity(cityName);
    }, []);

    const handleCityFall = useCallback((cityName: string) => {
        mapRef.current?.fallCity(cityName);
    }, []);

    const syncRoadRoute = useCallback((route: ActiveRoute) => {
        roadMapRef.current?.addRoadPath(route.lineId, route.coordinates, {
            plate: route.plate,
            cargo: route.cargo,
            from: route.from,
            to: route.to,
            status: route.status,
            speedKmh: route.speedKmh,
            routeLengthKm: route.routeLengthKm,
        });
    }, []);

    const renderTruckPosition = useCallback((route: ActiveRoute, now: number) => {
        roadMapRef.current?.updateTruckPosition(route.lineId, predictedPosition(route, now), {
            plate: route.plate,
            cargo: route.cargo,
            from: route.from,
            to: route.to,
            status: route.status,
            speedKmh: route.speedKmh,
            routeLengthKm: route.routeLengthKm,
        });
    }, []);

    const createActiveRoute = useCallback(
        (message: RoadPathMessage): ActiveRoute | null => {
            if (!message.coordinates || message.coordinates.length < 2) return null;


            const now = performance.now();
            const existing = activeRoutesRef.current.get(message.lineId);
            const fallbackDuration = Math.max(
                POSITION_QUERY_INTERVAL_MS * 2,
                message.travelDurationMs ?? 14_000 + (hashText(message.lineId) % 9_000)
            );
            const totalPathLength = pathLength(message.coordinates);
            const routeLengthKm = message.routeLengthKm ?? pathLengthKm(message.coordinates);
            const speedKmh = message.speedKmh ?? existing?.speedKmh ?? null;

            if (existing) {
                const currentPosition = predictedPosition(existing, now);
                const updated: ActiveRoute = {
                    ...existing,
                    orderId: message.orderId ?? existing.orderId,
                    orderName: message.orderName ?? existing.orderName,
                    orderTotalTons: message.orderTotalTons ?? existing.orderTotalTons,
                    orderVehicleCount: message.orderVehicleCount ?? existing.orderVehicleCount,
                    pathKey: message.pathKey ?? existing.pathKey,
                    from: message.from ?? existing.from,
                    to: message.to ?? existing.to,
                    fromCoords: message.coordinates[0],
                    toCoords: message.coordinates[message.coordinates.length - 1],
                    routeLengthKm,
                    fallbackDuration,
                    coordinates: message.coordinates,
                    calibratedAt: now,
                    calibratedDistance: projectDistanceOnPath(message.coordinates, currentPosition),
                    pathLength: totalPathLength,
                    speedKmh,
                    arrivalCheckRequested: false,
                };
                activeRoutesRef.current.set(updated.lineId, updated);
                return updated;
            }
            const cachedPosition = loadTruckPositionsFromCache()
                .find((item) => item.lineId === message.lineId);

            const initialDistance = cachedPosition
                ? projectDistanceOnPath(message.coordinates, cachedPosition.position)
                : 0;

            const route: ActiveRoute = {
                lineId: message.lineId,
                orderId: message.orderId,
                orderName: message.orderName,
                orderTotalTons: message.orderTotalTons,
                orderVehicleCount: message.orderVehicleCount,
                pathKey: message.pathKey,
                from: message.from ?? '起点',
                to: message.to ?? '目的地',
                fromCoords: message.coordinates[0],
                toCoords: message.coordinates[message.coordinates.length - 1],
                routeLengthKm,
                plate: buildPlate(message.lineId),
                cargo: buildCargo(message.lineId),
                status: cachedPosition?.status ?? '运输中',
                startedAt: now,
                fallbackDuration,
                coordinates: message.coordinates,
                calibratedAt: now,
                calibratedDistance: initialDistance,
                pathSpeed: totalPathLength / fallbackDuration,
                pathLength: totalPathLength,
                speedKmh: cachedPosition?.speedKmh ?? speedKmh,
                arrivalCheckRequested: false,

                // 关键：刚进入页面后立刻请求后端真实位置
                nextCalibrationAt: now,
            };

            route.nextCalibrationAt = now + initialPositionQueryDelay(message.lineId);
            activeRoutesRef.current.set(route.lineId, route);
            return route;
        },
        []
    );

    const showRoutes = useCallback(
        (routes: ActiveRoute[]) => {
            const now = performance.now();
            routes.forEach((route) => {
                syncRoadRoute(route);
                renderTruckPosition(route, now);
            });
        },
        [renderTruckPosition, syncRoadRoute]
    );

    const fetchRoadGroups = useCallback(async () => {
        const response = await fetch(`${API_BASE_URL}/road/groups?strategy=${encodeURIComponent(roadGroupStrategy)}`);
        if (!response.ok) throw new Error(`Groups request failed: ${response.status}`);
        const data = await response.json() as RoadGroupsResponse;
        const groups = data.groups ?? [];
        roadGroupRingsRef.current.set(roadGroupStrategy, createRoadGroupRing());
        roadGroupSummariesByStrategyRef.current.set(roadGroupStrategy, new Map());
        roadGroupRouteIdsByStrategyRef.current.set(roadGroupStrategy, new Map());
        syncRoadGroupRing(groups);
        setRoadGroups(groups);
        return groups;
    }, [roadGroupStrategy, syncRoadGroupRing]);

    const prefetchRoutePositions = useCallback(async (routes: ActiveRoute[]) => {
        await Promise.all(routes.map(async (route) => {
            if (positionRequestsRef.current.has(route.lineId)) return;
            positionRequestsRef.current.add(route.lineId);
            try {
                const response = await fetch(`${API_BASE_URL}/road/routes/${encodeURIComponent(route.lineId)}/position`);
                if (!response.ok) throw new Error(`Position request failed: ${response.status}`);
                const message = await response.json() as TruckPositionMessage;
                if (message.status === 'finished') {
                    completedRouteIdsRef.current.add(route.lineId);
                    return;
                }
                if (!message.position) return;
                const now = performance.now();
                applyTruckPositionToRoute(route, message, now);
                saveTruckPositionToCache({
                    lineId: message.lineId,
                    position: message.position,
                    status: message.status,
                    speedKmh: route.speedKmh,
                    updatedAt: new Date().toISOString(),
                });
            } catch (error) {
                console.warn('Truck position prefetch failed', error);
                route.nextCalibrationAt = performance.now() + initialPositionQueryDelay(route.lineId);
            } finally {
                positionRequestsRef.current.delete(route.lineId);
            }
        }));
        return routes.filter((route) => !completedRouteIdsRef.current.has(route.lineId));
    }, []);

    const loadRoadGroup = useCallback(
        async (groupId: string) => {
            if (roadGroupLoadingRef.current) return false;
            roadGroupLoadingRef.current = true;
            setIsLoadingRoadGroup(true);
            try {
                const response = await fetch(`${API_BASE_URL}/road/groups/${encodeURIComponent(groupId)}/routes?strategy=${encodeURIComponent(roadGroupStrategy)}`);
                if (!response.ok) throw new Error(`Group routes request failed: ${response.status}`);
                const data = await response.json() as RoadGroupRoutesResponse;
                const loadedGroupId = data.groupId || groupId;
                const isSameGroup = activeRoadGroupIdRef.current === loadedGroupId;
                const previousIds = new Set(activeRoutesRef.current.keys());
                let routes = (data.routes ?? [])
                    .map(createActiveRoute)
                    .filter((route): route is ActiveRoute => Boolean(route));
                const shouldAnimateGroupSwap =
                    view === 'roadMap' &&
                    isSameGroup === false &&
                    activeRoutesRef.current.size > 0;

                if (!isSameGroup) {
                    routes = await prefetchRoutePositions(routes);
                }

                if (routes.length === 0) {
                    removeRoadGroupFromRing(loadedGroupId);
                    if (activeRoadGroupIdRef.current === loadedGroupId) {
                        activeRoutesRef.current.clear();
                        roadMapRef.current?.clearRoads();
                        setRouteOrders([]);
                    }
                    return false;
                }

                const routeIds = new Set(routes.map((route) => route.lineId));
                currentRoadGroupRouteIds().set(loadedGroupId, routeIds);
                routes.forEach((route) => {
                    routeGroupIdRef.current.set(route.lineId, loadedGroupId);
                    completedRouteIdsRef.current.delete(route.lineId);
                });

                const visibleRoutes = isSameGroup
                    ? mergeVisibleRouteOrders(routeOrdersRef.current, routes, completedRouteIdsRef.current)
                    : routes;

                activeRoutesRef.current = new Map(routes.map((route) => [route.lineId, route]));
                setCurrentRoadGroup(loadedGroupId);
                routeOrdersRef.current = visibleRoutes;
                setRouteOrders(visibleRoutes);

                const nextIds = new Set(routes.map((route) => route.lineId));
                if (!isSameGroup) {
                    if (shouldAnimateGroupSwap) {
                        setIsRoadGroupFading(true);
                        await waitMs(ROAD_GROUP_SWAP_DELAY_MS);
                    }
                    roadMapRef.current?.clearRoads();
                    showRoutes(routes);
                    if (shouldAnimateGroupSwap) {
                        window.requestAnimationFrame(() => setIsRoadGroupFading(false));
                    }
                    return true;
                }

                previousIds.forEach((lineId) => {
                    if (!nextIds.has(lineId)) {
                        roadMapRef.current?.removeRoadPath(lineId);
                    }
                });

                const now = performance.now();
                routes.forEach((route) => {
                    if (!previousIds.has(route.lineId)) {
                        syncRoadRoute(route);
                    }
                    renderTruckPosition(route, now);
                });
                return true;
            } catch (error) {
                console.warn('Road group load failed', error);
                return false;
            } finally {
                roadGroupLoadingRef.current = false;
                setIsLoadingRoadGroup(false);
            }
        },
        [createActiveRoute, currentRoadGroupRouteIds, prefetchRoutePositions, removeRoadGroupFromRing, renderTruckPosition, roadGroupStrategy, setCurrentRoadGroup, showRoutes, syncRoadRoute, view]
    );

    const refreshRoadGroups = useCallback(
        async (preferredGroupId?: string) => {
            if (roadGroupRefreshInFlightRef.current || roadGroupLoadingRef.current) {
                queuedRoadGroupRefreshIdRef.current = preferredGroupId ?? null;
                return;
            }
            roadGroupRefreshInFlightRef.current = true;
            try {
                const groups = await fetchRoadGroups();
                const currentGroupId = activeRoadGroupIdRef.current;
                const nextGroupId = preferredGroupId
                    ?? (currentGroupId && groups.some((group) => group.groupId === currentGroupId) ? currentGroupId : groups[0]?.groupId);

                if (nextGroupId) {
                    await loadRoadGroup(nextGroupId);
                } else {
                    activeRoutesRef.current.clear();
                    roadMapRef.current?.clearRoads();
                    setRouteOrders([]);
                    setCurrentRoadGroup(null);
                }
            } catch (error) {
                console.warn('Road groups refresh failed', error);
            } finally {
                roadGroupRefreshInFlightRef.current = false;
                const queuedGroupId = queuedRoadGroupRefreshIdRef.current;
                queuedRoadGroupRefreshIdRef.current = undefined;
                if (queuedGroupId !== undefined) {
                    window.setTimeout(() => {
                        void refreshRoadGroups(queuedGroupId ?? undefined);
                    }, 120);
                }
            }
        },
        [fetchRoadGroups, loadRoadGroup, setCurrentRoadGroup]
    );

    const scheduleRoadGroupRefresh = useCallback(
        (preferredGroupId?: string | null, delay = 600) => {
            if (preferredGroupId) {
                pendingRoadGroupRefreshIdRef.current = preferredGroupId;
            }
            if (roadPathRefreshTimerRef.current !== null) {
                window.clearTimeout(roadPathRefreshTimerRef.current);
            }
            roadPathRefreshTimerRef.current = window.setTimeout(() => {
                roadPathRefreshTimerRef.current = null;
                const pendingGroupId = pendingRoadGroupRefreshIdRef.current;
                pendingRoadGroupRefreshIdRef.current = undefined;
                void refreshRoadGroups(activeRoadGroupIdRef.current ?? pendingGroupId);
            }, delay);
        },
        [refreshRoadGroups]
    );

    const handleRoadPath = useCallback(
        (message: RoadPathMessage) => {
            scheduleRoadGroupRefresh(message.groupId);
        },
        [scheduleRoadGroupRefresh]
    );

    const advanceRoadGroup = useCallback(async () => {
        const ring = currentRoadGroupRing();
        if (!ring.head || roadGroupLoadingRef.current) return;
        if (ring.nodes.size <= 1) return;

        let candidate = ring.current?.next ?? ring.head;
        const maxAttempts = Math.max(1, ring.nodes.size);
        for (let attempt = 0; candidate && attempt < maxAttempts; attempt++) {
            const groupId = candidate.groupId;
            const nextCandidate = candidate.next ?? ring.head;

            if (isRoadGroupComplete(groupId)) {
                removeRoadGroupFromRing(groupId);
                candidate = nextCandidate;
                continue;
            }

            const hasLiveRoutes = await loadRoadGroup(groupId);
            if (hasLiveRoutes) return;
            candidate = nextCandidate;
        }
    }, [currentRoadGroupRing, isRoadGroupComplete, loadRoadGroup, removeRoadGroupFromRing]);

    const finishRoute = useCallback((lineId: string) => {
        completedRouteIdsRef.current.add(lineId);
        activeRoutesRef.current.delete(lineId);
        roadMapRef.current?.removeRoadPath(lineId);
        setRouteOrders((prev) =>
            prev.map((item) => (item.lineId === lineId ? {...item, status: '已完成'} : item))
        );
    }, []);

    const handleRouteRaise = useCallback((_order: RouteOrder) => {
        // 城市飞线事件由 ChinaMap3D 处理；道路级地图只加载后端分组后的路线。
    }, []);

    const handleTruckPosition = useCallback(
        (message: TruckPositionMessage, forceCalibration = false) => {
            const route = activeRoutesRef.current.get(message.lineId);
            if (!route) return;

            if (message.status === 'finished') {
                finishRoute(message.lineId);
                return;
            }

            const now = performance.now();
            if (!forceCalibration && now < route.nextCalibrationAt) return;

            applyTruckPositionToRoute(route, message, now);

            saveTruckPositionToCache({
                lineId: message.lineId,
                position: message.position,
                status: message.status,
                speedKmh: route.speedKmh,
                updatedAt: new Date().toISOString(),
            });

            renderTruckPosition(route, now);
            setRouteOrders((prev) => {
                const next = prev.map((item) => (item.lineId === route.lineId ? {
                    ...item,
                    ...routeProgressPatch(route, now),
                } : item));
                routeOrdersRef.current = next;
                return next;
            });
        },
        [finishRoute, renderTruckPosition]
    );

    const requestTruckPosition = useCallback(
        async (lineId: string) => {
            if (positionRequestsRef.current.has(lineId)) return;
            positionRequestsRef.current.add(lineId);
            try {
                const response = await fetch(`${API_BASE_URL}/road/routes/${encodeURIComponent(lineId)}/position`);
                if (!response.ok) throw new Error(`Position request failed: ${response.status}`);
                handleTruckPosition(await response.json(), true);
            } catch (error) {
                console.warn('Truck position request failed', error);
                const route = activeRoutesRef.current.get(lineId);
                if (route) {
                    route.arrivalCheckRequested = false;
                    route.nextCalibrationAt = performance.now() + POSITION_QUERY_INTERVAL_MS;
                }
            } finally {
                positionRequestsRef.current.delete(lineId);
            }
        },
        [handleTruckPosition]
    );

    const requestViewChange = useCallback((nextView: ViewMode) => {
        setWarehouseFocus(null);
        if (nextView === 'chinaMap') {
            if (view === 'chinaMap' || isPreparingChinaMap || isRevealingChinaMap) return;
            cancelRoadMapTransition();
            chinaMapPrepareRunRef.current += 1;
            setIsPreparingChinaMap(true);
            setIsRevealingChinaMap(false);
            setIsChinaMapVisualReady(false);
            setIsChinaMapDataReady(false);
            setChinaMapSession((session) => session + 1);
            return;
        }

        if (nextView === 'roadMap') {
            if (view === 'roadMap' || isPreparingRoadMap || isRevealingRoadMap) return;
            cancelChinaMapTransition();
            roadMapPrepareRunRef.current += 1;
            skipNextRoadMapRefreshRef.current = false;
            setIsPreparingRoadMap(true);
            setIsRevealingRoadMap(false);
            setIsRoadMapVisualReady(false);
            setIsRoadMapDataReady(false);
            setRoadMapSession((session) => session + 1);
            return;
        }

        cancelChinaMapTransition();
        cancelRoadMapTransition();
        setView(nextView);
    }, [
        cancelChinaMapTransition,
        cancelRoadMapTransition,
        isPreparingChinaMap,
        isPreparingRoadMap,
        isRevealingChinaMap,
        isRevealingRoadMap,
        view,
    ]);

    const requestDispatch = useCallback(async () => {
        if (isDispatching) return;
        setIsDispatching(true);
        requestViewChange('roadMap');
        try {
            const response = await fetch(`${API_BASE_URL}/road/dispatch`, {method: 'POST'});
            if (!response.ok) throw new Error(`Dispatch failed: ${response.status}`);
            const route = await response.json() as RoadPathMessage;
            await refreshRoadGroups(activeRoadGroupIdRef.current ?? route.groupId);
        } catch (error) {
            console.warn('Route dispatch failed', error);
        } finally {
            setIsDispatching(false);
        }
    }, [isDispatching, refreshRoadGroups, requestViewChange]);

    const requestBulkDispatch = useCallback(async () => {
        if (isDispatching) return;
        setIsDispatching(true);
        try {
            const response = await fetch(`${API_BASE_URL}/road/dispatch/bulk?vehicleCount=24`, {method: 'POST'});
            if (response.status === 404) {
                // 后端未重启或暂未部署大宗订单接口时，退回普通调度兜底，避免按钮不可用。
                // 注意：兜底模式不具备“同一订单多车”的业务语义，只用于临时演示。
                for (let i = 0; i < 8; i++) {
                    await fetch(`${API_BASE_URL}/road/dispatch`, {method: 'POST'});
                }
            } else {
                if (!response.ok) throw new Error(`Bulk dispatch failed: ${response.status}`);
                await response.json();
            }
            // 大宗订单只是向后端追加一批路线；只有当前已经在道路地图时才刷新显示，不主动切换视图。
            if (view === 'roadMap') {
            }
        } catch (error) {
            console.warn('Bulk route dispatch failed', error);
        } finally {
            setIsDispatching(false);
        }
    }, [isDispatching]);


    const handleWarehouseUpdate = useCallback((cityName: string, action: string, displayData: Record<string, any>) => {
        console.log('🏗️ 处理仓库更新:', cityName, action, displayData);
        const hasDisplayData = Boolean(displayData && Object.keys(displayData).length > 0);
        if (action !== 'fall' || hasDisplayData) {
            warehouseDisplayDataRef.current.set(cityName, displayData ?? {});
            mapRef.current?.riseCity(cityName);
            mapRef.current?.updateCityData(cityName, displayData);
        } else if (action === 'fall') {
            warehouseDisplayDataRef.current.delete(cityName);
            mapRef.current?.fallCity(cityName);
            mapRef.current?.updateCityData(cityName, null);
        }
    }, []);

    const handleWarehouseTourStateChange = useCallback((state: {
        mode: 'overview' | 'focus';
        cityName?: string;
        displayData?: Record<string, any>
    }) => {
        if (state.mode !== 'focus' || !state.cityName) {
            setWarehouseFocus(null);
            return;
        }

        setWarehouseFocus({
            cityName: state.cityName,
            displayData: state.displayData ?? warehouseDisplayDataRef.current.get(state.cityName) ?? {},
        });
    }, []);

    const handleCameraControl = useCallback((cityNames: string[], mode: string) => {
        // 仓库地图进入时使用前端本地巡航流程；后端 camera_control 先保留接入点，避免打断巡航。
        void cityNames;
        void mode;
    }, []);
    const handleWarehouseFocus = useCallback((cityName: string, panels: WarehouseFocusPanel[], style?: WarehouseFocusStyle) => {
        mapRef.current?.showCityPanels(cityName, panels, style);
    }, []);

    const waitForChinaMapReady = useCallback(async () => {
        const startedAt = performance.now();
        while (!mapRef.current?.isReady()) {
            if (performance.now() - startedAt > 2500) return false;
            await waitFrame();
        }
        await waitFrame();
        return true;
    }, []);

    const handleChinaMapVisualReady = useCallback(() => {
        setIsChinaMapVisualReady(true);
    }, []);

    const handleRoadMapVisualReady = useCallback(() => {
        setIsRoadMapVisualReady(true);
    }, []);

    const requestRoadMapSnapshot = useCallback(async (prepareRunId: number) => {
        try {
            await refreshRoadGroups(activeRoadGroupIdRef.current ?? undefined);
            if (roadMapPrepareRunRef.current !== prepareRunId) return;
            skipNextRoadMapRefreshRef.current = true;
            setIsRoadMapDataReady(true);
        } catch (error) {
            console.warn('Road map prepare failed', error);
            if (roadMapPrepareRunRef.current === prepareRunId) {
                setIsPreparingRoadMap(false);
                setIsRevealingRoadMap(false);
                setIsRoadMapDataReady(false);
            }
        }
    }, [refreshRoadGroups]);

    const requestWarehouseSnapshot = useCallback(async (prepareRunId: number) => {
        try {
            // 1. 推送仓库快照，让所有城市升起
            const response = await fetch(`${API_BASE_URL}/warehouse/snapshot/push`, {method: 'POST'});
            if (!response.ok) throw new Error(`Warehouse snapshot request failed: ${response.status}`);
            const messages = await response.json() as Array<{
                cityName: string;
                action: string;
                displayData: Record<string, any>;
            }>;
            messages.forEach((message) => {
                handleWarehouseUpdate(message.cityName, message.action, message.displayData);
            });

            const foshanName = '佛山市';
            const uniqueCities = Array.from(new Set([
                foshanName,
                ...messages.map((message) => message.cityName),
            ]));

            uniqueCities.forEach((city) => {
                fetch(`${API_BASE_URL}/warehouse/focus/${encodeURIComponent(city)}`)
                    .then((res) => {
                        if (!res.ok) throw new Error(`Warehouse focus request failed: ${res.status}`);
                        return res.json();
                    })
                    .then((focusMessage: { cityName: string; panels: PanelData[]; style?: WarehouseFocusStyle }) => {
                        const targetCity = focusMessage.cityName || city;
                        const panels = focusMessage.panels ?? [];
                        mapRef.current?.cacheCityPanels(targetCity, panels, focusMessage.style);
                    })
                    .catch(err => console.warn(`${city} 面板预加载失败`, err));
            });

            // 到这里说明 ChinaMap3D 已经挂载、仓库快照已经进入地图；再等 Three mesh 就绪后释放旧视图。
            await waitForChinaMapReady();
            if (chinaMapPrepareRunRef.current !== prepareRunId) return;

            // 先在隐藏状态下启动巡游，避开 Three 首帧/巡游起步阶段可能出现的黑底。
            window.requestAnimationFrame(() => {
                mapRef.current?.startWarehouseTour();
            });
            setIsChinaMapDataReady(true);
        } catch (error) {
            console.warn('Warehouse snapshot request failed', error);
            if (chinaMapPrepareRunRef.current === prepareRunId) {
                setIsPreparingChinaMap(false);
                setIsRevealingChinaMap(false);
                setIsChinaMapDataReady(false);
            }
        }
    }, [handleWarehouseUpdate, waitForChinaMapReady]);

    useDashboardRealtime({
        onCityRaise: handleCityRaise,
        onCityFall: handleCityFall,
        onRouteRaise: handleRouteRaise,
        onRouteFall: finishRoute,
        onRoadPath: handleRoadPath,
        onTruckPosition: handleTruckPosition,
        onWarehouseUpdate: handleWarehouseUpdate,
        onWarehouseFocus: handleWarehouseFocus,
        onCameraControl: handleCameraControl,
    });

    useEffect(() => {
        if (view !== 'roadMap') return;
        if (skipNextRoadMapRefreshRef.current) {
            skipNextRoadMapRefreshRef.current = false;
            return;
        }
        void refreshRoadGroups(activeRoadGroupIdRef.current ?? undefined);
    }, [refreshRoadGroups, view]);

    useEffect(() => {
        if (view !== 'roadMap') return;
        if (roadGroups.length <= 1) return;

        const currentGroup = activeRoadGroupIdRef.current
            ? currentRoadGroupSummaries().get(activeRoadGroupIdRef.current)
            : null;
        const routeCount = currentGroup?.count ?? routeOrdersRef.current.length;
        const delay = roadGroupDisplayMs(routeCount);

        roadGroupAdvanceTimerRef.current = window.setTimeout(() => {
            roadGroupAdvanceTimerRef.current = null;
            void advanceRoadGroup().finally(() => {
                setRoadGroupAdvanceTick((tick) => tick + 1);
            });
        }, delay);

        return () => {
            if (roadGroupAdvanceTimerRef.current !== null) {
                window.clearTimeout(roadGroupAdvanceTimerRef.current);
                roadGroupAdvanceTimerRef.current = null;
            }
        };
    }, [activeRoadGroupId, advanceRoadGroup, currentRoadGroupSummaries, roadGroupAdvanceTick, roadGroups, routeOrders.length, view]);

    useEffect(() => {
        if (!isPreparingChinaMap) return;
        if (chinaMapSession <= 0) return;
        void requestWarehouseSnapshot(chinaMapPrepareRunRef.current);
    }, [chinaMapSession, isPreparingChinaMap, requestWarehouseSnapshot]);

    useEffect(() => {
        if (!isPreparingRoadMap || !isRoadMapVisualReady || roadMapSession <= 0) return;
        void requestRoadMapSnapshot(roadMapPrepareRunRef.current);
    }, [isPreparingRoadMap, isRoadMapVisualReady, requestRoadMapSnapshot, roadMapSession]);

    useEffect(() => {
        if (!isPreparingChinaMap || !isChinaMapVisualReady || !isChinaMapDataReady || isRevealingChinaMap) return;
        const prepareRunId = chinaMapPrepareRunRef.current;

        setIsRevealingChinaMap(true);
        chinaMapRevealTimerRef.current = window.setTimeout(() => {
            if (chinaMapPrepareRunRef.current !== prepareRunId) return;
            setView('chinaMap');
            setIsPreparingChinaMap(false);
            setIsRevealingChinaMap(false);
            setIsChinaMapDataReady(false);
            chinaMapRevealTimerRef.current = null;
        }, MAP_VIEW_RELEASE_DELAY_MS);
    }, [isChinaMapDataReady, isChinaMapVisualReady, isPreparingChinaMap, isRevealingChinaMap]);

    useEffect(() => {
        if (!isPreparingRoadMap || !isRoadMapVisualReady || !isRoadMapDataReady || isRevealingRoadMap) return;
        const prepareRunId = roadMapPrepareRunRef.current;

        setIsRevealingRoadMap(true);
        roadMapRevealTimerRef.current = window.setTimeout(() => {
            if (roadMapPrepareRunRef.current !== prepareRunId) return;
            setView('roadMap');
            setIsPreparingRoadMap(false);
            setIsRevealingRoadMap(false);
            setIsRoadMapDataReady(false);
            roadMapRevealTimerRef.current = null;
        }, MAP_VIEW_RELEASE_DELAY_MS);
    }, [isPreparingRoadMap, isRevealingRoadMap, isRoadMapDataReady, isRoadMapVisualReady]);

    useEffect(() => {
        return () => {
            if (chinaMapRevealTimerRef.current !== null) {
                window.clearTimeout(chinaMapRevealTimerRef.current);
                chinaMapRevealTimerRef.current = null;
            }
            if (roadMapRevealTimerRef.current !== null) {
                window.clearTimeout(roadMapRevealTimerRef.current);
                roadMapRevealTimerRef.current = null;
            }
            if (roadPathRefreshTimerRef.current !== null) {
                window.clearTimeout(roadPathRefreshTimerRef.current);
                roadPathRefreshTimerRef.current = null;
            }
            if (roadGroupAdvanceTimerRef.current !== null) {
                window.clearTimeout(roadGroupAdvanceTimerRef.current);
                roadGroupAdvanceTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (view !== 'roadMap') return;
        const replayTimer = window.setTimeout(() => {
            const now = performance.now();
            roadMapRef.current?.clearRoads();
            activeRoutesRef.current.forEach((route) => {
                syncRoadRoute(route);
                renderTruckPosition(route, now);
            });
        }, 0);

        return () => window.clearTimeout(replayTimer);
    }, [renderTruckPosition, syncRoadRoute, view]);

    useEffect(() => {
        const timer = window.setInterval(() => {
            const now = performance.now();
            const progressUpdates = new Map<string, ReturnType<typeof routeProgressPatch>>();
            activeRoutesRef.current.forEach((route) => {
                renderTruckPosition(route, now);
                progressUpdates.set(route.lineId, routeProgressPatch(route, now));
                const reachedPredictedEnd = route.pathLength > 0 && predictedDistance(route, now) >= route.pathLength - 0.0001;
                if (reachedPredictedEnd && !route.arrivalCheckRequested) {
                    route.arrivalCheckRequested = true;
                    route.nextCalibrationAt = now;
                    void requestTruckPosition(route.lineId);
                    return;
                }

                if (now >= route.nextCalibrationAt) {
                    void requestTruckPosition(route.lineId);
                }
            });
            if (progressUpdates.size > 0) {
                setRouteOrders((prev) => {
                    let changed = false;
                    const next = prev.map((item) => {
                        const update = progressUpdates.get(item.lineId);
                        if (!update) return item;
                        changed = true;
                        return {...item, ...update};
                    });
                    if (!changed) return prev;
                    routeOrdersRef.current = next;
                    return next;
                });
            }
        }, POSITION_RENDER_TICK_MS);

        return () => window.clearInterval(timer);
    }, [renderTruckPosition, requestTruckPosition]);

    const renderCenterPanel = () => {
        const showChinaMapLayer = view === 'chinaMap' || isPreparingChinaMap || isRevealingChinaMap;
        const isChinaMapLeaving = view === 'chinaMap' && isRevealingRoadMap;
        const isChinaMapVisible = (view === 'chinaMap' && !isChinaMapLeaving) || isRevealingChinaMap;
        const showRoadMapLayer = view === 'roadMap' || isPreparingRoadMap || isRevealingRoadMap;
        const isRoadMapLeaving = view === 'roadMap' && isRevealingChinaMap;
        const isRoadGroupTransition = view === 'roadMap' && !isPreparingRoadMap && !isRevealingRoadMap;
        const isRoadMapVisible = ((view === 'roadMap' && !isRoadMapLeaving) || isRevealingRoadMap) && !isRoadGroupFading;
        const roadMapTransitionMs = isRoadGroupTransition ? ROAD_GROUP_TRANSITION_MS : MAP_VIEW_TRANSITION_MS;

        return (
            <>
                {view === 'warehouse' && (
                    <div className="absolute inset-0">
                        <Warehouse3D key="warehouse"/>
                    </div>
                )}
                {showRoadMapLayer && (
                    <div
                        className={`absolute inset-0 transition-opacity ${
                            isRoadMapVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
                        } ${isPreparingRoadMap || isRevealingRoadMap ? 'z-20' : 'z-10'}`}
                        style={{
                            transitionDuration: `${roadMapTransitionMs}ms`,
                            transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                        }}
                    >
                        <RoadMap3D
                            key={`roadMap-${roadMapSession}`}
                            ref={roadMapRef}
                            onVisualReady={handleRoadMapVisualReady}
                        />
                    </div>
                )}
                {showChinaMapLayer && (
                    <div
                        className={`absolute inset-0 transition-opacity ${
                            isChinaMapVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
                        } ${isPreparingChinaMap || isRevealingChinaMap ? 'z-20' : 'z-10'}`}
                        style={{
                            transitionDuration: `${MAP_VIEW_TRANSITION_MS}ms`,
                            transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                        }}
                    >
                        <ChinaMap3D
                            key={`chinaMap-${chinaMapSession}`}
                            ref={mapRef}
                            onVisualReady={handleChinaMapVisualReady}
                            onTourStateChange={handleWarehouseTourStateChange}
                        />
                    </div>
                )}
            </>
        );
    };

    const viewButtons = (
        <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 gap-2">
            {[
                ['warehouse', '仓库视图'],
                ['chinaMap', '数字孪生地图'],
                ['roadMap', '道路级地图'],
            ].map(([mode, label]) => (
                <button
                    key={mode}
                    onClick={() => requestViewChange(mode as ViewMode)}
                    className={`rounded-full border px-4 py-2 text-xs shadow-lg backdrop-blur-md transition-all pointer-events-auto ${
                        view === mode ||
                        (mode === 'chinaMap' && (isPreparingChinaMap || isRevealingChinaMap)) ||
                        (mode === 'roadMap' && (isPreparingRoadMap || isRevealingRoadMap))
                            ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-300'
                            : 'border-white/10 bg-white/10 text-gray-400 hover:bg-white/20'
                    }`}
                >
                    {mode === 'chinaMap' && (isPreparingChinaMap || isRevealingChinaMap)
                        ? '数字孪生准备中...'
                        : mode === 'roadMap' && (isPreparingRoadMap || isRevealingRoadMap)
                            ? '道路地图准备中...'
                            : label}
                </button>
            ))}
        </div>
    );

    const roadGroupQueue = view === 'roadMap' && roadGroups.length > 0 && (
        <div
            className="no-scrollbar absolute left-4 top-4 z-40 flex max-w-[calc(100%-2rem)] gap-2 overflow-x-auto rounded-md border border-white/10 bg-slate-950/65 p-2 text-xs text-slate-300 shadow-xl backdrop-blur-md pointer-events-auto">
            {roadGroups.map((group) => (
                <button
                    key={group.groupId}
                    onClick={() => void loadRoadGroup(group.groupId)}
                    disabled={isLoadingRoadGroup && activeRoadGroupId === group.groupId}
                    className={`shrink-0 rounded border px-3 py-1.5 transition-all ${
                        activeRoadGroupId === group.groupId
                            ? 'border-cyan-300/50 bg-cyan-400/15 text-cyan-100'
                            : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                    }`}
                >
                    第 {group.index + 1} 组 · {group.count} 条
                </button>
            ))}
        </div>
    );

    const dispatchButton = view === 'roadMap' && (
        <button
            onClick={requestDispatch}
            disabled={isDispatching}
            className="absolute bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-200 shadow-lg backdrop-blur-md transition-all pointer-events-auto hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
            {isDispatching ? '调度中...' : '发起车辆调度'}
        </button>
    );

    const bulkDispatchButton = view === 'roadMap' && (
        <button
            onClick={requestBulkDispatch}
            disabled={isDispatching}
            className="absolute bottom-20 left-[calc(50%+5.8rem)] z-40 rounded-full border border-cyan-300/30 bg-cyan-400/10 px-4 py-2 text-xs text-cyan-100 shadow-lg backdrop-blur-md transition-all pointer-events-auto hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
            模拟大宗订单
        </button>
    );
    const handleManualQuery = useCallback(async () => {
        const carId = manualCarId.trim();
        if (!carId || isManualQuerying) return;

        setIsManualQuerying(true);
        setManualQueryStatus('查询中...');
        try {
            const res = await fetch(`${API_BASE_URL}/road/routes/query-position`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ carId }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
                throw new Error(data.error || `Manual position query failed: ${res.status}`);
            }
            if (!data.found) {
                setManualQueryStatus('未查询到该车辆位置');
                return;
            }

            roadMapRef.current?.updateTruckPosition(
                `manual-${carId}`,
                [data.lng, data.lat],
                { plate: carId, speedKmh: data.speedKmh, status: '临时查询', manualMarker: true },
            );
            setManualQueryStatus(`经度 ${Number(data.lng).toFixed(5)} / 纬度 ${Number(data.lat).toFixed(5)} / ${Math.round(Number(data.speedKmh) || 0)} km/h`);
        } catch (error) {
            console.error('手动查询失败', error);
            setManualQueryStatus('查询失败，请检查车辆 ID 或后端接口');
        } finally {
            setIsManualQuerying(false);
        }
    }, [isManualQuerying, manualCarId]);

    const manualPositionLookup = view === 'roadMap' && (
        <div className="absolute bottom-36 left-4 z-40 w-[min(24rem,calc(100%-2rem))] rounded-md border border-white/10 bg-slate-950/75 p-2 text-xs text-slate-300 shadow-xl backdrop-blur-md pointer-events-auto">
            <div className="flex gap-2">
                <input
                    type="text"
                    value={manualCarId}
                    onChange={(e) => setManualCarId(e.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            void handleManualQuery();
                        }
                    }}
                    placeholder="输入车辆ID"
                    className="min-w-0 flex-1 rounded border border-white/10 bg-slate-900/80 px-3 py-1.5 text-xs text-white outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-300/45"
                />
                <button
                    onClick={() => void handleManualQuery()}
                    disabled={isManualQuerying || !manualCarId.trim()}
                    className="shrink-0 rounded border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {isManualQuerying ? '查询中' : '查询位置'}
                </button>
            </div>
            {manualQueryStatus && (
                <div className="mt-2 truncate text-[11px] text-slate-400" title={manualQueryStatus}>
                    {manualQueryStatus}
                </div>
            )}
        </div>
    );


    const roadStrategyTabs = view === 'roadMap' && (
        <div
            className="absolute right-[calc(25%+2rem)] top-24 z-50 rounded-full border border-white/10 bg-slate-950/75 p-2 shadow-xl backdrop-blur-md pointer-events-auto">
            <div className="relative flex">
                <span
                    className="absolute top-0 h-8 w-16 rounded-full border border-cyan-300/25 bg-cyan-300/15 shadow-[0_0_18px_rgba(34,211,238,0.18)] transition-transform duration-300"
                    style={{
                        transform: `translateX(${ROAD_GROUP_STRATEGIES.findIndex((item) => item.value === roadGroupStrategy) * 4}rem)`,
                    }}
                />
                {ROAD_GROUP_STRATEGIES.map((item) => (
                    <button
                        key={item.value}
                        onClick={() => {
                            setRoadGroupStrategy(item.value);
                            setCurrentRoadGroup(null);
                            activeRoutesRef.current.clear();
                            routeOrdersRef.current = [];
                            setRouteOrders([]);
                            roadMapRef.current?.clearRoads();
                        }}
                        className={`relative z-10 flex h-8 w-16 items-center justify-center rounded-full text-xs transition-colors ${
                            roadGroupStrategy === item.value ? 'text-cyan-100' : 'text-slate-400 hover:text-slate-100'
                        }`}
                    >
                        {item.label}
                        {item.badge && (
                            <span
                                className="absolute -right-0.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-300 px-1 text-[9px] text-slate-950">
                                {item.badge}
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );

    const activeRoadGroup = activeRoadGroupId
        ? roadGroups.find((group) => group.groupId === activeRoadGroupId) ?? null
        : null;
    const shouldShowRoadPanel = view === 'roadMap' && Boolean(activeRoadGroup);
    const sidePanelMode: 'hidden' | 'warehouse_focus' | 'road_group_focus' =
        view === 'chinaMap' && warehouseFocus
            ? 'warehouse_focus'
            : shouldShowRoadPanel
                ? 'road_group_focus'
                : 'hidden';
    const roadPanelState: RoadGroupPanelState | null = activeRoadGroup
        ? {
            groupId: activeRoadGroup.groupId,
            groupIndex: activeRoadGroup.index,
            groupCount: activeRoadGroup.count,
            groupKey: activeRoadGroup.groupKey,
            groupScenario: activeRoadGroup.groupScenario,
            scenarioReason: activeRoadGroup.scenarioReason,
            orderIds: activeRoadGroup.orderIds,
            routes: routeOrders,
        }
        : null;

    return (
        <MainLayout
            header={<Header/>}
            // leftPanel={<InventoryStats />}
            leftPanel={null}
            centerPanel={
                <div className="relative h-full w-full">
                    {renderCenterPanel()}
                    <DashboardSidePanels
                        mode={sidePanelMode}
                        warehouseFocus={warehouseFocus}
                        roadGroup={roadPanelState}
                    />
                    {roadGroupQueue}
                    {roadStrategyTabs}
                    {viewButtons}
                    {dispatchButton}
                    {bulkDispatchButton}
                    {manualPositionLookup}
                </div>
            }
            rightPanel={null}
            // rightPanel={
            //     <>
            //         <VehicleSchedule routeOrders={routeOrders} />
            //         <TrafficMonitor />
            //     </>
            // }
        />
    );
}

export default DashboardPage;
