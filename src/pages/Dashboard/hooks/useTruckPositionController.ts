import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { RoadMap3DHandle } from '../modules/RoadMap3D';
import {
    loadTruckPositionsFromCache,
    saveTruckPositionToCache,
} from '../modules/RoadMap3D/utils';
import type { ActiveRoute, ViewMode } from '../types';
import type { RoadPathMessage, RouteOrder, TruckPositionMessage } from './useDashboardRealtime';
import { fetchTruckPositions } from '../services/roadApi';
import {
    POSITION_QUERY_INTERVAL_MS,
    POSITION_RENDER_TICK_MS,
    POSITION_BATCH_POLL_MS,
    POSITION_WS_FALLBACK_POLL_MS,
    WS_POSITION_TIMEOUT_MS,
    POSITION_BATCH_MIN_INTERVAL_MS,
} from '../constants';
import {
    applyTruckPositionToRoute,
    buildCargo,
    buildPlate,
    hashText,
    initialPositionQueryDelay,
    pathLength,
    pathLengthKm,
    predictedDistance,
    predictedPosition,
    projectDistanceOnPath,
    routeProgressPatch,
} from '../utils';

type UseTruckPositionControllerOptions = {
    roadMapRef: RefObject<RoadMap3DHandle | null>;
    view: ViewMode;
    /** 当前活跃路线组 ID */
    activeRoadGroupId: string | null;
    /** 当前活跃路线组包含的 lineId 列表 */
    activeRoadGroupLineIds: string[];
    /** WebSocket 连接状态：最近一次收到 truck_position 的时间戳（毫秒），null 表示从未收到 */
    wsLastPositionAt: number | null;
};

type UseTruckPositionControllerResult = {
    routeOrders: RouteOrder[];
    setRouteOrders: Dispatch<SetStateAction<RouteOrder[]>>;
    activeRoutesRef: MutableRefObject<Map<string, ActiveRoute>>;
    routeOrdersRef: MutableRefObject<RouteOrder[]>;
    completedRouteIdsRef: MutableRefObject<Set<string>>;
    createActiveRoute: (message: RoadPathMessage) => ActiveRoute | null;
    showRoutes: (routes: ActiveRoute[]) => void;
    prefetchRoutePositions: (routes: ActiveRoute[]) => Promise<ActiveRoute[]>;
    finishRoute: (lineId: string) => void;
    handleTruckPosition: (message: TruckPositionMessage, forceCalibration?: boolean) => void;
    syncRoadRoute: (route: ActiveRoute) => void;
    renderTruckPosition: (route: ActiveRoute, now: number) => void;
};

// ---------- single-flight 状态 ----------
type BatchRequestState = {
    controller: AbortController;
    scopeId: string;
    sequence: number;
};

