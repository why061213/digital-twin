import { useCallback, useEffect, useRef } from 'react';
import type { ActiveRoute, LonLat } from '../types';
import type { TruckPositionMessage, VehiclePositionsMessage } from './useDashboardRealtime';
import { POSITION_RENDER_TICK_MS } from '../constants';
import {
    applyTruckPositionToRoute,
    inspectRouteCorridor,
    pathLength,
    pathLengthKm,
    predictedDistance,
    predictedPosition,
    projectDistanceOnPath,
} from '../utils';

type MapAdapter = {
    updateVehicle: (lineId: string, position: LonLat, info: MotionRenderInfo) => void;
    removeVehicle: (lineId: string) => void;
    replaceRoute?: (
        lineId: string,
        coordinates: LonLat[],
        position: LonLat,
        info: MotionRenderInfo,
    ) => void;
};

type MotionRenderInfo = {
    speedKmh: number | null;
    status: string;
    routeLengthKm?: number;
    stateStr?: string;
    alarmStr?: string;
    alarmSeverity?: 'none' | 'warning' | 'critical';
    online?: boolean;
    colorKey?: string;
    isRouteBranch?: boolean;
    deviationCoordinates?: LonLat[];
};

type RouteSeed = {
    lineId: string;
    groupId: string;
    coordinates: LonLat[];
    routeLengthKm?: number;
    speedKmh?: number | null;
    travelDurationMs?: number;
    status?: string;
    routeRevision?: number;
};

type GroupContext = {
    groupId: string;
    snapshotVersion: string | null;
    initialPositions?: TruckPositionMessage[];
};

type Options = {
    scope: 'rm1' | 'rm2';
    viewActive: boolean;
    activeGroupId: string | null;
    snapshotVersion: string | null;
    mapAdapter: MapAdapter;
    fetchPositions: (lineIds: string[]) => Promise<TruckPositionMessage[]>;
    onRouteFinished?: (lineId: string) => void;
    preserveFinishedVehicle?: boolean;
};

const WS_FLUSH_MS = 300;
const ARRIVAL_RECHECK_DELAY_MS = 5_000;
const ROUTE_CORRIDOR_TOLERANCE_KM = 2;

function isTrustedRealPosition(message: TruckPositionMessage) {
    const source = message.source?.trim().toLowerCase() ?? '';
    return !message.stale
        && (source === 'real' || source === 'real-provider' || message.speedQuality === 'provider');
}

