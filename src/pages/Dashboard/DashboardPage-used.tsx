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
import { ManualPositionLookup } from './components/ManualPositionLookup';
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
    MAP_VIEW_RELEASE_DELAY_MS, MAX_ROADS_PER_GROUP,
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
function DashboardPage() {
    const pendingGroupCacheRef = useRef<Array<{ groupId: string; addedAt: number }>>([]);
    const isProcessingQueueRef = useRef(false);
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
    const roadGroupTransitionRunRef = useRef(0);

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
            roadMapRef.current?.clearRoads();
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
            // if (roadGroupLoadingRef.current) return false;
            const transitionRunId = roadGroupTransitionRunRef.current + 1;
            roadGroupTransitionRunRef.current = transitionRunId;
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
        async (preferredGroupId?: string) => {
            if (roadGroupRefreshInFlightRef.current || roadGroupLoadingRef.current) {
                queuedRoadGroupRefreshIdRef.current = preferredGroupId ?? null;
                return;
            }
            roadGroupRefreshInFlightRef.current = true;
            try {
                const groups = await fetchRoadGroups();
                const currentGroupId = activeRoadGroupIdRef.current;
                let nextGroupId: string | null | undefined;

                if (preferredGroupId === null) {
                    // 强制刷新当前组（保持组不变）
                    nextGroupId = currentGroupId;
                } else if (preferredGroupId !== undefined) {
                    nextGroupId = preferredGroupId;
                } else {
                    // 自动选择：保持当前组或第一个
                    nextGroupId = currentGroupId && groups.some((group) => group.groupId === currentGroupId)
                        ? currentGroupId
                        : groups[0]?.groupId;
                }

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
                void refreshRoadGroups(pendingGroupId ?? undefined);
            }, delay);
        },
        [refreshRoadGroups]
    );

    const processQueue = useCallback(async () => {
        if (isProcessingQueueRef.current || pendingGroupCacheRef.current.length === 0) return;
        isProcessingQueueRef.current = true;

        try {
            // 先获取最新的分组列表
            await fetchRoadGroups();
            while (pendingGroupCacheRef.current.length > 0) {
                const next = pendingGroupCacheRef.current.shift()!;
                await loadRoadGroup(next.groupId);
            }
        } finally {
            isProcessingQueueRef.current = false;
        }
    }, [loadRoadGroup, fetchRoadGroups]);

    const handleRoadPath = useCallback(
        (message: RoadPathMessage) => {
            // 将新消息加入缓存队列（去重）
            const exists = pendingGroupCacheRef.current.some(item => item.groupId === message.groupId);
            if (!exists) {
                pendingGroupCacheRef.current.push({
                    groupId: message.groupId,
                    addedAt: performance.now(),
                });
            }

            // 启动队列处理（如果未在处理中）
            processQueue();
        },
        []
    );

    const advanceRoadGroup = useCallback(async () => {
        const ring = currentRoadGroupRing();
        if (!ring.head || roadGroupLoadingRef.current) return;

        // 优先处理缓存中的下一个组（只有在当前主组完成时才切换）
        const nextCached = pendingNextGroupIdRef.current;
        if (nextCached && isRoadGroupComplete(activeRoadGroupIdRef.current ?? '')) {
            const index = pendingGroupCacheRef.current.findIndex(item => item.groupId === nextCached);
            if (index !== -1) pendingGroupCacheRef.current.splice(index, 1);
            pendingNextGroupIdRef.current = null; // 重置，等待下次计算
            await loadRoadGroup(nextCached);
            return;
        }

        // 原有链表遍历逻辑不变
        if (ring.nodes.size <= 1) return;
        let candidate = ring.current?.next ?? ring.head;
        const maxAttempts = Math.max(1, ring.nodes.size);
        for (let attempt = 0; candidate && attempt < maxAttempts; attempt++) {
            if (roadGroupLoadingRef.current) return;
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
    }, [activeRoadGroupId, advanceRoadGroup, currentRoadGroupSummaries, roadGroupAdvanceTick, roadGroups, view]);


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
        <ManualPositionLookup
            carId={manualCarId}
            onCarIdChange={setManualCarId}
            onQuery={() => void handleManualQuery()}
            isQuerying={isManualQuerying}
            status={manualQueryStatus}
        />
    );

    const roadStrategyTabs = view === 'roadMap' && (
        <RoadGroupTabs
            activeStrategy={roadGroupStrategy}
            onStrategyChange={(strategy) => {
                setRoadGroupStrategy(strategy);
                setCurrentRoadGroup(null);
                activeRoutesRef.current.clear();
                routeOrdersRef.current = [];
                setRouteOrders([]);
                roadMapRef.current?.clearRoads();

                pendingGroupCacheRef.current.clear();
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
                    {dispatchControls}
                    {/*{manualPositionLookup}*/}
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
