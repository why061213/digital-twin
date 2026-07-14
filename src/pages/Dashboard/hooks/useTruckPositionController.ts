import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { RoadMap3DHandle } from '../modules/RoadMap3D';
import {
    loadTruckPositionsFromCache,
    saveTruckPositionToCache,
} from '../modules/RoadMap3D/utils';
import type { ActiveRoute, ViewMode } from '../types';
import type { RoadPathMessage, RouteOrder, TruckPositionMessage } from './useDashboardRealtime';
import { fetchTruckPosition, fetchTruckPositions } from '../services/roadApi';
import {
    POSITION_QUERY_INTERVAL_MS,
    POSITION_RENDER_TICK_MS,
    POSITION_BATCH_POLL_MS,
    POSITION_BACKGROUND_POLL_MS,
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

export function useTruckPositionController({
    roadMapRef,
    view,
}: UseTruckPositionControllerOptions): UseTruckPositionControllerResult {
    const [routeOrders, setRouteOrders] = useState<RouteOrder[]>([]);
    const activeRoutesRef = useRef<Map<string, ActiveRoute>>(new Map());
    const routeOrdersRef = useRef<RouteOrder[]>([]);
    const positionRequestsRef = useRef<Set<string>>(new Set());
    const completedRouteIdsRef = useRef<Set<string>>(new Set());

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

    const prefetchRoutePositions = useCallback(async (routes: ActiveRoute[]) => {
        const activeLineIds = routes
            .filter((r) => !completedRouteIdsRef.current.has(r.lineId))
            .map((r) => r.lineId);

        if (activeLineIds.length === 0) return routes;

        const startedAt = performance.now();
        try {
            const response = await fetchTruckPositions(activeLineIds);
            const costMs = Math.round(performance.now() - startedAt);
            console.info('[RoadMap] batch position prefetch', {
                requestedLineCount: activeLineIds.length,
                returnedCount: response.positions.length,
                missingCount: response.missingLineIds.length,
                staleCount: response.staleLineIds.length,
                costMs,
            });

            const now = performance.now();
            response.positions.forEach((item) => {
                const route = activeRoutesRef.current.get(item.lineId);
                if (!route || completedRouteIdsRef.current.has(item.lineId)) return;

                if (item.status === 'finished') {
                    completedRouteIdsRef.current.add(item.lineId);
                    return;
                }
                if (!item.position) return;

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
        } catch (error) {
            console.warn('[RoadMap] batch position prefetch failed', error);
            routes.forEach((route) => {
                route.nextCalibrationAt = performance.now() + initialPositionQueryDelay(route.lineId);
            });
        }

        return routes.filter((route) => !completedRouteIdsRef.current.has(route.lineId));
    }, []);

    const finishRoute = useCallback((lineId: string) => {
        completedRouteIdsRef.current.add(lineId);
        activeRoutesRef.current.delete(lineId);
        roadMapRef.current?.removeRoadPath(lineId);
        setRouteOrders((prev) =>
            prev.map((item) => (item.lineId === lineId ? {...item, status: '已完成'} : item))
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

    const requestTruckPositionsBatch = useCallback(
        async (lineIds: string[]) => {
            const deduped = [...new Set(lineIds.filter((id) => !positionRequestsRef.current.has(id)))];
            if (deduped.length === 0) return;

            deduped.forEach((id) => positionRequestsRef.current.add(id));
            try {
                const response = await fetchTruckPositions(deduped);
                const now = performance.now();
                response.positions.forEach((item) => {
                    if (item.status === 'finished') {
                        finishRoute(item.lineId);
                        return;
                    }
                    if (!item.position) return;
                    const route = activeRoutesRef.current.get(item.lineId);
                    if (!route) return;
                    applyTruckPositionToRoute(route, {
                        type: 'truck_position',
                        lineId: item.lineId,
                        position: item.position,
                        speedKmh: item.speedKmh,
                        status: item.status ?? '运输中',
                    } as TruckPositionMessage, now);
                    saveTruckPositionToCache({
                        lineId: item.lineId,
                        position: item.position,
                        status: item.status ?? '运输中',
                        speedKmh: route.speedKmh,
                        updatedAt: new Date().toISOString(),
                    });
                    renderTruckPosition(route, now);
                });
            } catch (error) {
                console.warn('[RoadMap] batch position request failed', error);
                deduped.forEach((lineId) => {
                    const route = activeRoutesRef.current.get(lineId);
                    if (route) {
                        route.arrivalCheckRequested = false;
                        route.nextCalibrationAt = performance.now() + POSITION_QUERY_INTERVAL_MS;
                    }
                });
            } finally {
                deduped.forEach((id) => positionRequestsRef.current.delete(id));
            }
        },
        [finishRoute, renderTruckPosition]
    );

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

    useEffect(() => {
        // 关键：只有 RoadMap 正在显示时，才更新车辆位置和 routeOrders。
        if (view !== 'roadMap') return;

        let batchTimer: ReturnType<typeof setInterval> | null = null;

        // 本地渲染 tick（500ms）：插值动画 + 路线进度
        const renderTimer = window.setInterval(() => {
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
                        return {...item, ...update};
                    });
                    if (!changed) return prev;
                    routeOrdersRef.current = next;
                    return next;
                });
            }
        }, POSITION_RENDER_TICK_MS);

        // 批量位置校准 tick：收集需要校准的线路，一次批量请求
        const pollBatch = () => {
            if (document.visibilityState !== 'visible') {
                if (batchTimer) {
                    clearInterval(batchTimer);
                    batchTimer = setInterval(pollBatch, POSITION_BACKGROUND_POLL_MS);
                }
                return;
            }

            const now = performance.now();
            const needCalibration: string[] = [];
            activeRoutesRef.current.forEach((route) => {
                const reachedPredictedEnd = route.pathLength > 0
                    && predictedDistance(route, now) >= route.pathLength - 0.0001;
                if (reachedPredictedEnd && !route.arrivalCheckRequested) {
                    route.arrivalCheckRequested = true;
                    route.nextCalibrationAt = now;
                    needCalibration.push(route.lineId);
                } else if (now >= route.nextCalibrationAt) {
                    needCalibration.push(route.lineId);
                }
            });

            if (needCalibration.length > 0) {
                void requestTruckPositionsBatch(needCalibration);
            }
        };

        batchTimer = setInterval(pollBatch, POSITION_BATCH_POLL_MS);
        pollBatch(); // 首次立即同步

        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                if (batchTimer) clearInterval(batchTimer);
                batchTimer = setInterval(pollBatch, POSITION_BATCH_POLL_MS);
                pollBatch();
            } else {
                if (batchTimer) clearInterval(batchTimer);
                batchTimer = setInterval(pollBatch, POSITION_BACKGROUND_POLL_MS);
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            window.clearInterval(renderTimer);
            if (batchTimer) clearInterval(batchTimer);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [renderTruckPosition, requestTruckPositionsBatch, view]);

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
