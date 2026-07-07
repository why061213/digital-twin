import { useCallback, useEffect, useRef, useState } from 'react';
import MainLayout from '@/components/Layout/MainLayout';
import Header from '@/components/Layout/Header';
import type { ChinaMap3DHandle } from './modules/ChinaMap3D';
import type { RoadMap3DHandle } from './modules/RoadMap3D';
import DashboardSidePanels from './modules/DashboardSidePanels';
import type { WarehouseFocusState, RoadGroupPanelState } from './modules/DashboardSidePanels';
import { useDashboardRealtime } from './hooks/useDashboardRealtime';
import type { RoadPathMessage, RouteOrder, TruckPositionMessage, WarehouseFocusPanel, WarehouseFocusStyle } from './hooks/useDashboardRealtime';
import type { PanelData } from './modules/ChinaMap3D/types';
import { DispatchButtons } from './components/DispatchButtons';
import { DashboardCenterPanel } from './components/DashboardCenterPanel';
import { RoadGroupQueue } from './components/RoadGroupQueue';
import { RoadGroupTabs } from './components/RoadGroupTabs';
import { ViewButtons } from './components/ViewButtons';
import {
    loadTruckPositionsFromCache,
    saveTruckPositionToCache,
} from './modules/RoadMap3D/utils';
import type {
    ActiveRoute,
    RoadGroupNode,
    RoadGroupRing,
    RoadGroupRoutesResponse,
    RoadGroupStrategy,
    RoadGroupSummary,
    RoadGroupsResponse,
    ViewMode,
} from './types';
import {
    API_BASE_URL,
    MAP_VIEW_RELEASE_DELAY_MS,
    POSITION_QUERY_INTERVAL_MS,
    POSITION_RENDER_TICK_MS,
    ROAD_GROUP_SWAP_DELAY_MS,
    roadGroupDisplayMs,
} from './constants';
import {
    applyTruckPositionToRoute,
    buildCargo,
    buildPlate,
    createRoadGroupRing,
    ensureRoadGroupRing,
    hashText,
    initialPositionQueryDelay,
    mergeVisibleRouteOrders,
    pathLength,
    pathLengthKm,
    predictedDistance,
    predictedPosition,
    projectDistanceOnPath,
    routeProgressPatch,
    waitFrame,
    waitMs,
} from './utils';
import {useAppConfig} from "@/pages/Dashboard/hooks/useAppConfig.ts";

const ROAD_PATH_BUFFER_QUIET_MS = 650;
const ROAD_PATH_BUFFER_MAX_WAIT_MS = 1600;

