import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { buildPlaybackChain, type ChainNode } from '../playback/chain';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import { fetchVehiclePositions } from '../services/roadApi';
import {
    adaptRenderRoute,
    fetchRm2GroupRoutes,
    fetchRm2Groups,
    type RenderRouteDTO,
    type Rm2GroupDTO,
    type Rm2GroupsDiagnostics,
    type RouteSnapshotChangedMessage,
} from '../services/renderRouteApi';
import type { ViewMode } from '../types';
import type { VehiclePositionsMessage } from './useDashboardRealtime';
import { useVehicleMotionController } from './useVehicleMotionController';

type Options = {
    roadMapRef: RefObject<RoadMap3D2Handle | null>;
    view: ViewMode;
    sceneReady: boolean;
};

function isCompletedRoute(route: RenderRouteDTO) {
    return route.status === 'finished' || route.status.includes('完成');
}

function waitForPaint() {
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

export function useRm2PlaybackController({ roadMapRef, view, sceneReady }: Options) {
    const [groups, setGroups] = useState<Rm2GroupDTO[]>([]);
    const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [diagnostics, setDiagnostics] = useState<Rm2GroupsDiagnostics | null>(null);
    const [snapshotVersion, setSnapshotVersion] = useState<string | null>(null);

    const groupsRef = useRef<Rm2GroupDTO[]>([]);
    const snapshotVersionRef = useRef('');
    const chainRef = useRef<ChainNode | null>(null);
    const currentNodeRef = useRef<ChainNode | null>(null);
    const activeGroupIdRef = useRef<string | null>(null);
    const activeRouteLineIdsRef = useRef<Set<string>>(new Set());
    const completedLineIdsByGroupRef = useRef<Map<string, Set<string>>>(new Map());
    const timerRef = useRef<number | null>(null);
    const requestRef = useRef<AbortController | null>(null);
    const generationRef = useRef(0);
    const playNodeRef = useRef<(node: ChainNode) => Promise<void>>(async () => {});

    const stopTimer = useCallback(() => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const isActiveGeneration = useCallback((generation: number) => (
        generation === generationRef.current && view === 'roadMap2' && sceneReady
    ), [sceneReady, view]);

    const mapAdapter = useMemo(() => ({
        updateVehicle: (lineId: string, position: [number, number], info: { speedKmh: number | null; status: string }) => {
            roadMapRef.current?.updateTruckPosition(lineId, position, info);
        },
        removeVehicle: (lineId: string) => roadMapRef.current?.removeRoadPath(lineId),
    }), [roadMapRef]);

    const motion = useVehicleMotionController({
        scope: 'rm2',
        viewActive: view === 'roadMap2' && sceneReady && activeGroupId !== null,
        activeGroupId,
        snapshotVersion,
        mapAdapter,
        fetchPositions: fetchVehiclePositions,
        preserveFinishedVehicle: true,
        onRouteFinished: (lineId) => {
            const groupId = activeGroupIdRef.current;
            if (!groupId) return;
            const completed = completedLineIdsByGroupRef.current.get(groupId) ?? new Set<string>();
            completed.add(lineId);
            completedLineIdsByGroupRef.current.set(groupId, completed);
            const activeLineIds = activeRouteLineIdsRef.current;
            if (activeLineIds.size > 0 && [...activeLineIds].every((id) => completed.has(id))) {
                stopTimer();
                const next = currentNodeRef.current?.next;
                if (next && next !== currentNodeRef.current) {
                    void playNodeRef.current(next);
                }
            }
        },
    });

    const findNode = useCallback((groupId: string) => {
        const head = chainRef.current?.child;
        if (!head) return null;
        let node: ChainNode | null = head;
        do {
            if (node.id === groupId) return node;
            node = node.next;
        } while (node && node !== head);
        return null;
    }, []);

    const refreshRm2 = useCallback(async () => {
        requestRef.current?.abort();
        const request = new AbortController();
        requestRef.current = request;
        try {
            const response = await fetchRm2Groups(request.signal);
            if (request.signal.aborted) return;

            const visibleGroupId = activeGroupIdRef.current;
            const filteredGroups = response.groups.flatMap((group) => {
                const completed = completedLineIdsByGroupRef.current.get(group.groupId);
                const keepsVisibleGroup = group.groupId === visibleGroupId;
                if (!completed || completed.size === 0 || keepsVisibleGroup) return [group];
                const orderLineIds = group.orderLineIds.filter((lineId) => !completed.has(lineId));
                return orderLineIds.length === 0 ? [] : [{ ...group, orderLineIds, count: orderLineIds.length }];
            });

            snapshotVersionRef.current = response.snapshotVersion;
            setSnapshotVersion(response.snapshotVersion);
            groupsRef.current = filteredGroups;
            setGroups(filteredGroups);
            setDiagnostics({ ...response.diagnostics, acceptedGroupCount: filteredGroups.length });
            chainRef.current = buildPlaybackChain(filteredGroups);

            if (!chainRef.current?.child) {
                currentNodeRef.current = null;
                activeGroupIdRef.current = null;
                setActiveGroupId(null);
                roadMapRef.current?.clearRoads();
                return;
            }

            if (!visibleGroupId) {
                void playNodeRef.current(chainRef.current.child);
                return;
            }

            const currentNode = findNode(visibleGroupId);
            if (currentNode) {
                currentNodeRef.current = currentNode;
            } else {
                void playNodeRef.current(chainRef.current.child);
            }
        } catch (error) {
            if ((error as DOMException).name !== 'AbortError') {
                console.warn('[RM2 playback] groups refresh failed', error);
            }
        }
    }, [findNode, roadMapRef]);

    const playNode = useCallback(async (node: ChainNode) => {
        stopTimer();
        requestRef.current?.abort();
        const request = new AbortController();
        requestRef.current = request;
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        currentNodeRef.current = node;
        activeGroupIdRef.current = node.id;
        setActiveGroupId(node.id);
        setIsLoading(true);

        try {
            const response = await fetchRm2GroupRoutes(node.id, snapshotVersionRef.current, request.signal);
            if (request.signal.aborted || !isActiveGeneration(generation)) return;
            if (response.mismatch) {
                await refreshRm2();
                return;
            }

            const completed = completedLineIdsByGroupRef.current.get(node.id) ?? new Set<string>();
            response.routes.filter(isCompletedRoute).forEach((route) => completed.add(route.lineId));
            if (completed.size > 0) completedLineIdsByGroupRef.current.set(node.id, completed);
            const routes = response.routes.filter((route) => !isCompletedRoute(route) && !completed.has(route.lineId));
            if (routes.length === 0) {
                const next = node.next;
                if (next && next !== node) {
                    await playNodeRef.current(next);
                } else {
                    currentNodeRef.current = null;
                    activeGroupIdRef.current = null;
                    activeRouteLineIdsRef.current.clear();
                    setActiveGroupId(null);
                    roadMapRef.current?.clearRoads();
                    await refreshRm2();
                }
                return;
            }

            const accepted = routes.map(adaptRenderRoute).filter((route): route is NonNullable<typeof route> => route !== null);
            if (accepted.length === 0) {
                const next = node.next;
                if (next && next !== node) await playNodeRef.current(next);
                return;
            }
            const acceptedLineIds = new Set(accepted.map((route) => route.lineId));
            const playableRoutes = routes.filter((route) => acceptedLineIds.has(route.lineId));

            roadMapRef.current?.clearRoads();
            activeRouteLineIdsRef.current = new Set(playableRoutes.map((route) => route.lineId));
            accepted.forEach((route) => roadMapRef.current?.addRoadPath(route.lineId, route.coordinates, {
                plate: route.plate,
                cargo: route.cargo,
                from: route.from,
                to: route.to,
                status: route.status,
                speedKmh: route.speedKmh,
                routeLengthKm: route.routeLengthKm,
                orderId: route.orderId,
                pathKey: route.pathKey,
            }));

            await waitForPaint();
            if (!isActiveGeneration(generation)) return;
            await motion.loadGroup(playableRoutes.map((route) => ({
                lineId: route.lineId,
                groupId: route.groupId,
                coordinates: route.coordinates,
                routeLengthKm: route.routeLengthKm,
                speedKmh: route.speedKmh,
                travelDurationMs: route.travelDurationMs,
                status: route.status,
            })));
            if (!isActiveGeneration(generation)) return;

            const durationMs = node.durationMs ?? 15_000;
            timerRef.current = window.setTimeout(() => {
                timerRef.current = null;
                const next = node.next;
                if (next) void playNodeRef.current(next);
            }, durationMs);
        } catch (error) {
            if ((error as DOMException).name !== 'AbortError') {
                console.warn('[RM2 playback] group load failed', { groupId: node.id, error });
                const next = node.next;
                if (next && next !== node) void playNodeRef.current(next);
            }
        } finally {
            if (isActiveGeneration(generation)) setIsLoading(false);
        }
    }, [isActiveGeneration, motion, refreshRm2, roadMapRef, stopTimer]);

    useEffect(() => {
        playNodeRef.current = playNode;
    }, [playNode]);

    const loadGroup = useCallback((groupId: string) => {
        const node = findNode(groupId);
        if (node) void playNodeRef.current(node);
    }, [findNode]);

    const handleSnapshotChanged = useCallback((message: RouteSnapshotChangedMessage) => {
        if (message.scope === 'rm2' && message.snapshotVersion !== snapshotVersionRef.current) {
            void refreshRm2();
        }
    }, [refreshRm2]);

    useEffect(() => {
        if (view !== 'roadMap2' || !sceneReady) {
            generationRef.current += 1;
            requestRef.current?.abort();
            stopTimer();
            return;
        }

        void refreshRm2();
        const timer = window.setInterval(() => void refreshRm2(), 30_000);
        return () => {
            window.clearInterval(timer);
            generationRef.current += 1;
            requestRef.current?.abort();
            stopTimer();
        };
    }, [refreshRm2, sceneReady, stopTimer, view]);

    useEffect(() => () => {
        requestRef.current?.abort();
        stopTimer();
    }, [stopTimer]);

    return {
        groups,
        activeGroupId,
        isLoading,
        diagnostics,
        loadGroup,
        refreshRm2,
        handleSnapshotChanged,
        handleVehiclePositions: motion.handlePositionFrame as (message: VehiclePositionsMessage) => void,
        playbackPhase: activeGroupId ? 'showing' : 'idle',
        isFading: false,
    };
}