export function useVehicleMotionController(options: Options) {
    const activeRoutesRef = useRef<Map<string, ActiveRoute>>(new Map());
    const positionBufferRef = useRef<Map<string, TruckPositionMessage>>(new Map());
    const completedRouteIdsRef = useRef<Set<string>>(new Set());
    const activeGroupIdRef = useRef(options.activeGroupId);
    const snapshotVersionRef = useRef(options.snapshotVersion);
    const flushTimerRef = useRef<number | null>(null);

    useEffect(() => {
        activeGroupIdRef.current = options.activeGroupId;
        snapshotVersionRef.current = options.snapshotVersion;
    }, [options.activeGroupId, options.snapshotVersion]);

    const applyPosition = useCallback((message: TruckPositionMessage) => {
        const route = activeRoutesRef.current.get(message.lineId);
        if (!route) return false;
        if (message.status === 'finished') {
            if (completedRouteIdsRef.current.has(message.lineId)) return false;
            completedRouteIdsRef.current.add(message.lineId);
            if (options.preserveFinishedVehicle) {
                route.status = 'finished';
                route.calibratedDistance = route.pathLength;
                route.calibratedAt = performance.now();
                route.pathSpeed = 0;
            } else {
                activeRoutesRef.current.delete(message.lineId);
                options.mapAdapter.removeVehicle(message.lineId);
            }
            options.onRouteFinished?.(message.lineId);
            return true;
        }
        if (!message.position) return false;
        route.stateStr = message.stateStr ?? route.stateStr;
        route.alarmStr = message.alarmStr ?? route.alarmStr;
        route.alarmSeverity = message.alarmSeverity ?? route.alarmSeverity;
        route.online = message.online ?? route.online;
        const now = performance.now();
        if (message.routeCoordinates && message.routeCoordinates.length >= 2
            && Number(message.routeRevision) > Number(route.routeRevision ?? 0)) {
            const corrected = message.routeCoordinates;
            route.routeRevision = message.routeRevision;
            route.routeNodes = corrected.map((point) => [point[0], point[1]]);
            route.coordinates = corrected;
            route.pathLength = pathLength(corrected);
            route.routeLengthKm = message.routeLengthKm ?? pathLengthKm(corrected);
            route.fallbackDuration = message.travelDurationMs ?? route.fallbackDuration;
            route.calibratedDistance = message.position
                ? projectDistanceOnPath(corrected, message.position)
                : 0;
            route.calibratedAt = now;
            route.pathSpeed = route.speedKmh !== null && route.routeLengthKm > 0
                ? route.speedKmh / 3_600_000 * route.pathLength / route.routeLengthKm
                : route.pathSpeed;
            options.mapAdapter.replaceRoute?.(route.lineId, corrected, message.position ?? corrected[0], {
                speedKmh: route.speedKmh,
                status: route.status,
                routeLengthKm: route.routeLengthKm,
                stateStr: route.stateStr,
                alarmStr: route.alarmStr,
                alarmSeverity: route.alarmSeverity,
                online: route.online,
                colorKey: message.colorKey,
                isRouteBranch: message.isRouteBranch,
                deviationCoordinates: message.deviationCoordinates,
            });
        }
        const routeNodes = route.routeNodes ?? route.coordinates;
        const corridor = inspectRouteCorridor(
            routeNodes,
            message.position,
            ROUTE_CORRIDOR_TOLERANCE_KM,
        );

        if (isTrustedRealPosition(message) && !corridor.inside && !message.routeCoordinates) {
            console.info('[RM2 motion] waiting for backend route correction', {
                lineId: route.lineId,
                distanceFromCorridorKm: Number(corridor.distanceKm.toFixed(3)),
                toleranceKm: ROUTE_CORRIDOR_TOLERANCE_KM,
            });
            return false;
        }
        applyTruckPositionToRoute(route, message, now);
        return true;
    }, [options]);

    const verifyPredictedArrivals = useCallback(async (lineIds: string[]) => {
        const candidates = [...new Set(lineIds)].filter((lineId) => {
            const route = activeRoutesRef.current.get(lineId);
            if (!route || route.arrivalCheckRequested) return false;
            route.arrivalCheckRequested = true;
            return true;
        });
        if (candidates.length === 0) return;

        try {
            const positions = await options.fetchPositions(candidates);
            const returnedLineIds = new Set(positions.map((position) => position.lineId));
            positions.forEach(applyPosition);

            const retryAt = performance.now() + ARRIVAL_RECHECK_DELAY_MS;
            candidates.forEach((lineId) => {
                const route = activeRoutesRef.current.get(lineId);
                if (!route) return;
                // 非完成响应已经通过 applyTruckPositionToRoute 拉回可信进度；
                // 空响应则稍后重试，避免每个渲染 tick 都重复请求。
                if (!returnedLineIds.has(lineId)) route.nextCalibrationAt = retryAt;
                route.arrivalCheckRequested = false;
            });
        } catch (error) {
            console.warn('[vehicle motion] arrival verification failed', error);
            const retryAt = performance.now() + ARRIVAL_RECHECK_DELAY_MS;
            candidates.forEach((lineId) => {
                const route = activeRoutesRef.current.get(lineId);
                if (!route) return;
                route.arrivalCheckRequested = false;
                route.nextCalibrationAt = retryAt;
            });
        }
    }, [applyPosition, options]);

    const flush = useCallback(() => {
        flushTimerRef.current = null;
        const buffered = Array.from(positionBufferRef.current.values());
        positionBufferRef.current.clear();
        buffered.forEach(applyPosition);
    }, [applyPosition]);

    const handlePositionFrame = useCallback((frame: VehiclePositionsMessage) => {
        if (frame.scope !== options.scope || !options.viewActive) return;
        if (snapshotVersionRef.current && frame.snapshotVersion && frame.snapshotVersion !== snapshotVersionRef.current) {
            console.info('[RM2 motion] ignored stale position frame', {
                expectedSnapshotVersion: snapshotVersionRef.current,
                receivedSnapshotVersion: frame.snapshotVersion,
                positionCount: frame.positions.length,
            });
            return;
        }
        let accepted = 0;
        let wrongGroup = 0;
        let unknownLine = 0;
        frame.positions.forEach((position) => {
            if (!activeRoutesRef.current.has(position.lineId)) {
                unknownLine += 1;
                return;
            }
            if (position.groupId !== activeGroupIdRef.current) {
                wrongGroup += 1;
                return;
            }
            positionBufferRef.current.set(position.lineId, position);
            accepted += 1;
        });
        if (accepted === 0 && frame.positions.length > 0) {
            console.info('[RM2 motion] ignored position frame', {
                activeGroupId: activeGroupIdRef.current,
                receivedLineIds: frame.positions.map((position) => position.lineId),
                receivedGroupIds: [...new Set(frame.positions.map((position) => position.groupId ?? ''))],
                wrongGroup,
                unknownLine,
            });
        }
        if (flushTimerRef.current === null) flushTimerRef.current = window.setTimeout(flush, WS_FLUSH_MS);
    }, [flush, options.scope, options.viewActive]);

    const loadGroup = useCallback(async (routes: RouteSeed[], context?: GroupContext) => {
        // React state is intentionally asynchronous. Update these guards before the
        // batch request so its first response belongs to the group being rendered.
        if (context) {
            activeGroupIdRef.current = context.groupId;
            snapshotVersionRef.current = context.snapshotVersion;
        }
        const now = performance.now();
        const next = new Map<string, ActiveRoute>();
        routes.forEach((seed) => {
            if (seed.coordinates.length < 2) return;
            const length = pathLength(seed.coordinates);
            next.set(seed.lineId, {
                lineId: seed.lineId, from: '', to: '', fromCoords: seed.coordinates[0], toCoords: seed.coordinates[seed.coordinates.length - 1],
                plate: '', cargo: '', status: seed.status ?? '运输中', startedAt: now,
                fallbackDuration: seed.travelDurationMs ?? 60_000, coordinates: seed.coordinates,
                routeNodes: seed.coordinates.map((point) => [point[0], point[1]]),
                calibratedAt: now, calibratedDistance: 0, pathSpeed: length / (seed.travelDurationMs ?? 60_000),
                pathLength: length, routeLengthKm: seed.routeLengthKm ?? pathLengthKm(seed.coordinates),
                speedKmh: seed.speedKmh ?? null, nextCalibrationAt: now, arrivalCheckRequested: false,
                routeRevision: seed.routeRevision,
            });
        });
        activeRoutesRef.current = next;
        completedRouteIdsRef.current.clear();
        const positions = context?.initialPositions ?? await options.fetchPositions(Array.from(next.keys()));
        let accepted = 0;
        let wrongScope = 0;
        let inactiveLine = 0;
        positions.forEach((position) => {
            const route = next.get(position.lineId);
            if (!route) {
                inactiveLine += 1;
                return;
            }
            if (position.scope !== options.scope) {
                wrongScope += 1;
                return;
            }
            // This REST request was made exclusively for `next`. A snapshot may
            // change while it is in flight; accepting its current coordinates is
            // safer than leaving every truck at the synthetic route origin.
            if (applyPosition(position)) accepted += 1;
        });
        console.info('[RM2 motion] initial position batch', {
            groupId: activeGroupIdRef.current,
            source: context?.initialPositions ? 'routes-response' : 'positions-query',
            requestedLineIds: [...next.keys()],
            received: positions.length,
            accepted,
            wrongScope,
            inactiveLine,
        });
    }, [applyPosition, options]);

    useEffect(() => {
        if (!options.viewActive) return;
        const timer = window.setInterval(() => {
            const now = performance.now();
            const arrivalCandidates: string[] = [];
            activeRoutesRef.current.forEach((route) => {
                options.mapAdapter.updateVehicle(route.lineId, predictedPosition(route, now), {
                    speedKmh: route.speedKmh,
                    status: route.status,
                    stateStr: route.stateStr,
                    alarmStr: route.alarmStr,
                    alarmSeverity: route.alarmSeverity,
                    online: route.online,
                });
                const reachedPredictedEnd = route.pathLength > 0
                    && predictedDistance(route, now) >= route.pathLength - 0.0001;
                if (reachedPredictedEnd && !route.arrivalCheckRequested && now >= route.nextCalibrationAt) {
                    arrivalCandidates.push(route.lineId);
                }
            });
            if (arrivalCandidates.length > 0) void verifyPredictedArrivals(arrivalCandidates);
        }, POSITION_RENDER_TICK_MS);
        return () => window.clearInterval(timer);
    }, [options.mapAdapter, options.viewActive, verifyPredictedArrivals]);

    useEffect(() => () => { if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current); }, []);

    return { activeRoutesRef, positionBufferRef, completedRouteIdsRef, loadGroup, handlePositionFrame };
}
