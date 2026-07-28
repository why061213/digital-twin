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
    FALLBACK_TRUCK_SPEED_KMH,
    initialPositionQueryDelay,
    pathLength,
    pathLengthKm,
    pathSpeedFromKmh,
    predictedDistance,
    predictedPosition,
    projectDistanceOnPath,
    routeProgressPatch,
    safeTravelDurationMs,
    trustedTruckSpeedKmh,
} from '../utils';
import { routeVisualKey, sceneRouteId } from '../playback/rm2RouteIdentity';

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
        ...(message.alarmStr !== undefined ? { alarmStr: message.alarmStr } : {}),
        ...(message.alarmSeverity !== undefined ? { alarmSeverity: message.alarmSeverity } : {}),
        ...(message.online !== undefined ? { online: message.online } : {}),
        ...(message.directionDeg !== undefined ? { directionDeg: message.directionDeg } : {}),
        ...(message.directionLabel !== undefined ? { directionLabel: message.directionLabel } : {}),
        ...(message.routeLengthKm !== undefined ? { routeLengthKm: message.routeLengthKm } : {}),
        ...(message.travelDurationMs !== undefined ? { fallbackDuration: message.travelDurationMs } : {}),
        ...(message.pathKey !== undefined ? { pathKey: message.pathKey } : {}),
        ...(message.colorKey !== undefined ? { colorKey: message.colorKey } : {}),
        ...(message.isRouteBranch !== undefined ? { isRouteBranch: message.isRouteBranch } : {}),
        ...(message.routeDeviationState !== undefined ? { routeDeviationState: message.routeDeviationState } : {}),
        ...(message.routeDeviationReasonCode !== undefined ? { routeDeviationReasonCode: message.routeDeviationReasonCode } : {}),
        ...(message.routeDeviationConfidence !== undefined ? { routeDeviationConfidence: message.routeDeviationConfidence } : {}),
        ...(message.routeAnomalyScore !== undefined ? { routeAnomalyScore: message.routeAnomalyScore } : {}),
        ...(message.tripId !== undefined ? { tripId: message.tripId } : {}),
        ...(message.visualKey !== undefined ? { visualKey: message.visualKey } : {}),
        ...(message.currentLegId !== undefined ? { currentLegId: message.currentLegId } : {}),
        ...(message.planVersion !== undefined ? { planVersion: message.planVersion } : {}),
        ...(message.targetAction !== undefined ? { targetAction: message.targetAction } : {}),
        ...(message.tripPhase !== undefined ? { tripPhase: message.tripPhase } : {}),
        ...(message.tripDecision !== undefined ? { tripDecision: message.tripDecision } : {}),
        ...(message.positionQuality !== undefined ? { positionQuality: message.positionQuality } : {}),
        ...(message.pendingOrderCount !== undefined ? { pendingOrderCount: message.pendingOrderCount } : {}),
        ...(message.onboardOrderCount !== undefined ? { onboardOrderCount: message.onboardOrderCount } : {}),
        ...(message.completedOrderCount !== undefined ? { completedOrderCount: message.completedOrderCount } : {}),
    };
}

type PositionStamp = {
    sequence: number | null;
    fetchedAt: number | null;
};

