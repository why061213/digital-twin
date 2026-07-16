import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { RoadObjectInfo } from '../modules/RoadMap3D-1/types';
import {
    loadTruckPositionsFromCache,
    saveTruckPositionToCache,
} from '../modules/RoadMap3D-1/utils';
import type { ActiveRoute, ViewMode } from '../types';
import type { RoadPathMessage, RouteOrder, TruckPositionMessage } from './useDashboardRealtime';
import { fetchTruckPosition } from '../services/roadApi';
import {
    POSITION_QUERY_INTERVAL_MS,
    POSITION_RENDER_TICK_MS,
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

type RoadMapMotionHandle = {
    addRoadPath: (id: string, coords: [number, number][], info?: RoadObjectInfo) => void;
    removeRoadPath: (id: string) => void;
    clearRoads: () => void;
    updateTruckPosition: (lineId: string, position: [number, number], info?: RoadObjectInfo) => void;
};

type UseTruckPositionControllerOptions = {
    roadMapRef: RefObject<RoadMapMotionHandle | null>;
    view: ViewMode;
    activeView?: ViewMode;
    onRouteFinished?: (lineId: string) => void;
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
    hydrateRoutePositions: (routes: ActiveRoute[], positions: TruckPositionMessage[]) => ActiveRoute[];
    finishRoute: (lineId: string) => void;
    handleTruckPosition: (message: TruckPositionMessage, forceCalibration?: boolean) => void;
    syncRoadRoute: (route: ActiveRoute) => void;
    renderTruckPosition: (route: ActiveRoute, now: number) => void;
};

function positionDetailsPatch(message: TruckPositionMessage) {
    return {
        ...(message.position !== undefined ? { currentPosition: message.position } : {}),
        ...(message.driverName !== undefined ? { driverName: message.driverName } : {}),
        ...(message.address !== undefined ? { address: message.address } : {}),
        ...(message.stateStr !== undefined ? { stateStr: message.stateStr } : {}),
        ...(message.directionDeg !== undefined ? { directionDeg: message.directionDeg } : {}),
        ...(message.directionLabel !== undefined ? { directionLabel: message.directionLabel } : {}),
    };
}

export function useTruckPositionController({
    roadMapRef,
    view,
    activeView = 'roadMap',
    onRouteFinished,
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
                    plate: message.plate ?? existing.plate,
                    cargo: message.cargo ?? existing.cargo,
                    cargoWeight: message.cargoWeight ?? existing.cargoWeight,
                    cargoUnit: message.cargoUnit ?? existing.cargoUnit,
                    status: message.status ?? existing.status,
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
                plate: message.plate ?? buildPlate(message.lineId),
                cargo: message.cargo ?? buildCargo(message.lineId),
                cargoWeight: message.cargoWeight,
                cargoUnit: message.cargoUnit,
                status: cachedPosition?.status ?? message.status ?? '运输中',
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
        await Promise.all(routes.map(async (route) => {
            if (positionRequestsRef.current.has(route.lineId)) return;
            positionRequestsRef.current.add(route.lineId);
            try {
                const message = await fetchTruckPosition(route.lineId);
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

    const hydrateRoutePositions = useCallback((routes: ActiveRoute[], positions: TruckPositionMessage[]) => {
        const routeByLineId = new Map(routes.map((route) => [route.lineId, route]));
        const now = performance.now();
        positions.forEach((message) => {
            const route = routeByLineId.get(message.lineId);
            if (!route) return;
            Object.assign(route, positionDetailsPatch(message));
            if (message.status === 'finished') {
                completedRouteIdsRef.current.add(message.lineId);
                return;
            }
            if (!message.position) return;
            applyTruckPositionToRoute(route, message, now);
            saveTruckPositionToCache({
                lineId: message.lineId,
                position: message.position,
                status: message.status,
                speedKmh: route.speedKmh,
                updatedAt: new Date().toISOString(),
            });
        });
        return routes.filter((route) => !completedRouteIdsRef.current.has(route.lineId));
    }, []);

    const finishRoute = useCallback((lineId: string) => {
        const alreadyFinished = completedRouteIdsRef.current.has(lineId);
        completedRouteIdsRef.current.add(lineId);
        activeRoutesRef.current.delete(lineId);
        roadMapRef.current?.removeRoadPath(lineId);
        setRouteOrders((prev) =>
            prev.map((item) => (item.lineId === lineId ? {...item, status: '已完成'} : item))
        );
        if (!alreadyFinished) onRouteFinished?.(lineId);
    }, [onRouteFinished, roadMapRef]);

    const handleTruckPosition = useCallback(
        (message: TruckPositionMessage, forceCalibration = false) => {
            const route = activeRoutesRef.current.get(message.lineId);
            if (!route) return;
            const detailPatch = positionDetailsPatch(message);
            Object.assign(route, detailPatch);

            if (message.status === 'finished') {
                finishRoute(message.lineId);
                return;
            }
            if (!message.position) {
                if (Object.keys(detailPatch).length > 0) {
                    setRouteOrders((prev) => {
                        const next = prev.map((item) => (
                            item.lineId === route.lineId ? { ...item, ...detailPatch } : item
                        ));
                        routeOrdersRef.current = next;
                        return next;
                    });
                }
                return;
            }

            const now = performance.now();
            if (!forceCalibration && now < route.nextCalibrationAt) {
                if (Object.keys(detailPatch).length > 0) {
                    setRouteOrders((prev) => {
                        const next = prev.map((item) => (
                            item.lineId === route.lineId ? { ...item, ...detailPatch } : item
                        ));
                        routeOrdersRef.current = next;
                        return next;
                    });
                }
                return;
            }

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
                    ...detailPatch,
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
                handleTruckPosition(await fetchTruckPosition(lineId), true);
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

    useEffect(() => {
        if (view !== activeView) return;
        const replayTimer = window.setTimeout(() => {
            const now = performance.now();
            roadMapRef.current?.clearRoads();
            activeRoutesRef.current.forEach((route) => {
                syncRoadRoute(route);
                renderTruckPosition(route, now);
            });
        }, 0);

        return () => window.clearTimeout(replayTimer);
    }, [activeView, renderTruckPosition, roadMapRef, syncRoadRoute, view]);

    useEffect(() => {
        // 关键：只有 RoadMap 正在显示时，才更新车辆位置和 routeOrders。
        // 否则 ChinaMap 聚焦时，DashboardPage 会被这个定时器高频刷新，导致两侧仓库面板闪动。
        if (view !== activeView) return;

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
    }, [activeView, renderTruckPosition, requestTruckPosition, view]);

    return {
        routeOrders,
        setRouteOrders,
        activeRoutesRef,
        routeOrdersRef,
        completedRouteIdsRef,
        createActiveRoute,
        showRoutes,
        prefetchRoutePositions,
        hydrateRoutePositions,
        finishRoute,
        handleTruckPosition,
        syncRoadRoute,
        renderTruckPosition,
    };
}
