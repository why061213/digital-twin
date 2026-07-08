import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { RoadMap3DHandle } from '../modules/RoadMap3D';
import type { RoadPathMessage, RouteOrder } from './useDashboardRealtime';
import { fetchRoadGroupRoutes, fetchRoadGroupsByStrategy } from '../services/roadApi';
import type {
    ActiveRoute,
    RoadGroupNode,
    RoadGroupRing,
    RoadGroupStrategy,
    RoadGroupSummary,
    ViewMode,
} from '../types';
import {
    ROAD_GROUP_SWAP_DELAY_MS,
    roadGroupDisplayMs,
} from '../constants';
import {
    ensureRoadGroupRing,
    mergeVisibleRouteOrders,
    waitMs,
} from '../utils';

const ROAD_PATH_BUFFER_QUIET_MS = 650;
const ROAD_PATH_BUFFER_MAX_WAIT_MS = 1600;

type UseRoadGroupsControllerOptions = {
    roadMapRef: RefObject<RoadMap3DHandle | null>;
    view: ViewMode;
    activeRoutesRef: MutableRefObject<Map<string, ActiveRoute>>;
    routeOrdersRef: MutableRefObject<RouteOrder[]>;
    completedRouteIdsRef: MutableRefObject<Set<string>>;
    skipNextRoadMapRefreshRef: MutableRefObject<boolean>;
    createActiveRoute: (message: RoadPathMessage) => ActiveRoute | null;
    showRoutes: (routes: ActiveRoute[]) => void;
    prefetchRoutePositions: (routes: ActiveRoute[]) => Promise<ActiveRoute[]>;
    syncRoadRoute: (route: ActiveRoute) => void;
    renderTruckPosition: (route: ActiveRoute, now: number) => void;
    setRouteOrders: Dispatch<SetStateAction<RouteOrder[]>>;
};

type UseRoadGroupsControllerResult = {
    roadGroups: RoadGroupSummary[];
    activeRoadGroupId: string | null;
    activeRoadGroupIdRef: MutableRefObject<string | null>;
    roadGroupStrategy: RoadGroupStrategy;
    isLoadingRoadGroup: boolean;
    isRoadGroupFading: boolean;
    loadRoadGroup: (groupId: string) => Promise<boolean>;
    refreshRoadGroups: (preferredGroupId?: string | null) => Promise<void>;
    handleRoadPath: (message: RoadPathMessage) => void;
    resetRoadGroupStrategy: (strategy: RoadGroupStrategy) => void;
};