function positionStamp(message: TruckPositionMessage): PositionStamp {
    const sequence = Number(message.sequence);
    const fetchedAt = message.fetchedAt ? Date.parse(message.fetchedAt) : Number.NaN;
    return {
        sequence: Number.isFinite(sequence) ? sequence : null,
        fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
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
    const lastPositionStampRef = useRef<Map<string, PositionStamp>>(new Map());

    const acceptPositionSample = useCallback((message: TruckPositionMessage) => {
        if (!message.position || message.stale === true) return false;
        const incoming = positionStamp(message);
        const previous = lastPositionStampRef.current.get(message.lineId);
        if (previous) {
            if (incoming.fetchedAt !== null && previous.fetchedAt !== null) {
                if (incoming.fetchedAt < previous.fetchedAt) return false;
                if (incoming.fetchedAt === previous.fetchedAt
                    && incoming.sequence !== null && previous.sequence !== null
                    && incoming.sequence <= previous.sequence) return false;
            } else if (incoming.sequence !== null && previous.sequence !== null
                && incoming.sequence <= previous.sequence) {
                return false;
            }
        }
        lastPositionStampRef.current.set(message.lineId, incoming);
        return true;
    }, []);

    useEffect(() => {
        routeOrdersRef.current = routeOrders;
    }, [routeOrders]);

    const syncRoadRoute = useCallback((route: ActiveRoute) => {
        roadMapRef.current?.addRoadPath(sceneRouteId(route), route.coordinates, {
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
            directionDeg: route.directionDeg,
            stateStr: route.stateStr,
            alarmStr: route.alarmStr,
            alarmSeverity: route.alarmSeverity,
            online: route.online,
            colorKey: route.colorKey,
            routeColorIndex: route.routeColorIndex,
            isRouteBranch: route.isRouteBranch,
            isVehicleRoute: Number.isFinite(Number(route.routeRevision)),
            vehicleRole: route.vehicleRole,
            vehicleVisible: route.hasRealPosition === true,
            routeDeviationState: route.routeDeviationState,
            routeDeviationReasonCode: route.routeDeviationReasonCode,
            routeDeviationConfidence: route.routeDeviationConfidence,
            routeAnomalyScore: route.routeAnomalyScore,
            tripId: route.tripId,
            visualKey: route.visualKey,
            currentLegId: route.currentLegId,
            planVersion: route.planVersion,
            targetStopId: route.targetStopId,
            targetOrderInstanceId: route.targetOrderInstanceId,
            targetAction: route.targetAction,
            tripStatusText: route.tripStatusText,
            tripStops: route.tripStops,
            tripPhase: route.tripPhase,
            tripDecision: route.tripDecision,
            positionQuality: route.positionQuality,
            pendingOrderCount: route.pendingOrderCount,
            onboardOrderCount: route.onboardOrderCount,
            completedOrderCount: route.completedOrderCount,
        });
    }, [roadMapRef]);

    const renderTruckPosition = useCallback((route: ActiveRoute, now: number) => {
        roadMapRef.current?.updateTruckPosition(sceneRouteId(route), predictedPosition(route, now), {
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
            directionDeg: route.directionDeg,
            stateStr: route.stateStr,
            alarmStr: route.alarmStr,
            alarmSeverity: route.alarmSeverity,
            online: route.online,
            colorKey: route.colorKey,
            routeColorIndex: route.routeColorIndex,
            isRouteBranch: route.isRouteBranch,
            routeProgress: route.pathLength > 0 ? predictedDistance(route, now) / route.pathLength : 0,
            vehicleVisible: route.hasRealPosition === true,
            routeDeviationState: route.routeDeviationState,
            routeDeviationReasonCode: route.routeDeviationReasonCode,
            routeDeviationConfidence: route.routeDeviationConfidence,
            routeAnomalyScore: route.routeAnomalyScore,
            tripId: route.tripId,
            visualKey: route.visualKey,
            currentLegId: route.currentLegId,
            planVersion: route.planVersion,
            targetStopId: route.targetStopId,
            targetOrderInstanceId: route.targetOrderInstanceId,
            targetAction: route.targetAction,
            tripPhase: route.tripPhase,
            tripDecision: route.tripDecision,
            positionQuality: route.positionQuality,
            pendingOrderCount: route.pendingOrderCount,
            onboardOrderCount: route.onboardOrderCount,
            completedOrderCount: route.completedOrderCount,
        });
    }, [roadMapRef]);

    const createActiveRoute = useCallback(
        (message: RoadPathMessage): ActiveRoute | null => {
            if (!message.coordinates || message.coordinates.length < 2) return null;

            const now = performance.now();
            const incomingVisualKey = routeVisualKey(message);
            const existing = activeRoutesRef.current.get(message.lineId)
                ?? [...activeRoutesRef.current.values()]
                    .find((route) => routeVisualKey(route) === incomingVisualKey);
            const totalPathLength = pathLength(message.coordinates);
            const routeLengthKm = message.routeLengthKm ?? pathLengthKm(message.coordinates);
            const speedKmh = trustedTruckSpeedKmh(message.speedKmh)
                ?? trustedTruckSpeedKmh(existing?.speedKmh)
                ?? FALLBACK_TRUCK_SPEED_KMH;
            const fallbackDuration = safeTravelDurationMs(
                routeLengthKm,
                message.travelDurationMs,
                speedKmh,
            );
            const pathSpeed = pathSpeedFromKmh(totalPathLength, routeLengthKm, speedKmh);

            if (existing) {
                const currentPosition = predictedPosition(existing, now);
                const updated: ActiveRoute = {
                    ...existing,
                    lineId: message.lineId,
                    orderId: message.orderId ?? existing.orderId,
                    orderFamilyId: message.orderFamilyId ?? existing.orderFamilyId,
                    orderName: message.orderName ?? existing.orderName,
                    orderTotalTons: message.orderTotalTons ?? existing.orderTotalTons,
                    orderVehicleCount: message.orderVehicleCount ?? existing.orderVehicleCount,
                    pathKey: message.pathKey ?? existing.pathKey,
                    colorKey: message.colorKey ?? existing.colorKey,
                    routeColorIndex: message.routeColorIndex ?? existing.routeColorIndex,
                    isRouteBranch: message.isRouteBranch ?? existing.isRouteBranch,
                    vehicleRole: message.vehicleRole ?? existing.vehicleRole,
                    routeRevision: message.routeRevision ?? existing.routeRevision,
                    tripId: message.tripId ?? existing.tripId,
                    visualKey: message.visualKey ?? existing.visualKey,
                    currentLegId: message.currentLegId ?? existing.currentLegId,
                    planVersion: message.planVersion ?? existing.planVersion,
                    targetStopId: message.targetStopId ?? existing.targetStopId,
                    targetOrderInstanceId: message.targetOrderInstanceId ?? existing.targetOrderInstanceId,
                    targetAction: message.targetAction ?? existing.targetAction,
                    tripStatusText: message.tripStatusText ?? existing.tripStatusText,
                    tripStops: message.tripStops ?? existing.tripStops,
                    tripPhase: message.tripPhase ?? existing.tripPhase,
                    tripDecision: message.tripDecision ?? existing.tripDecision,
                    positionQuality: message.positionQuality ?? existing.positionQuality,
                    pendingOrderCount: message.pendingOrderCount ?? existing.pendingOrderCount,
                    onboardOrderCount: message.onboardOrderCount ?? existing.onboardOrderCount,
                    completedOrderCount: message.completedOrderCount ?? existing.completedOrderCount,
                    routeSignature: message.routeSignature ?? existing.routeSignature,
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
                    calibratedDistance: projectDistanceOnPath(message.coordinates, currentPosition, existing.calibratedDistance),
                    pathSpeed,
                    pathLength: totalPathLength,
                    speedKmh,
                    hasRealPosition: existing.hasRealPosition,
                    arrivalCheckRequested: false,
                };
                if (existing.lineId !== updated.lineId) activeRoutesRef.current.delete(existing.lineId);
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
                colorKey: message.colorKey,
                routeColorIndex: message.routeColorIndex,
                isRouteBranch: message.isRouteBranch,
                vehicleRole: message.vehicleRole,
                routeRevision: message.routeRevision,
                tripId: message.tripId,
                visualKey: message.visualKey,
                currentLegId: message.currentLegId,
                planVersion: message.planVersion,
                targetStopId: message.targetStopId,
                targetOrderInstanceId: message.targetOrderInstanceId,
                targetAction: message.targetAction,
                tripStatusText: message.tripStatusText,
                tripStops: message.tripStops,
                tripPhase: message.tripPhase,
                tripDecision: message.tripDecision,
                positionQuality: message.positionQuality,
                pendingOrderCount: message.pendingOrderCount,
                onboardOrderCount: message.onboardOrderCount,
                completedOrderCount: message.completedOrderCount,
                routeSignature: message.routeSignature,
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
                pathSpeed,
                pathLength: totalPathLength,
                speedKmh: cachedPosition?.speedKmh ?? speedKmh,
                hasRealPosition: Boolean(cachedPosition),
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
                if (route.hasRealPosition) renderTruckPosition(route, now);
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
                if (!message.position || !acceptPositionSample(message)) return;
                const now = performance.now();
                applyTruckPositionToRoute(route, message, now);
                route.hasRealPosition = true;
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
    }, [acceptPositionSample]);

    const hydrateRoutePositions = useCallback((routes: ActiveRoute[], positions: TruckPositionMessage[]) => {
        const routeByLineId = new Map(routes.map((route) => [route.lineId, route]));
        const now = performance.now();
        positions.forEach((message) => {
            const route = routeByLineId.get(message.lineId);
            if (!route) return;
            if (message.status === 'finished') {
                completedRouteIdsRef.current.add(message.lineId);
                return;
            }
            if (message.position && !acceptPositionSample(message)) return;
            Object.assign(route, positionDetailsPatch(message));
            if (!message.position) return;
            applyTruckPositionToRoute(route, message, now);
            route.hasRealPosition = true;
            saveTruckPositionToCache({
                lineId: message.lineId,
                position: message.position,
                status: message.status,
                speedKmh: route.speedKmh,
                updatedAt: new Date().toISOString(),
            });
        });
        return routes.filter((route) => !completedRouteIdsRef.current.has(route.lineId));
    }, [acceptPositionSample]);

    const finishRoute = useCallback((lineId: string) => {
        const alreadyFinished = completedRouteIdsRef.current.has(lineId);
        const route = activeRoutesRef.current.get(lineId);
        completedRouteIdsRef.current.add(lineId);
        activeRoutesRef.current.delete(lineId);
        if (route) roadMapRef.current?.removeRoadPath(sceneRouteId(route));
        setRouteOrders((prev) =>
            prev.map((item) => (item.lineId === lineId ? {...item, status: '已完成'} : item))
        );
        if (!alreadyFinished) onRouteFinished?.(lineId);
    }, [onRouteFinished, roadMapRef]);

    const handleTruckPosition = useCallback(
        (message: TruckPositionMessage, forceCalibration = false) => {
            // 兼容旧调用签名；正式链对所有通过时序校验的位置包都立即校准。
            void forceCalibration;
            const route = activeRoutesRef.current.get(message.lineId);
            if (!route) return;

            if (message.status === 'finished') {
                finishRoute(message.lineId);
                return;
            }
            if (message.position && !acceptPositionSample(message)) return;

            const detailPatch = positionDetailsPatch(message);
            Object.assign(route, detailPatch);
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
            let routeReplaced = false;
            if (message.routeCoordinates && message.routeCoordinates.length >= 2
                && Number(message.routeRevision) > Number(route.routeRevision ?? 0)) {
                const correctedCoordinates = message.routeCoordinates;
                route.routeRevision = message.routeRevision;
                route.coordinates = correctedCoordinates;
                route.routeNodes = correctedCoordinates.map((point) => [point[0], point[1]]);
                route.fromCoords = correctedCoordinates[0];
                route.toCoords = correctedCoordinates[correctedCoordinates.length - 1];
                route.pathLength = pathLength(correctedCoordinates);
                route.routeLengthKm = message.routeLengthKm ?? pathLengthKm(correctedCoordinates);
                route.fallbackDuration = message.travelDurationMs ?? route.fallbackDuration;
                route.pathKey = message.pathKey ?? route.pathKey;
                routeReplaced = true;
            }

            applyTruckPositionToRoute(route, message, now);
            route.hasRealPosition = true;

            if (routeReplaced) {
                // 校准完成后再换线，并在同一调用内恢复权威进度，禁止出现 0% 中间帧。
                syncRoadRoute(route);
            }

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
                    colorKey: route.colorKey,
                    isRouteBranch: route.isRouteBranch,
                    ...routeProgressPatch(route, now),
                } : item));
                routeOrdersRef.current = next;
                return next;
            });
        },
        [acceptPositionSample, finishRoute, renderTruckPosition, roadMapRef, syncRoadRoute]
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
                if (route.hasRealPosition) renderTruckPosition(route, now);
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
                if (route.hasRealPosition) {
                    renderTruckPosition(route, now);
                    progressUpdates.set(route.lineId, routeProgressPatch(route, now));
                }
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