function DashboardPage() {
    // 自动轮播控制
    const chinaMapTourStartedSessionRef = useRef(0);
    const chinaMapLoopTargetRef = useRef(1);
    const autoCarouselStartedRef = useRef(false);
    const noOrderFallbackTimerRef = useRef<number | null>(null);
    const roadGroupsRef = useRef<RoadGroupSummary[]>([]);
    const autoCarouselEnabledRef = useRef(true);
    const roadGroupCycleCountRef = useRef(0);
    const targetCyclesRef = useRef(2);
    const chinaMapDurationMsRef = useRef(30000);
    const chinaMapTimerRef = useRef<number | null>(null);
    const isChinaMapAutoPhaseRef = useRef(false);
    const startChinaMapAutoPhaseRef = useRef<() => void>(() => {});
    const viewRef = useRef<ViewMode>('warehouse');
    const {config: appConfig} = useAppConfig();

    useEffect(() => {
        if (!appConfig) return;

        autoCarouselEnabledRef.current = appConfig.autoCarouselEnabled ?? true;
        targetCyclesRef.current = Math.max(1, appConfig.autoCarouselRoadGroupCycles ?? 2);
        chinaMapLoopTargetRef.current = Math.max(1, appConfig.autoCarouselChinaMapLoops ?? 1);
        chinaMapDurationMsRef.current = Math.max(1000, appConfig.autoCarouselChinaMapDurationMs ?? 30000);
    }, [appConfig]);

    const roadGroupKeepCurrentRefreshRef = useRef(false);
    const roadGroupKeepCurrentEmptyRef = useRef(false);
    const staleRoadGroupFallbackIdRef = useRef<string | null>(null);
    const pendingNextGroupIdRef = useRef<string | null>(null);
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
    const roadPathBufferTimerRef = useRef<number | null>(null);
    const roadPathBufferStartedAtRef = useRef(0);
    const roadPathBroadcastBufferRef = useRef<Map<string, RoadPathMessage>>(new Map());
    const pendingRoadGroupRefreshIdRef = useRef<string | null | undefined>(undefined);
    const roadGroupRefreshInFlightRef = useRef(false);
    const queuedRoadGroupRefreshPendingRef = useRef(false);
    const queuedRoadGroupRefreshIdRef = useRef<string | null | undefined>(undefined);
    const roadGroupAdvanceTimerRef = useRef<number | null>(null);
    const skipNextRoadMapRefreshRef = useRef(false);
    const roadGroupTransitionRunRef = useRef(0);

    useEffect(() => {
        roadGroupsRef.current = roadGroups;
    }, [roadGroups]);

    const updateTargetCycles = useCallback((groupCount: number) => {
        // 组越少循环次数越多，范围 1～5
        const dynamic = Math.max(1, Math.min(5, 6 - groupCount));
        targetCyclesRef.current = dynamic;
        console.log('[autoCarousel] 动态目标循环次数更新为', dynamic, '组数量', groupCount);
    }, []);


    useEffect(() => {
        routeOrdersRef.current = routeOrders;
    }, [routeOrders]);

    useEffect(() => {
        viewRef.current = view;
    }, [view]);

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

    const normalizeRoadGroupRing = useCallback((ring: RoadGroupRing) => {
        const nodes = Array.from(ring.nodes.values());
        if (nodes.length === 0) {
            ring.head = null;
            ring.tail = null;
            ring.current = null;
            return;
        }

        if (!ring.head || !ring.nodes.has(ring.head.groupId)) {
            ring.head = nodes[0];
        }
        if (!ring.current || !ring.nodes.has(ring.current.groupId)) {
            ring.current = ring.head;
        }

        nodes.forEach((node, index) => {
            node.next = nodes[(index + 1) % nodes.length];
        });
        ring.tail = nodes[nodes.length - 1];
        ring.tail.next = ring.head;
    }, []);

    const removeRoadGroupFromRing = useCallback((groupId: string) => {
        const ring = currentRoadGroupRing();
        console.log('[removeRoadGroupFromRing] removing:', groupId, 'head:', ring.head?.groupId, 'current:', ring.current?.groupId);
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
        normalizeRoadGroupRing(ring);
        currentRoadGroupSummaries().delete(groupId);
        currentRoadGroupRouteIds().delete(groupId);
        setRoadGroups((prev) => prev.filter((group) => group.groupId !== groupId));
        if (activeRoadGroupIdRef.current === groupId) {
            activeRoadGroupIdRef.current = null;
            setActiveRoadGroupId(null);
            routeOrdersRef.current = [];
            setRouteOrders([]);
            roadMapRef.current?.clearRoads();
        }
        console.log('[removeRoadGroupFromRing] after remove, head:', ring.head?.groupId, 'current:', ring.current?.groupId);
    }, [currentRoadGroupRing, currentRoadGroupRouteIds, currentRoadGroupSummaries, normalizeRoadGroupRing]);

    const syncRoadGroupRing = useCallback((groups: RoadGroupSummary[]) => {
        const ring = currentRoadGroupRing();
        const summaries = currentRoadGroupSummaries();
        const nextGroupIds = new Set(groups.map((group) => group.groupId));
        Array.from(ring.nodes.keys()).forEach((groupId) => {
            if (!nextGroupIds.has(groupId) && groupId !== activeRoadGroupIdRef.current) {
                removeRoadGroupFromRing(groupId);
            }
        });
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
        normalizeRoadGroupRing(ring);
    }, [currentRoadGroupRing, currentRoadGroupSummaries, normalizeRoadGroupRing, removeRoadGroupFromRing]);

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

    const resetRoadMapPlayback = useCallback((reason: string) => {
        console.log('[resetRoadMapPlayback]', reason);
        if (roadGroupAdvanceTimerRef.current !== null) {
            window.clearTimeout(roadGroupAdvanceTimerRef.current);
            roadGroupAdvanceTimerRef.current = null;
        }
        if (roadPathRefreshTimerRef.current !== null) {
            window.clearTimeout(roadPathRefreshTimerRef.current);
            roadPathRefreshTimerRef.current = null;
        }
        if (roadPathBufferTimerRef.current !== null) {
            window.clearTimeout(roadPathBufferTimerRef.current);
            roadPathBufferTimerRef.current = null;
        }

        roadPathBroadcastBufferRef.current.clear();
        roadPathBufferStartedAtRef.current = 0;
        pendingRoadGroupRefreshIdRef.current = undefined;
        queuedRoadGroupRefreshPendingRef.current = false;
        queuedRoadGroupRefreshIdRef.current = undefined;
        pendingNextGroupIdRef.current = null;
        staleRoadGroupFallbackIdRef.current = null;
        roadGroupKeepCurrentRefreshRef.current = false;
        roadGroupKeepCurrentEmptyRef.current = false;

        activeRoutesRef.current.clear();
        positionRequestsRef.current.clear();
        routeGroupIdRef.current.clear();
        completedRouteIdsRef.current.clear();
        routeOrdersRef.current = [];
        activeRoadGroupIdRef.current = null;

        roadGroupRingsRef.current.set(roadGroupStrategy, createRoadGroupRing());
        roadGroupSummariesByStrategyRef.current.set(roadGroupStrategy, new Map());
        roadGroupRouteIdsByStrategyRef.current.set(roadGroupStrategy, new Map());

        roadMapRef.current?.clearRoads();
        setRouteOrders([]);
        setRoadGroups([]);
        setActiveRoadGroupId(null);
        setIsRoadGroupFading(false);
        setIsLoadingRoadGroup(false);
        setRoadGroupAdvanceTick((tick) => tick + 1);
    }, [roadGroupStrategy]);

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
            orderId: route.orderId,
            orderFamilyId: route.orderFamilyId,
            orderName: route.orderName,
            pathKey: route.pathKey,
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
            orderId: route.orderId,
            orderFamilyId: route.orderFamilyId,
            orderName: route.orderName,
            pathKey: route.pathKey,
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
                    orderFamilyId: message.orderFamilyId ?? existing.orderFamilyId,
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
                orderFamilyId: message.orderFamilyId,
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
            console.trace('[loadRoadGroup] called with:', groupId);
            console.log('[loadRoadGroup] called with:', groupId, 'active before:', activeRoadGroupIdRef.current, 'strategy:', roadGroupStrategy);
            const transitionRunId = roadGroupTransitionRunRef.current + 1;
            roadGroupTransitionRunRef.current = transitionRunId;
            roadGroupLoadingRef.current = true;
            setIsLoadingRoadGroup(true);
            try {
                const response = await fetch(`${API_BASE_URL}/road/groups/${encodeURIComponent(groupId)}/routes?strategy=${encodeURIComponent(roadGroupStrategy)}`);
                if (!response.ok) throw new Error(`Group routes request failed: ${response.status}`);
                const data = await response.json() as RoadGroupRoutesResponse;
                const loadedGroupId = data.groupId || groupId;
                // 注意：isSameGroup 必须在这之后定义，不能提前使用
                const isSameGroup = activeRoadGroupIdRef.current === loadedGroupId;
                const previousIds = new Set(activeRoutesRef.current.keys());
                let routes = (data.routes ?? [])
                    .map(createActiveRoute)
                    .filter((route): route is ActiveRoute => Boolean(route));
                const shouldAnimateGroupSwap =
                    view === 'roadMap' &&
                    activeRoadGroupIdRef.current !== null &&   // 新增：必须已有活跃组
                    isSameGroup === false &&
                    activeRoutesRef.current.size > 0;

                console.log('[loadRoadGroup] loadedGroupId:', loadedGroupId, 'routes:', routes.length, 'isSameGroup:', isSameGroup, 'shouldAnimateGroupSwap:', shouldAnimateGroupSwap);

                if (!isSameGroup) {
                    routes = await prefetchRoutePositions(routes);
                }

                if (routes.length === 0) {
                    // 如果是“保持当前组”的刷新，忽略空结果，避免删除当前组
                    if (roadGroupKeepCurrentRefreshRef.current) {
                        roadGroupKeepCurrentEmptyRef.current = true;
                        console.log('[loadRoadGroup] keep current refresh ignored empty routes');
                        return false;  // 返回 false 表示刷新失败
                    }
                    // 自动选择模式下，允许删除旧组
                    removeRoadGroupFromRing(loadedGroupId);
                    if (activeRoadGroupIdRef.current === loadedGroupId) {
                        activeRoutesRef.current.clear();
                        roadMapRef.current?.clearRoads();
                        setRouteOrders([]);
                        setCurrentRoadGroup(null);
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
                        console.log('[loadRoadGroup] animating swap');
                        await waitMs(ROAD_GROUP_SWAP_DELAY_MS);
                        if (roadGroupTransitionRunRef.current !== transitionRunId) {
                            setIsRoadGroupFading(false);
                            return false;
                        }
                    }
                    roadMapRef.current?.clearRoads();
                    showRoutes(routes);
                    if (shouldAnimateGroupSwap) {
                        window.requestAnimationFrame(() => setIsRoadGroupFading(false));
                    }
                    pendingNextGroupIdRef.current = null;
                    console.log('[loadRoadGroup] loaded new group, done');
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
                setIsRoadGroupFading(false);
            }
        },
        [createActiveRoute, currentRoadGroupRouteIds, prefetchRoutePositions, removeRoadGroupFromRing, renderTruckPosition, roadGroupStrategy, setCurrentRoadGroup, showRoutes, syncRoadRoute, view]
    );

    const refreshRoadGroups = useCallback(
        async (preferredGroupId?: string | null) => {
            const scheduleDebouncedAutoFallback = (staleGroupId: string | null, delay = 300) => {
                staleRoadGroupFallbackIdRef.current = staleGroupId;
                pendingRoadGroupRefreshIdRef.current = undefined;
                if (roadPathRefreshTimerRef.current !== null) {
                    window.clearTimeout(roadPathRefreshTimerRef.current);
                }
                roadPathRefreshTimerRef.current = window.setTimeout(() => {
                    roadPathRefreshTimerRef.current = null;
                    const pendingGroupId = pendingRoadGroupRefreshIdRef.current;
                    pendingRoadGroupRefreshIdRef.current = undefined;
                    void refreshRoadGroups(pendingGroupId);
                }, delay);
            };

            if (roadGroupRefreshInFlightRef.current || roadGroupLoadingRef.current) {
                queuedRoadGroupRefreshPendingRef.current = true;
                queuedRoadGroupRefreshIdRef.current = preferredGroupId;
                return;
            }
            roadGroupRefreshInFlightRef.current = true;
            try {
                // ====== 保持当前组的快速通道 ======
                if (preferredGroupId === null && activeRoadGroupIdRef.current) {
                    const staleGroupId = activeRoadGroupIdRef.current;
                    roadGroupKeepCurrentRefreshRef.current = true;
                    roadGroupKeepCurrentEmptyRef.current = false;
                    const success = await loadRoadGroup(activeRoadGroupIdRef.current);
                    roadGroupKeepCurrentRefreshRef.current = false;
                    if (success) {
                        // 当前组仍然有效，无需切换
                        return;
                    }
                    if (roadGroupKeepCurrentEmptyRef.current) {
                        roadGroupKeepCurrentEmptyRef.current = false;
                        // 当前组已失效（后端返回空），通过同一个防抖入口延迟回退。
                        // 连续路线消息会覆盖旧回退，只让最后一次自动选组生效。
                        scheduleDebouncedAutoFallback(staleGroupId);
                    }
                    return;
                }

                // ====== 自动选择逻辑 ======
                const groups = await fetchRoadGroups();
                const currentGroupId = activeRoadGroupIdRef.current;
                const staleFallbackGroupId = staleRoadGroupFallbackIdRef.current;
                staleRoadGroupFallbackIdRef.current = null;
                let nextGroupId: string | null | undefined;

                if (preferredGroupId !== undefined && preferredGroupId !== null) {
                    nextGroupId = preferredGroupId;
                } else if (staleFallbackGroupId && currentGroupId === staleFallbackGroupId) {
                    nextGroupId = groups.find((group) => group.groupId !== staleFallbackGroupId)?.groupId
                        ?? groups[0]?.groupId;
                } else {
                    // 自动选择：优先保持当前组（如果还在列表中），否则取第一个
                    nextGroupId = currentGroupId && groups.some(g => g.groupId === currentGroupId)
                        ? currentGroupId
                        : groups[0]?.groupId;
                }

                if (nextGroupId) {
                    await loadRoadGroup(nextGroupId);
                } else {
                    resetRoadMapPlayback('refresh found no available road groups');
                }
            } catch (error) {
                console.warn('Road groups refresh failed', error);
            } finally {
                roadGroupRefreshInFlightRef.current = false;
                const hasQueuedRefresh = queuedRoadGroupRefreshPendingRef.current;
                const queuedGroupId = queuedRoadGroupRefreshIdRef.current;
                queuedRoadGroupRefreshPendingRef.current = false;
                queuedRoadGroupRefreshIdRef.current = undefined;
                if (hasQueuedRefresh) {
                    window.setTimeout(() => {
                        void refreshRoadGroups(queuedGroupId);
                    }, 120);
                }
            }
        },
        [fetchRoadGroups, loadRoadGroup, resetRoadMapPlayback]
    );

    const scheduleRoadGroupRefresh = useCallback(
        (preferredGroupId?: string | null, delay = 600) => {
            if (preferredGroupId !== undefined) {
                pendingRoadGroupRefreshIdRef.current = preferredGroupId; // 允许 null
            }
            if (roadPathRefreshTimerRef.current !== null) {
                window.clearTimeout(roadPathRefreshTimerRef.current);
            }
            roadPathRefreshTimerRef.current = window.setTimeout(() => {
                roadPathRefreshTimerRef.current = null;
                const pendingGroupId = pendingRoadGroupRefreshIdRef.current;
                pendingRoadGroupRefreshIdRef.current = undefined;
                void refreshRoadGroups(pendingGroupId);
            }, delay);
        },
        [refreshRoadGroups]
    );

    const flushRoadPathBroadcastBuffer = useCallback(() => {
        if (roadPathBufferTimerRef.current !== null) {
            window.clearTimeout(roadPathBufferTimerRef.current);
            roadPathBufferTimerRef.current = null;
        }

        const bufferedMessages = Array.from(roadPathBroadcastBufferRef.current.values());
        roadPathBroadcastBufferRef.current.clear();
        roadPathBufferStartedAtRef.current = 0;
        if (bufferedMessages.length === 0) return;

        const firstGroupId = bufferedMessages.find((message) => message.groupId)?.groupId ?? null;
        const preferredGroupId = activeRoadGroupIdRef.current ? null : firstGroupId;
        console.log('[road_path buffer] flush broadcasts:', bufferedMessages.length, 'preferredGroupId:', preferredGroupId);
        scheduleRoadGroupRefresh(preferredGroupId, 120);
        setRoadGroupAdvanceTick((tick) => tick + 1);
    }, [scheduleRoadGroupRefresh]);


    const handleRoadPath = useCallback(
        (message: RoadPathMessage) => {
            roadPathBroadcastBufferRef.current.set(message.lineId, message);

            const now = performance.now();
            if (roadPathBufferStartedAtRef.current === 0) {
                roadPathBufferStartedAtRef.current = now;
            }

            if (roadPathBufferTimerRef.current !== null) {
                window.clearTimeout(roadPathBufferTimerRef.current);
            }

            const elapsed = now - roadPathBufferStartedAtRef.current;
            const delay = Math.max(
                0,
                Math.min(ROAD_PATH_BUFFER_QUIET_MS, ROAD_PATH_BUFFER_MAX_WAIT_MS - elapsed),
            );

            roadPathBufferTimerRef.current = window.setTimeout(flushRoadPathBroadcastBuffer, delay);
        },
        [flushRoadPathBroadcastBuffer]
    );

    const markRoadDisplayLoopComplete = useCallback((reason: string) => {
        if (!autoCarouselEnabledRef.current) return false;

        roadGroupCycleCountRef.current += 1;

        console.log('[autoCarousel] completed road display loop', {
            reason,
            cycle: roadGroupCycleCountRef.current,
            target: targetCyclesRef.current,
        });

        if (roadGroupCycleCountRef.current >= Math.max(1, targetCyclesRef.current)) {
            console.log('[autoCarousel] road display loop target reached, enter ChinaMap phase', {
                cycle: roadGroupCycleCountRef.current,
                target: targetCyclesRef.current,
            });

            startChinaMapAutoPhaseRef.current();
            return true;
        }

        return false;
    }, []);

    const handleRoadGroupCycleComplete = useCallback(async (reason: string) => {
        if (autoCarouselEnabledRef.current) {
            roadGroupCycleCountRef.current += 1;
            console.log('[autoCarousel] completed road group cycle', {
                reason,
                cycle: roadGroupCycleCountRef.current,
                target: targetCyclesRef.current,
            });
            if (roadGroupCycleCountRef.current >= Math.max(1, targetCyclesRef.current)) {
                startChinaMapAutoPhaseRef.current();
                return true;
            }
        }

        try {
            const groups = await fetchRoadGroups();
            updateTargetCycles(groups.length); // 动态更新目标次数
            const ring = currentRoadGroupRing();
            normalizeRoadGroupRing(ring);
            const nextGroupId = ring.head?.groupId ?? null;
            if (nextGroupId) {
                await loadRoadGroup(nextGroupId);
                return true;
            }
        } catch (error) {
            console.warn('自动轮播刷新分组失败', error);
        }

        if (autoCarouselEnabledRef.current) {
            console.log('[autoCarousel] no available road groups, enter ChinaMap phase');
            startChinaMapAutoPhaseRef.current();
            return true;
        }

        resetRoadMapPlayback(`road group cycle complete: ${reason}`);
        return true;
    }, [currentRoadGroupRing, fetchRoadGroups, loadRoadGroup, normalizeRoadGroupRing, resetRoadMapPlayback, startChinaMapAutoPhaseRef, updateTargetCycles]);

    const advanceRoadGroup = useCallback(async () => {
        const ring = currentRoadGroupRing();
        normalizeRoadGroupRing(ring);
        console.log('[advanceRoadGroup] start', {
            ringSize: ring.nodes.size,
            head: ring.head?.groupId,
            current: ring.current?.groupId,
            active: activeRoadGroupIdRef.current,
            loading: roadGroupLoadingRef.current,
            nextCached: pendingNextGroupIdRef.current,
        });

        if (roadGroupLoadingRef.current) {
            console.log('[advanceRoadGroup] aborted (loading)');
            return;
        }

        if (!ring.head) {
            const activeGroupId = activeRoadGroupIdRef.current;
            if (activeGroupId && isRoadGroupComplete(activeGroupId)) {
                await handleRoadGroupCycleComplete('active group complete and ring has no head');
            } else {
                console.log('[advanceRoadGroup] aborted (no head)');
            }
            return;
        }

        // 优先处理缓存中的下一个组（只有在当前主组完成时才切换）
        const nextCached = pendingNextGroupIdRef.current;
        if (nextCached && isRoadGroupComplete(activeRoadGroupIdRef.current ?? '')) {
            console.log('[advanceRoadGroup] using cached next group:', nextCached);
            pendingNextGroupIdRef.current = null; // 重置，等待下次计算
            await loadRoadGroup(nextCached);
            console.log('[advanceRoadGroup] loaded cached group, done');
            return;
        }

        // 原有链表遍历逻辑
        if (ring.nodes.size <= 1) {
            const onlyGroupId = ring.head?.groupId ?? activeRoadGroupIdRef.current;

            if (!onlyGroupId) {
                console.log('[advanceRoadGroup] only one node branch but no group id');
                return;
            }

            // 单组情况下，每次展示时间结束，就算完成一轮 Road 展示循环。
            if (markRoadDisplayLoopComplete('single road group display loop')) {
                return;
            }

            // 没达到切 ChinaMap 的目标轮数，就刷新/继续显示这个唯一组。
            await loadRoadGroup(onlyGroupId);
            return;
        }

        let candidate = ring.current?.next ?? ring.head;
        const maxAttempts = Math.max(1, ring.nodes.size);

        console.log('[advanceRoadGroup] starting traverse, maxAttempts:', maxAttempts, 'startCandidate:', candidate?.groupId);

        for (let attempt = 0; candidate && attempt < maxAttempts; attempt++) {
            if (roadGroupLoadingRef.current) {
                console.log('[advanceRoadGroup] loading detected mid-traverse, abort');
                return;
            }

            const groupId = candidate.groupId;
            const nextCandidate = candidate.next ?? ring.head;
            const isWrappingToHead =
                autoCarouselEnabledRef.current &&
                attempt === 0 &&
                ring.current !== null &&
                candidate === ring.head &&
                ring.nodes.size > 1;

            if (isWrappingToHead) {
                if (markRoadDisplayLoopComplete('wrapped from tail to head')) {
                    return;
                }
            }

            console.log(`[advanceRoadGroup] attempt ${attempt}: checking group ${groupId}, isComplete: ${isRoadGroupComplete(groupId)}`);

            if (isRoadGroupComplete(groupId)) {
                console.log(`[advanceRoadGroup] group ${groupId} is complete, removing`);
                removeRoadGroupFromRing(groupId);
                candidate = nextCandidate;
                continue;
            }

            console.log(`[advanceRoadGroup] trying to load group ${groupId}`);
            const hasLiveRoutes = await loadRoadGroup(groupId);
            if (hasLiveRoutes) {
                console.log(`[advanceRoadGroup] loaded group ${groupId} successfully`);
                return;
            }
            console.log(`[advanceRoadGroup] group ${groupId} had no live routes, moving to next`);
            candidate = nextCandidate;
        }
        console.log('[advanceRoadGroup] traversal ended without loading any group');
        await handleRoadGroupCycleComplete('road group traverse found no live routes');
    }, [currentRoadGroupRing, handleRoadGroupCycleComplete, isRoadGroupComplete, loadRoadGroup, normalizeRoadGroupRing, removeRoadGroupFromRing, markRoadDisplayLoopComplete]);


    const finishRoute = useCallback((lineId: string) => {
        completedRouteIdsRef.current.add(lineId);
        activeRoutesRef.current.delete(lineId);
        roadMapRef.current?.removeRoadPath(lineId);
        setRouteOrders((prev) =>
            prev.map((item) => (item.lineId === lineId ? {...item, status: '已完成'} : item))
        );
        const activeGroupId = activeRoadGroupIdRef.current;
        const activeGroupRouteIds = activeGroupId
            ? currentRoadGroupRouteIds().get(activeGroupId)
            : null;
        if (activeGroupRouteIds && Array.from(activeGroupRouteIds).every((id) => completedRouteIdsRef.current.has(id))) {
            setRoadGroupAdvanceTick((tick) => tick + 1);
        }
    }, [currentRoadGroupRouteIds]);

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
        const currentView = viewRef.current;

        if (!isChinaMapAutoPhaseRef.current && chinaMapTimerRef.current !== null) {
            window.clearTimeout(chinaMapTimerRef.current);
            chinaMapTimerRef.current = null;
        }

        if (nextView === 'chinaMap') {
            if (currentView === 'chinaMap' || isPreparingChinaMap || isRevealingChinaMap) return;
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
            if (currentView === 'roadMap' || isPreparingRoadMap || isRevealingRoadMap) return;
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
    ]);



    useEffect(() => {
        startChinaMapAutoPhaseRef.current = () => {
            if (!autoCarouselEnabledRef.current) return;
            if (viewRef.current !== 'roadMap') return;

            console.log('[autoCarousel] switch to ChinaMap, target loops:', chinaMapLoopTargetRef.current);

            isChinaMapAutoPhaseRef.current = true;

            if (chinaMapTimerRef.current !== null) {
                window.clearTimeout(chinaMapTimerRef.current);
                chinaMapTimerRef.current = null;
            }

            requestViewChange('chinaMap');
        };
    }, [requestViewChange]);

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
        if (action !== 'fall') {
            console.log('🏗️ 处理仓库更新:', cityName, action, displayData);
            warehouseDisplayDataRef.current.set(cityName, displayData ?? {});
            mapRef.current?.riseCity(cityName);
            mapRef.current?.updateCityData(cityName, displayData);
        } else {
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
        mapRef.current?.cacheCityPanels(cityName, panels, style);
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
            setIsChinaMapDataReady(true);
        } catch (error) {
            console.warn('Warehouse snapshot request failed，使用空 ChinaMap 兜底显示', error);

            await waitForChinaMapReady();
            if (chinaMapPrepareRunRef.current !== prepareRunId) return;
            setIsChinaMapDataReady(true);
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
        // void refreshRoadGroups(activeRoadGroupIdRef.current ?? undefined);
    }, [refreshRoadGroups, view]);

    useEffect(() => {
        if (view !== 'roadMap') return;
        const ring = currentRoadGroupRing();
        normalizeRoadGroupRing(ring);
        if (ring.nodes.size <= 1) {
            const onlyGroupId = ring.head?.groupId ?? activeRoadGroupIdRef.current;
            if (!onlyGroupId || !isRoadGroupComplete(onlyGroupId)) {
                console.log('[roadGroupAdvanceTimer] skipped, ring size:', ring.nodes.size, 'roadGroups:', roadGroups.length);
                return;
            }

            console.log('[roadGroupAdvanceTimer] scheduled cleanup for completed terminal group', {
                ringSize: ring.nodes.size,
                active: activeRoadGroupIdRef.current,
                onlyGroupId,
                next: ring.head?.next?.groupId,
            });
            roadGroupAdvanceTimerRef.current = window.setTimeout(() => {
                roadGroupAdvanceTimerRef.current = null;
                void fetchRoadGroups()
                    .catch((error) => console.warn('Road groups refresh before cleanup failed', error))
                    .finally(() => {
                        void advanceRoadGroup();
                    });
            }, 0);
            return () => {
                if (roadGroupAdvanceTimerRef.current !== null) {
                    window.clearTimeout(roadGroupAdvanceTimerRef.current);
                    roadGroupAdvanceTimerRef.current = null;
                }
            };
        }

        const currentGroupId = activeRoadGroupIdRef.current;
        if (currentGroupId && isRoadGroupComplete(currentGroupId)) {
            console.log('[roadGroupAdvanceTimer] current group complete, advancing immediately', {
                ringSize: ring.nodes.size,
                active: currentGroupId,
                next: ring.current?.next?.groupId,
            });
            roadGroupAdvanceTimerRef.current = window.setTimeout(() => {
                roadGroupAdvanceTimerRef.current = null;
                void fetchRoadGroups()
                    .catch((error) => console.warn('Road groups refresh before immediate advance failed', error))
                    .finally(() => {
                        void advanceRoadGroup().finally(() => {
                            setRoadGroupAdvanceTick((tick) => tick + 1);
                        });
                    });
            }, 0);
            return () => {
                if (roadGroupAdvanceTimerRef.current !== null) {
                    window.clearTimeout(roadGroupAdvanceTimerRef.current);
                    roadGroupAdvanceTimerRef.current = null;
                }
            };
        }

        const currentGroup = activeRoadGroupIdRef.current
            ? currentRoadGroupSummaries().get(activeRoadGroupIdRef.current)
            : null;
        const routeCount = currentGroup?.count ?? routeOrdersRef.current.length;
        const delay = roadGroupDisplayMs(routeCount, appConfig);
        console.log('[roadGroupAdvanceTimer] scheduled', {
            delay,
            ringSize: ring.nodes.size,
            active: activeRoadGroupIdRef.current,
            routeCount,
            head: ring.head?.groupId,
            tail: ring.tail?.groupId,
            current: ring.current?.groupId,
            next: ring.current?.next?.groupId,
        });

        roadGroupAdvanceTimerRef.current = window.setTimeout(() => {
            roadGroupAdvanceTimerRef.current = null;
            void fetchRoadGroups()
                .catch((error) => console.warn('Road groups refresh before advance failed', error))
                .finally(() => {
                    void advanceRoadGroup().finally(() => {
                        setRoadGroupAdvanceTick((tick) => tick + 1);
                    });
                });
        }, delay);

        return () => {
            if (roadGroupAdvanceTimerRef.current !== null) {
                window.clearTimeout(roadGroupAdvanceTimerRef.current);
                roadGroupAdvanceTimerRef.current = null;
            }
        };
    }, [activeRoadGroupId, advanceRoadGroup, appConfig, currentRoadGroupRing, currentRoadGroupSummaries, fetchRoadGroups, isRoadGroupComplete, normalizeRoadGroupRing, roadGroupAdvanceTick, roadGroups.length, view]);


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
        if (view !== 'chinaMap') return;
        if (!autoCarouselEnabledRef.current) return;
        if (!isChinaMapAutoPhaseRef.current) return;

        if (chinaMapTourStartedSessionRef.current === chinaMapSession) return;
        chinaMapTourStartedSessionRef.current = chinaMapSession;

        console.log('[autoCarousel] ChinaMap 已显示，开始内部巡航', {
            session: chinaMapSession,
            targetLoops: chinaMapLoopTargetRef.current,
        });

        mapRef.current?.startWarehouseTour({
            maxLoops: chinaMapLoopTargetRef.current,

            onLoopComplete: (loop) => {
                console.log('[autoCarousel] ChinaMap loop complete', {
                    loop,
                    target: chinaMapLoopTargetRef.current,
                    currentView: viewRef.current,
                });
            },

            onComplete: () => {
                if (!autoCarouselEnabledRef.current) return;
                if (!isChinaMapAutoPhaseRef.current) return;

                if (viewRef.current !== 'chinaMap') {
                    console.log('[autoCarousel] ChinaMap onComplete ignored because current view is not chinaMap', {
                        currentView: viewRef.current,
                    });
                    return;
                }

                console.log('[autoCarousel] ChinaMap loops completed, switch back to RoadMap');

                isChinaMapAutoPhaseRef.current = false;
                roadGroupCycleCountRef.current = 0;
                requestViewChange('roadMap');
            },
        });
    }, [view, chinaMapSession, requestViewChange]);

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
            if (chinaMapTimerRef.current !== null) {
                window.clearTimeout(chinaMapTimerRef.current);
                chinaMapTimerRef.current = null;
            }
            if (roadPathRefreshTimerRef.current !== null) {
                window.clearTimeout(roadPathRefreshTimerRef.current);
                roadPathRefreshTimerRef.current = null;
            }
            if (roadPathBufferTimerRef.current !== null) {
                window.clearTimeout(roadPathBufferTimerRef.current);
                roadPathBufferTimerRef.current = null;
            }
            if (noOrderFallbackTimerRef.current !== null) {
                window.clearTimeout(noOrderFallbackTimerRef.current);
            }
            roadPathBroadcastBufferRef.current.clear();
            roadPathBufferStartedAtRef.current = 0;
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

    const renderCenterPanel = () => (
        <DashboardCenterPanel
            view={view}
            isPreparingChinaMap={isPreparingChinaMap}
            isRevealingChinaMap={isRevealingChinaMap}
            isPreparingRoadMap={isPreparingRoadMap}
            isRevealingRoadMap={isRevealingRoadMap}
            isRoadGroupFading={isRoadGroupFading}
            chinaMapSession={chinaMapSession}
            roadMapSession={roadMapSession}
            mapRef={mapRef}
            roadMapRef={roadMapRef}
            onChinaMapVisualReady={handleChinaMapVisualReady}
            onRoadMapVisualReady={handleRoadMapVisualReady}
            onWarehouseTourStateChange={handleWarehouseTourStateChange}
        />
    );

    const viewButtons = (
        <ViewButtons
            view={view}
            isPreparingChinaMap={isPreparingChinaMap}
            isRevealingChinaMap={isRevealingChinaMap}
            isPreparingRoadMap={isPreparingRoadMap}
            isRevealingRoadMap={isRevealingRoadMap}
            onRequestViewChange={requestViewChange}
        />
    );

    const roadGroupQueue = view === 'roadMap' && roadGroups.length > 0 && (
        <RoadGroupQueue
            groups={roadGroups}
            activeGroupId={activeRoadGroupId}
            isLoading={isLoadingRoadGroup}
            onSelectGroup={(groupId) => void loadRoadGroup(groupId)}
        />
    );

    const dispatchControls = view === 'roadMap' && (
        <DispatchButtons
            isDispatching={isDispatching}
            onDispatch={requestDispatch}
            onBulkDispatch={requestBulkDispatch}
        />
    );
    const roadStrategyTabs = view === 'roadMap' && (
        <RoadGroupTabs
            activeStrategy={roadGroupStrategy}
            onStrategyChange={(strategy) => {
                console.log('[strategy change] from', roadGroupStrategy, 'to', strategy);
                roadGroupRingsRef.current.set(strategy, createRoadGroupRing());
                roadGroupSummariesByStrategyRef.current.set(strategy, new Map());
                roadGroupRouteIdsByStrategyRef.current.set(strategy, new Map());
                setRoadGroupStrategy(strategy);
                setCurrentRoadGroup(null);
                activeRoutesRef.current.clear();
                routeOrdersRef.current = [];
                setRouteOrders([]);
                roadMapRef.current?.clearRoads();
                pendingNextGroupIdRef.current = null;
            }}
        />
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
            vehicleCount: activeRoadGroup.vehicleCount,
            groupKey: activeRoadGroup.groupKey,
            groupScenario: activeRoadGroup.groupScenario,
            scenarioReason: activeRoadGroup.scenarioReason,
            orderIds: activeRoadGroup.orderIds,
            routes: routeOrders,
        }
        : null;


    useEffect(() => {
        if (roadGroups.length > 0 && noOrderFallbackTimerRef.current !== null) {
            console.log('[autoCarousel] 订单到达，取消无订单回退');
            window.clearTimeout(noOrderFallbackTimerRef.current);
            noOrderFallbackTimerRef.current = null;
        }
    }, [roadGroups]);

    useEffect(() => {
        if (roadGroups.length > 0) {
            updateTargetCycles(roadGroups.length);
        }
    }, [roadGroups.length, updateTargetCycles]);

    useEffect(() => {
        if (!appConfig || autoCarouselStartedRef.current) return;
        if (!appConfig.autoCarouselEnabled || view !== 'warehouse') return;

        autoCarouselStartedRef.current = true;

        console.log('[autoCarousel] 自动启动：切换到道路地图，并设置无订单回退');
        requestViewChange('roadMap');

        // 如果你想自动造订单，就保留这一行；
        // 如果你想测试“无订单 30 秒回 ChinaMap”，先注释掉这一行。
        // void requestBulkDispatch();
    }, [appConfig, view, requestBulkDispatch, requestViewChange]);

    useEffect(() => {
        if (!appConfig?.autoCarouselEnabled) return;

        // 只在道路地图页面处理“无订单回退”
        if (view !== 'roadMap') {
            if (noOrderFallbackTimerRef.current !== null) {
                window.clearTimeout(noOrderFallbackTimerRef.current);
                noOrderFallbackTimerRef.current = null;
            }
            return;
        }

        // 有订单了就取消回退
        if (roadGroups.length > 0) {
            if (noOrderFallbackTimerRef.current !== null) {
                console.log('[autoCarousel] 订单到达，取消无订单回退');
                window.clearTimeout(noOrderFallbackTimerRef.current);
                noOrderFallbackTimerRef.current = null;
            }
            return;
        }

        // 已经有计时器就不要重复创建
        if (noOrderFallbackTimerRef.current !== null) return;

        console.log('[autoCarousel] roadMap 无订单，启动 30 秒回退计时器');

        noOrderFallbackTimerRef.current = window.setTimeout(() => {
            const stillInRoadMap = viewRef.current === 'roadMap';
            const noRoadGroups = roadGroupsRef.current.length === 0;

            console.log('[autoCarousel] 无订单回退检查', {
                stillInRoadMap,
                noRoadGroups,
                roadGroupsLength: roadGroupsRef.current.length,
                currentView: viewRef.current,
            });

            if (stillInRoadMap && noRoadGroups) {
                console.log('[autoCarousel] 30 秒无订单，切换回 ChinaMap');
                startChinaMapAutoPhaseRef.current()
            }

            noOrderFallbackTimerRef.current = null;
        }, 30000);

        return () => {
            if (noOrderFallbackTimerRef.current !== null) {
                window.clearTimeout(noOrderFallbackTimerRef.current);
                noOrderFallbackTimerRef.current = null;
            }
        };
    }, [appConfig?.autoCarouselEnabled, view, roadGroups.length, requestViewChange]);

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
                        isRoadGroupFading={isRoadGroupFading}
                    />
                    {roadGroupQueue}
                    {roadStrategyTabs}
                    {viewButtons}
                    {dispatchControls}
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
