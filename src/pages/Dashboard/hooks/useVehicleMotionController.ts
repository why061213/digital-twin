import { useCallback, useEffect, useRef } from 'react';
import type { ActiveRoute, LonLat } from '../types';
import type { TruckPositionMessage, VehiclePositionsMessage } from './useDashboardRealtime';
import { POSITION_RENDER_TICK_MS } from '../constants';
import { applyTruckPositionToRoute, pathLength, pathLengthKm, predictedPosition, projectDistanceOnPath } from '../utils';

type MapAdapter = {
    updateVehicle: (lineId: string, position: LonLat, info: { speedKmh: number | null; status: string }) => void;
    removeVehicle: (lineId: string) => void;
};

type RouteSeed = {
    lineId: string;
    groupId: string;
    coordinates: LonLat[];
    routeLengthKm?: number;
    speedKmh?: number | null;
    travelDurationMs?: number;
    status?: string;
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

const OFF_ROUTE_THRESHOLD_KM = 1.5;
const WS_FLUSH_MS = 300;

export function useVehicleMotionController(options: Options) {
    const activeRoutesRef = useRef<Map<string, ActiveRoute>>(new Map());
    const positionBufferRef = useRef<Map<string, TruckPositionMessage>>(new Map());
    const completedRouteIdsRef = useRef<Set<string>>(new Set());
    const activeGroupIdRef = useRef(options.activeGroupId);
    const snapshotVersionRef = useRef(options.snapshotVersion);
    const flushTimerRef = useRef<number | null>(null);

    activeGroupIdRef.current = options.activeGroupId;
    snapshotVersionRef.current = options.snapshotVersion;

    const applyPosition = useCallback((message: TruckPositionMessage) => {
        const route = activeRoutesRef.current.get(message.lineId);
        if (!route || !message.position) return;
        if (message.status === 'finished') {
            if (completedRouteIdsRef.current.has(message.lineId)) return;
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
            return;
        }
        const projected = projectDistanceOnPath(route.coordinates, message.position);
        const projectedPosition = predictedPosition({ ...route, calibratedDistance: projected, calibratedAt: performance.now() }, performance.now());
        const dx = projectedPosition[0] - message.position[0];
        const dy = projectedPosition[1] - message.position[1];
        if (Math.hypot(dx, dy) * 111 > OFF_ROUTE_THRESHOLD_KM) return;
        applyTruckPositionToRoute(route, message, performance.now());
    }, [options]);

    const flush = useCallback(() => {
        flushTimerRef.current = null;
        const buffered = Array.from(positionBufferRef.current.values());
        positionBufferRef.current.clear();
        buffered.forEach(applyPosition);
    }, [applyPosition]);

    const handlePositionFrame = useCallback((frame: VehiclePositionsMessage) => {
        if (frame.scope !== options.scope || !options.viewActive) return;
        if (snapshotVersionRef.current && frame.snapshotVersion && frame.snapshotVersion !== snapshotVersionRef.current) return;
        frame.positions.forEach((position) => {
            if (position.groupId !== activeGroupIdRef.current || !activeRoutesRef.current.has(position.lineId)) return;
            positionBufferRef.current.set(position.lineId, position);
        });
        if (flushTimerRef.current === null) flushTimerRef.current = window.setTimeout(flush, WS_FLUSH_MS);
    }, [flush, options.scope, options.viewActive]);

    const loadGroup = useCallback(async (routes: RouteSeed[]) => {
        const now = performance.now();
        const next = new Map<string, ActiveRoute>();
        routes.forEach((seed) => {
            if (seed.coordinates.length < 2) return;
            const length = pathLength(seed.coordinates);
            next.set(seed.lineId, {
                lineId: seed.lineId, from: '', to: '', fromCoords: seed.coordinates[0], toCoords: seed.coordinates[seed.coordinates.length - 1],
                plate: '', cargo: '', status: seed.status ?? '运输中', startedAt: now,
                fallbackDuration: seed.travelDurationMs ?? 60_000, coordinates: seed.coordinates,
                calibratedAt: now, calibratedDistance: 0, pathSpeed: length / (seed.travelDurationMs ?? 60_000),
                pathLength: length, routeLengthKm: seed.routeLengthKm ?? pathLengthKm(seed.coordinates),
                speedKmh: seed.speedKmh ?? null, nextCalibrationAt: now, arrivalCheckRequested: false,
            });
        });
        activeRoutesRef.current = next;
        completedRouteIdsRef.current.clear();
        const positions = await options.fetchPositions(Array.from(next.keys()));
        positions.forEach((position) => {
            const route = next.get(position.lineId);
            if (!route
                || position.scope !== options.scope
                || position.groupId !== activeGroupIdRef.current
                || (snapshotVersionRef.current && position.snapshotVersion && position.snapshotVersion !== snapshotVersionRef.current)) return;
            applyPosition(position);
        });
    }, [applyPosition, options]);

    useEffect(() => {
        if (!options.viewActive) return;
        const timer = window.setInterval(() => {
            const now = performance.now();
            activeRoutesRef.current.forEach((route) => {
                options.mapAdapter.updateVehicle(route.lineId, predictedPosition(route, now), { speedKmh: route.speedKmh, status: route.status });
            });
        }, POSITION_RENDER_TICK_MS);
        return () => window.clearInterval(timer);
    }, [options.mapAdapter, options.viewActive]);

    useEffect(() => () => { if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current); }, []);

    return { activeRoutesRef, positionBufferRef, completedRouteIdsRef, loadGroup, handlePositionFrame };
}