export function useTruckPositionController({
    roadMapRef,
    view,
    activeRoadGroupId,
    activeRoadGroupLineIds,
    wsLastPositionAt,
}: UseTruckPositionControllerOptions): UseTruckPositionControllerResult {
    const [routeOrders, setRouteOrders] = useState<RouteOrder[]>([]);
    const activeRoutesRef = useRef<Map<string, ActiveRoute>>(new Map());
    const routeOrdersRef = useRef<RouteOrder[]>([]);
    const completedRouteIdsRef = useRef<Set<string>>(new Set());

    // single-flight：同一时间最多一个批量请求
    const batchRequestRef = useRef<BatchRequestState | null>(null);
    // 请求序列号
    const batchSequenceRef = useRef(0);
    // 上次批量请求时间（避免 prefetch 后立即 poll）
    const lastBatchAtRef = useRef(0);

    useEffect(() => {
        routeOrdersRef.current = routeOrders;
    }, [routeOrders]);

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
    }, [roadMapRef]);

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
    }, [roadMapRef]);

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
                    plate: message.plate ?? existing.plate,
                    cargo: message.cargo ?? existing.cargo,
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
                plate: message.plate ?? buildPlate(message.lineId),
                cargo: message.cargo ?? buildCargo(message.lineId),
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

    // ---------- 请求协调器：prefetch 和 poll 共用 ----------
    const executeBatchRequest = useCallback(async (
        lineIds: string[],
        scopeId: string,
    ) => {
        const state = batchRequestRef.current;

        // 同一 scope 已有请求进行中 → 跳过
        if (state && state.scopeId === scopeId) {
            return;
        }

        // 不同 scope → abort 旧请求
        if (state) {
            state.controller.abort();
            batchRequestRef.current = null;
        }

        if (lineIds.length === 0) return;

        const sequence = ++batchSequenceRef.current;
        const controller = new AbortController();
        batchRequestRef.current = { controller, scopeId, sequence };

        lastBatchAtRef.current = performance.now();

        try {
            const response = await fetchTruckPositions(lineIds, { signal: controller.signal });
            const now = performance.now();

            // 响应落地校验
            if (controller.signal.aborted) return;
            if (batchRequestRef.current?.sequence !== sequence) return;
            if (scopeId !== activeRoadGroupId) return;

            const activeGroupSet = new Set(activeRoadGroupLineIds);
            const unexpectedLineIds: string[] = [];

            response.positions.forEach((item) => {
                if (!lineIds.includes(item.lineId)) return; // 不在请求范围内
                if (!activeGroupSet.has(item.lineId)) {
                    unexpectedLineIds.push(item.lineId);
                    return;
                }
                if (item.status === 'finished') {
                    completedRouteIdsRef.current.add(item.lineId);
                    return;
                }
                if (!item.position) return;

                const route = activeRoutesRef.current.get(item.lineId);
                if (!route) return;

                const message: TruckPositionMessage = {
                    type: 'truck_position',
                    lineId: item.lineId,
                    position: item.position,
                    speedKmh: item.speedKmh,
                    status: item.status ?? '运输中',
                };
                applyTruckPositionToRoute(route, message, now);
                saveTruckPositionToCache({
                    lineId: item.lineId,
                    position: item.position,
                    status: message.status,
                    speedKmh: route.speedKmh,
                    updatedAt: new Date().toISOString(),
                });
            });

            if (unexpectedLineIds.length > 0 && import.meta.env.DEV) {
                console.error('[RoadMap] unexpected lineIds in batch response', {
                    activeRoadGroupId: scopeId,
                    activeGroupLineCount: activeGroupSet.size,
                    requestedLineCount: lineIds.length,
                    unexpectedLineIds,
                });
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.warn('[RoadMap] batch position request failed', error);
        } finally {
            if (batchRequestRef.current?.controller === controller) {
                batchRequestRef.current = null;
            }
        }
    }, [activeRoadGroupId, activeRoadGroupLineIds]);

    // ---------- prefetch：路线组首次加载调用 ----------
    const prefetchRoutePositions = useCallback(async (routes: ActiveRoute[]) => {
        const activeLineIds = routes
            .filter((r) => !completedRouteIdsRef.current.has(r.lineId))
            .map((r) => r.lineId);

        if (activeLineIds.length === 0) return routes;
        if (!activeRoadGroupId) return routes;

        // 只请求属于当前组的 lineId
        const groupSet = new Set(activeRoadGroupLineIds);
        const groupLineIds = activeLineIds.filter((id) => groupSet.has(id));

        console.info('[RoadMap] prefetch positions', {
            activeRoadGroupId,
            activeGroupLineCount: groupSet.size,
            requestedLineCount: groupLineIds.length,
            unexpectedLineIds: activeLineIds.filter((id) => !groupSet.has(id)),
        });

        await executeBatchRequest(groupLineIds, activeRoadGroupId);

        return routes.filter((route) => !completedRouteIdsRef.current.has(route.lineId));
    }, [activeRoadGroupId, activeRoadGroupLineIds, executeBatchRequest]);

    const finishRoute = useCallback((lineId: string) => {
        completedRouteIdsRef.current.add(lineId);
        activeRoutesRef.current.delete(lineId);
        roadMapRef.current?.removeRoadPath(lineId);
        setRouteOrders((prev) =>
            prev.map((item) => (item.lineId === lineId ? { ...item, status: '已完成' } : item))
        );
    }, [roadMapRef]);

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

    // ========== Effects ==========

    // 离开 roadMap 或 groupId 变化 → abort 旧请求
    useEffect(() => {
        if (view !== 'roadMap') {
            if (batchRequestRef.current) {
                batchRequestRef.current.controller.abort();
                batchRequestRef.current = null;
            }
        }
    }, [view]);

    // activeRoadGroupId 变化 → abort 旧请求
    useEffect(() => {
        const state = batchRequestRef.current;
        if (state && state.scopeId !== activeRoadGroupId) {
            state.controller.abort();
            batchRequestRef.current = null;
        }
    }, [activeRoadGroupId]);

    // 页面重绘 effect（切换回 roadMap 时重放）
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
    }, [renderTruckPosition, roadMapRef, syncRoadRoute, view]);

    // 本地渲染 + 批量位置同步
    useEffect(() => {
        if (view !== 'roadMap') return;

        let renderTimer: ReturnType<typeof setInterval> | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;

        // 本地渲染 tick（500ms）
        renderTimer = window.setInterval(() => {
            const now = performance.now();
            const progressUpdates = new Map<string, ReturnType<typeof routeProgressPatch>>();
            activeRoutesRef.current.forEach((route) => {
                renderTruckPosition(route, now);
                progressUpdates.set(route.lineId, routeProgressPatch(route, now));
            });
            if (progressUpdates.size > 0) {
                setRouteOrders((prev) => {
                    let changed = false;
                    const next = prev.map((item) => {
                        const update = progressUpdates.get(item.lineId);
                        if (!update) return item;
                        changed = true;
                        return { ...item, ...update };
                    });
                    if (!changed) return prev;
                    routeOrdersRef.current = next;
                    return next;
                });
            }
        }, POSITION_RENDER_TICK_MS);

        // 批量位置同步
        const startPolling = (intervalMs: number) => {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = window.setInterval(() => {
                // hidden → 不轮询，清除 timer
                if (document.visibilityState === 'hidden') {
                    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                    if (batchRequestRef.current) {
                        batchRequestRef.current.controller.abort();
                        batchRequestRef.current = null;
                    }
                    return;
                }

                // 上次请求距现在太近 → 跳过
                if (performance.now() - lastBatchAtRef.current < POSITION_BATCH_MIN_INTERVAL_MS) return;

                const scopeId = activeRoadGroupId;
                if (!scopeId) return;

                const groupSet = new Set(activeRoadGroupLineIds);
                const needCalibration = activeRoadGroupLineIds.filter((id) => {
                    const route = activeRoutesRef.current.get(id);
                    if (!route || completedRouteIdsRef.current.has(id)) return false;
                    return performance.now() >= route.nextCalibrationAt;
                });

                console.info('[RoadMap] batch poll', {
                    activeRoadGroupId: scopeId,
                    activeRouteCount: activeRoutesRef.current.size,
                    activeGroupLineCount: groupSet.size,
                    requestedLineCount: needCalibration.length,
                    unexpectedLineIds: [] as string[],
                });

                void executeBatchRequest(needCalibration, scopeId);
            }, intervalMs);
        };

        // WebSocket 自适应：根据最近收到消息的时间选择频率
        const isWsActive = wsLastPositionAt !== null
            && (performance.now() - wsLastPositionAt) < WS_POSITION_TIMEOUT_MS;
        startPolling(isWsActive ? POSITION_WS_FALLBACK_POLL_MS : POSITION_BATCH_POLL_MS);

        // 前台 → 立即同步一次
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                const scopeId = activeRoadGroupId;
                if (!scopeId) return;
                const isWsActive = wsLastPositionAt !== null
                    && (performance.now() - wsLastPositionAt) < WS_POSITION_TIMEOUT_MS;
                startPolling(isWsActive ? POSITION_WS_FALLBACK_POLL_MS : POSITION_BATCH_POLL_MS);
                // 立即同步
                void executeBatchRequest(activeRoadGroupLineIds, scopeId);
            } else {
                // hidden：停止轮询 + abort
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                if (batchRequestRef.current) {
                    batchRequestRef.current.controller.abort();
                    batchRequestRef.current = null;
                }
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            window.clearInterval(renderTimer);
            if (pollTimer) clearInterval(pollTimer);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (batchRequestRef.current) {
                batchRequestRef.current.controller.abort();
                batchRequestRef.current = null;
            }
        };
    }, [view, activeRoadGroupId, activeRoadGroupLineIds, wsLastPositionAt, executeBatchRequest, renderTruckPosition]);

    return {
        routeOrders,
        setRouteOrders,
        activeRoutesRef,
        routeOrdersRef,
        completedRouteIdsRef,
        createActiveRoute,
        showRoutes,
        prefetchRoutePositions,
        finishRoute,
        handleTruckPosition,
        syncRoadRoute,
        renderTruckPosition,
    };
}