export function useRoadGroupsController({
    roadMapRef,
    view,
    activeRoutesRef,
    routeOrdersRef,
    completedRouteIdsRef,
    skipNextRoadMapRefreshRef,
    createActiveRoute,
    showRoutes,
    prefetchRoutePositions,
    syncRoadRoute,
    renderTruckPosition,
    setRouteOrders,
}: UseRoadGroupsControllerOptions): UseRoadGroupsControllerResult {
    const roadGroupKeepCurrentRefreshRef = useRef(false);
    const roadGroupKeepCurrentEmptyRef = useRef(false);
    const staleRoadGroupFallbackIdRef = useRef<string | null>(null);
    const pendingNextGroupIdRef = useRef<string | null>(null);
    const [roadGroups, setRoadGroups] = useState<RoadGroupSummary[]>([]);
    const [activeRoadGroupId, setActiveRoadGroupId] = useState<string | null>(null);
    const [roadGroupStrategy, setRoadGroupStrategy] = useState<RoadGroupStrategy>('business-priority');
    const [isLoadingRoadGroup, setIsLoadingRoadGroup] = useState(false);
    const [isRoadGroupFading, setIsRoadGroupFading] = useState(false);
    const [roadGroupAdvanceTick, setRoadGroupAdvanceTick] = useState(0);

    const activeRoadGroupIdRef = useRef<string | null>(null);
    const roadGroupRingsRef = useRef<Map<RoadGroupStrategy, RoadGroupRing>>(new Map());
    const roadGroupSummariesByStrategyRef = useRef<Map<RoadGroupStrategy, Map<string, RoadGroupSummary>>>(new Map());
    const roadGroupRouteIdsByStrategyRef = useRef<Map<RoadGroupStrategy, Map<string, Set<string>>>>(new Map());
    const routeGroupIdRef = useRef<Map<string, string>>(new Map());
    const roadGroupLoadingRef = useRef(false);
    const roadPathRefreshTimerRef = useRef<number | null>(null);
    const roadPathBufferTimerRef = useRef<number | null>(null);
    const roadPathBufferStartedAtRef = useRef(0);
    const roadPathBroadcastBufferRef = useRef<Map<string, RoadPathMessage>>(new Map());
    const pendingRoadGroupRefreshIdRef = useRef<string | null | undefined>(undefined);
    const roadGroupRefreshInFlightRef = useRef(false);
    const queuedRoadGroupRefreshPendingRef = useRef(false);
    const queuedRoadGroupRefreshIdRef = useRef<string | null | undefined>(undefined);
    const roadGroupAdvanceTimerRef = useRef<number | null>(null);
    const roadGroupTransitionRunRef = useRef(0);

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

    const setCurrentRoadGroup = useCallback((groupId: string | null) => {
        activeRoadGroupIdRef.current = groupId;
        setActiveRoadGroupId(groupId);

        if (!groupId) return;
        const node = currentRoadGroupRing().nodes.get(groupId);
        if (node) {
            currentRoadGroupRing().current = node;
        }
    }, [currentRoadGroupRing]);

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
    }, [currentRoadGroupRing, currentRoadGroupRouteIds, currentRoadGroupSummaries, normalizeRoadGroupRing, roadMapRef, routeOrdersRef, setRouteOrders]);

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

            const node: RoadGroupNode = { groupId: group.groupId, next: null };
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
    }, [completedRouteIdsRef, currentRoadGroupRouteIds]);

    const fetchRoadGroups = useCallback(async () => {
        const groups = await fetchRoadGroupsByStrategy(roadGroupStrategy);
        syncRoadGroupRing(groups);
        setRoadGroups(groups);
        return groups;
    }, [roadGroupStrategy, syncRoadGroupRing]);

    const loadRoadGroup = useCallback(
        async (groupId: string) => {
            console.trace('[loadRoadGroup] called with:', groupId);
            console.log('[loadRoadGroup] called with:', groupId, 'active before:', activeRoadGroupIdRef.current, 'strategy:', roadGroupStrategy);
            const transitionRunId = roadGroupTransitionRunRef.current + 1;
            roadGroupTransitionRunRef.current = transitionRunId;
            roadGroupLoadingRef.current = true;
            setIsLoadingRoadGroup(true);
            try {
                const data = await fetchRoadGroupRoutes(groupId, roadGroupStrategy);
                const loadedGroupId = data.groupId || groupId;
                // 注意：isSameGroup 必须在这之后定义，不能提前使用
                const isSameGroup = activeRoadGroupIdRef.current === loadedGroupId;
                const previousIds = new Set(activeRoutesRef.current.keys());
                let routes = (data.routes ?? [])
                    .map(createActiveRoute)
                    .filter((route): route is ActiveRoute => Boolean(route));
                const shouldAnimateGroupSwap =
                    view === 'roadMap' &&
                    activeRoadGroupIdRef.current !== null &&
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
                        return false;
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
        [activeRoutesRef, completedRouteIdsRef, createActiveRoute, currentRoadGroupRouteIds, prefetchRoutePositions, removeRoadGroupFromRing, renderTruckPosition, roadGroupStrategy, roadMapRef, routeOrdersRef, setCurrentRoadGroup, setRouteOrders, showRoutes, syncRoadRoute, view]
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
                    activeRoutesRef.current.clear();
                    roadMapRef.current?.clearRoads();
                    setRouteOrders([]);
                    setCurrentRoadGroup(null);
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
        [activeRoutesRef, fetchRoadGroups, loadRoadGroup, roadMapRef, setCurrentRoadGroup, setRouteOrders]
    );

    const scheduleRoadGroupRefresh = useCallback(
        (preferredGroupId?: string | null, delay = 600) => {
            if (preferredGroupId !== undefined) {
                pendingRoadGroupRefreshIdRef.current = preferredGroupId;
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

        if (!ring.head || roadGroupLoadingRef.current) {
            console.log('[advanceRoadGroup] aborted (no head or loading)');
            return;
        }

        // 优先处理缓存中的下一个组（只有在当前主组完成时才切换）
        const nextCached = pendingNextGroupIdRef.current;
        if (nextCached && isRoadGroupComplete(activeRoadGroupIdRef.current ?? '')) {
            console.log('[advanceRoadGroup] using cached next group:', nextCached);
            pendingNextGroupIdRef.current = null;
            await loadRoadGroup(nextCached);
            console.log('[advanceRoadGroup] loaded cached group, done');
            return;
        }

        // 原有链表遍历逻辑
        if (ring.nodes.size <= 1) {
            console.log('[advanceRoadGroup] only one node, skipping');
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
    }, [currentRoadGroupRing, isRoadGroupComplete, loadRoadGroup, normalizeRoadGroupRing, removeRoadGroupFromRing]);

    const resetRoadGroupStrategy = useCallback((strategy: RoadGroupStrategy) => {
        console.log('[strategy change] from', roadGroupStrategy, 'to', strategy);
        roadGroupRingsRef.current.set(strategy, {
            nodes: new Map(),
            head: null,
            tail: null,
            current: null,
        });
        roadGroupSummariesByStrategyRef.current.set(strategy, new Map());
        roadGroupRouteIdsByStrategyRef.current.set(strategy, new Map());
        setRoadGroupStrategy(strategy);
        setCurrentRoadGroup(null);
        activeRoutesRef.current.clear();
        routeOrdersRef.current = [];
        setRouteOrders([]);
        roadMapRef.current?.clearRoads();
        pendingNextGroupIdRef.current = null;
    }, [activeRoutesRef, roadGroupStrategy, roadMapRef, routeOrdersRef, setCurrentRoadGroup, setRouteOrders]);

    useEffect(() => {
        if (view !== 'roadMap') return;
        if (skipNextRoadMapRefreshRef.current) {
            skipNextRoadMapRefreshRef.current = false;
            return;
        }
        // void refreshRoadGroups(activeRoadGroupIdRef.current ?? undefined);
    }, [refreshRoadGroups, skipNextRoadMapRefreshRef, view]);

    useEffect(() => {
        if (view !== 'roadMap') return;
        const ring = currentRoadGroupRing();
        normalizeRoadGroupRing(ring);
        if (ring.nodes.size <= 1) {
            console.log('[roadGroupAdvanceTimer] skipped, ring size:', ring.nodes.size, 'roadGroups:', roadGroups.length);
            return;
        }

        const currentGroup = activeRoadGroupIdRef.current
            ? currentRoadGroupSummaries().get(activeRoadGroupIdRef.current)
            : null;
        const routeCount = currentGroup?.count ?? routeOrdersRef.current.length;
        const delay = roadGroupDisplayMs(routeCount);
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
    }, [activeRoadGroupId, advanceRoadGroup, currentRoadGroupRing, currentRoadGroupSummaries, fetchRoadGroups, normalizeRoadGroupRing, roadGroupAdvanceTick, roadGroups.length, routeOrdersRef, view]);

    useEffect(() => {
        return () => {
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
            if (roadGroupAdvanceTimerRef.current !== null) {
                window.clearTimeout(roadGroupAdvanceTimerRef.current);
                roadGroupAdvanceTimerRef.current = null;
            }
        };
    }, []);

    return {
        roadGroups,
        activeRoadGroupId,
        activeRoadGroupIdRef,
        roadGroupStrategy,
        isLoadingRoadGroup,
        isRoadGroupFading,
        loadRoadGroup,
        refreshRoadGroups,
        handleRoadPath,
        resetRoadGroupStrategy,
    };
}
