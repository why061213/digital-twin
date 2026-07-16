import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { buildPlaybackChain, type ChainNode, type PlaybackChain } from '../playback/chain';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import {
    adaptRenderRoute,
    fetchRm2ChainStructure,
    fetchRm2GroupRoutes,
    fetchRm2Groups,
    type RenderRouteDTO,
    type Rm2ChainStructureResponse,
    type Rm2GroupDTO,
    type Rm2GroupsDiagnostics,
    type RouteSnapshotChangedMessage,
} from '../services/renderRouteApi';
import type { ActiveRoute, ViewMode } from '../types';
import type { VehiclePositionsMessage } from './useDashboardRealtime';
import { useTruckPositionController } from './useTruckPositionController';

const TOPOLOGY_REFRESH_INTERVAL_MS = 60_000;
const TOPOLOGY_REFRESH_DEBOUNCE_MS = 250;

type Options = {
    roadMapRef: RefObject<RoadMap3D2Handle | null>;
    view: ViewMode;
    sceneReady: boolean;
};

function isCompletedRoute(route: RenderRouteDTO) {
    return route.status === 'finished' || route.status.includes('完成');
}

function withoutCompletedVehicles(group: Rm2GroupDTO, completed: ReadonlySet<string>) {
    const vehicleLineIdsByOrderLineId = Object.fromEntries(
        Object.entries(group.vehicleLineIdsByOrderLineId)
            .map(([businessLineId, vehicleLineIds]) => [
                businessLineId,
                vehicleLineIds.filter((lineId) => !completed.has(lineId)),
            ] as const)
            .filter(([, vehicleLineIds]) => vehicleLineIds.length > 0),
    );
    const orderLineIds = Object.keys(vehicleLineIdsByOrderLineId);
    const vehicleLineIds = Object.values(vehicleLineIdsByOrderLineId).flat();
    return orderLineIds.length === 0 ? null : {
        ...group,
        count: orderLineIds.length,
        orderLineIds,
        vehicleLineIds,
        vehicleLineIdsByOrderLineId,
        vehicleCount: vehicleLineIds.length,
    };
}

function waitForPaint() {
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function sameKeys(left: readonly string[] | undefined, right: readonly string[] | undefined) {
    return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function topologySignature(structure: Rm2ChainStructureResponse, groups: readonly Rm2GroupDTO[]) {
    return JSON.stringify({
        headNodeId: structure.headNodeId,
        leafGroupIds: structure.leafGroupIds,
        nodes: structure.nodes.map((node) => ({
            nodeId: node.nodeId,
            parentNodeId: node.parentNodeId,
            nextNodeId: node.nextNodeId,
            childNodeIds: node.childNodeIds,
            key: node.key,
            renderProvinceKeys: node.renderProvinceKeys,
            index: node.index,
        })),
        groups: groups.map((group) => ({
            groupId: group.groupId,
            index: group.index,
            count: group.count,
            orderLineIds: group.orderLineIds,
            vehicleLineIds: group.vehicleLineIds,
            vehicleLineIdsByOrderLineId: group.vehicleLineIdsByOrderLineId,
            mapKey: group.mapKey,
            directionKey: group.directionKey,
            renderProvinceKeys: group.renderProvinceKeys,
        })),
    });
}

function diffGroupIds(previous: readonly Rm2GroupDTO[], next: readonly Rm2GroupDTO[]) {
    const previousById = new Map(previous.map((group) => [group.groupId, JSON.stringify(group)]));
    const nextById = new Map(next.map((group) => [group.groupId, JSON.stringify(group)]));
    return {
        addedGroupIds: [...nextById.keys()].filter((groupId) => !previousById.has(groupId)),
        removedGroupIds: [...previousById.keys()].filter((groupId) => !nextById.has(groupId)),
        changedGroupIds: [...nextById.keys()].filter((groupId) => (
            previousById.has(groupId) && previousById.get(groupId) !== nextById.get(groupId)
        )),
    };
}

export function useRm2PlaybackController({ roadMapRef, view, sceneReady }: Options) {
    const [groups, setGroups] = useState<Rm2GroupDTO[]>([]);
    const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [diagnostics, setDiagnostics] = useState<Rm2GroupsDiagnostics | null>(null);
    const snapshotVersionRef = useRef('');
    const chainRef = useRef<PlaybackChain | null>(null);
    const currentNodeRef = useRef<ChainNode | null>(null);
    const activeGroupIdRef = useRef<string | null>(null);
    const activeRouteLineIdsRef = useRef<Set<string>>(new Set());
    const completedLineIdsByGroupRef = useRef<Map<string, Set<string>>>(new Map());
    const timerRef = useRef<number | null>(null);
    const topologyRefreshTimerRef = useRef<number | null>(null);
    const groupsRequestRef = useRef<AbortController | null>(null);
    const groupRequestRef = useRef<AbortController | null>(null);
    const generationRef = useRef(0);
    const topologySignatureRef = useRef('');
    const backendGroupsRef = useRef<Rm2GroupDTO[]>([]);
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

    const handleMotionRouteFinished = useCallback((lineId: string) => {
        const groupId = activeGroupIdRef.current;
        if (!groupId) return;
        const completed = completedLineIdsByGroupRef.current.get(groupId) ?? new Set<string>();
        completed.add(lineId);
        completedLineIdsByGroupRef.current.set(groupId, completed);
        const activeLineIds = activeRouteLineIdsRef.current;
        if (activeLineIds.size > 0 && [...activeLineIds].every((id) => completed.has(id))) {
            stopTimer();
            const next = currentNodeRef.current?.playbackNext;
            if (next) void playNodeRef.current(next);
        }
    }, [stopTimer]);

    const {
        activeRoutesRef,
        completedRouteIdsRef,
        createActiveRoute,
        showRoutes,
        hydrateRoutePositions,
        handleTruckPosition,
        syncRoadRoute,
        renderTruckPosition,
        setRouteOrders,
    } = useTruckPositionController({
        roadMapRef,
        view,
        activeView: 'roadMap2',
        onRouteFinished: (lineId) => {
            handleMotionRouteFinished(lineId);
        },
    });

    const findNode = useCallback((groupId: string) => {
        return chainRef.current?.leaves.get(groupId) ?? null;
    }, []);

    const refreshRm2 = useCallback(async () => {
        groupsRequestRef.current?.abort();
        const request = new AbortController();
        groupsRequestRef.current = request;
        try {
            let structure: Rm2ChainStructureResponse | null = null;
            let response: Awaited<ReturnType<typeof fetchRm2Groups>> | null = null;
            let mismatchDetails: Record<string, unknown> = {};
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const candidateStructure = await fetchRm2ChainStructure(request.signal);
                const candidateResponse = await fetchRm2Groups(request.signal, candidateStructure.snapshotVersion);
                const structureGroupIds = new Set(candidateStructure.leafGroupIds);
                const responseGroupIds = new Set(candidateResponse.groups.map((group) => group.groupId));
                const missingFromStructure = [...responseGroupIds].filter((groupId) => !structureGroupIds.has(groupId));
                const missingFromGroups = [...structureGroupIds].filter((groupId) => !responseGroupIds.has(groupId));
                const versionMismatch = candidateResponse.mismatch
                    || candidateResponse.snapshotVersion !== candidateStructure.snapshotVersion;
                mismatchDetails = {
                    attempt: attempt + 1,
                    structureVersion: candidateStructure.snapshotVersion,
                    groupsVersion: candidateResponse.snapshotVersion,
                    versionMismatch,
                    missingFromStructure,
                    missingFromGroups,
                };
                if (!versionMismatch && missingFromStructure.length === 0 && missingFromGroups.length === 0) {
                    structure = candidateStructure;
                    response = candidateResponse;
                    break;
                }
            }
            if (request.signal.aborted) return;
            if (!structure || !response) {
                throw new Error(`RM2 structure/groups snapshot mismatch: ${JSON.stringify(mismatchDetails)}`);
            }

            const visibleGroupId = activeGroupIdRef.current;
            const structureLeafIds = new Set(structure.leafGroupIds);
            const responseGroupById = new Map(response.groups.map((group) => [group.groupId, group]));
            const structurallyAcceptedGroups = structure.leafGroupIds.flatMap((groupId) => {
                const group = responseGroupById.get(groupId);
                return group ? [group] : [];
            });
            const structureRejectedGroups = response.groups
                .filter((group) => !structureLeafIds.has(group.groupId))
                .map((group) => `${group.groupId}: missing from chain structure`);
            const filteredGroups = structurallyAcceptedGroups.flatMap((group) => {
                const completed = completedLineIdsByGroupRef.current.get(group.groupId);
                const keepsVisibleGroup = group.groupId === visibleGroupId;
                if (!completed || completed.size === 0 || keepsVisibleGroup) return [group];
                const filtered = withoutCompletedVehicles(group, completed);
                return filtered ? [filtered] : [];
            });
            const nextTopologySignature = topologySignature(structure, filteredGroups);
            if (nextTopologySignature === topologySignatureRef.current
                && response.snapshotVersion === snapshotVersionRef.current) {
                return;
            }
            const groupDiff = diffGroupIds(backendGroupsRef.current, response.groups);
            console.info('[RM2 topology diff]', {
                snapshotVersion: response.snapshotVersion,
                hadPreviousTopology: topologySignatureRef.current.length > 0,
                ...groupDiff,
            });
            const playableGroupIds = new Set(filteredGroups.map((group) => group.groupId));
            let fallbackGroupId: string | null = null;
            let fallbackNode = currentNodeRef.current?.playbackNext ?? null;
            const previousLeafCount = chainRef.current?.leaves.size ?? 0;
            for (let visited = 0; fallbackNode && visited < previousLeafCount; visited += 1) {
                if (fallbackNode.groupId && playableGroupIds.has(fallbackNode.groupId)) {
                    fallbackGroupId = fallbackNode.groupId;
                    break;
                }
                fallbackNode = fallbackNode.playbackNext;
            }

            snapshotVersionRef.current = response.snapshotVersion;
            topologySignatureRef.current = nextTopologySignature;
            backendGroupsRef.current = response.groups;
            setGroups(filteredGroups);
            setDiagnostics({
                ...response.diagnostics,
                acceptedGroupCount: filteredGroups.length,
                rejectedGroups: [...response.diagnostics.rejectedGroups, ...structureRejectedGroups],
            });
            chainRef.current = buildPlaybackChain(structure, filteredGroups);

            if (!chainRef.current.headLeaf) {
                currentNodeRef.current = null;
                activeGroupIdRef.current = null;
                setActiveGroupId(null);
                activeRoutesRef.current.clear();
                setRouteOrders([]);
                roadMapRef.current?.clearRoads();
                return;
            }

            if (!visibleGroupId) {
                void playNodeRef.current(chainRef.current.headLeaf);
                return;
            }

            const currentNode = findNode(visibleGroupId);
            if (currentNode) {
                currentNodeRef.current = currentNode;
                void playNodeRef.current(currentNode);
            } else {
                void playNodeRef.current(
                    (fallbackGroupId ? findNode(fallbackGroupId) : null) ?? chainRef.current.headLeaf,
                );
            }
        } catch (error) {
            if ((error as DOMException).name !== 'AbortError') {
                console.warn('[RM2 playback] groups refresh failed', error);
            }
        }
    }, [activeRoutesRef, findNode, roadMapRef, setRouteOrders]);

    const playNode = useCallback(async (node: ChainNode) => {
        stopTimer();
        groupRequestRef.current?.abort();
        const request = new AbortController();
        groupRequestRef.current = request;
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        const previousNode = currentNodeRef.current;
        const previousGroupId = activeGroupIdRef.current;
        const previousLineIds = new Set(activeRoutesRef.current.keys());
        const provinceChanged = previousNode?.provinceKey !== node.provinceKey
            || !sameKeys(previousNode?.provinceMapKeys, node.provinceMapKeys);
        const directionChanged = provinceChanged
            || previousNode?.directionKey !== node.directionKey
            || !sameKeys(previousNode?.directionMapKeys, node.directionMapKeys);
        currentNodeRef.current = node;
        activeGroupIdRef.current = node.id;
        setActiveGroupId(node.id);
        setIsLoading(true);

        try {
            const directionMapKeys = (node.directionMapKeys ?? [])
                .filter((key) => key !== node.provinceKey);
            const mapPreparations: Promise<void>[] = [];
            if (provinceChanged && node.provinceKey) {
                mapPreparations.push(roadMapRef.current?.preloadProvinceRegion(node.provinceKey) ?? Promise.resolve());
            }
            if (directionChanged && node.directionKey && directionMapKeys.length > 0) {
                mapPreparations.push(
                    roadMapRef.current?.preloadDirectionRegions(node.directionKey, directionMapKeys)
                    ?? Promise.resolve(),
                );
            }
            await Promise.all(mapPreparations);
            if (request.signal.aborted || !isActiveGeneration(generation)) return;

            if (provinceChanged || directionChanged) {
                roadMapRef.current?.clearRoads();
                activeRoutesRef.current.clear();
                activeRouteLineIdsRef.current.clear();
                setRouteOrders([]);
            }
            if (provinceChanged && node.provinceKey) {
                // 新始发省已在上一节点尾部预装；头节点只提升新层并释放旧层。
                await roadMapRef.current?.setProvinceRegion(node.provinceKey);
                if (request.signal.aborted || !isActiveGeneration(generation)) return;
            }
            if (directionChanged && node.directionKey) {
                // 方向层仅替换目的省和途经省，始发省图层保持不动。
                if (directionMapKeys.length > 0) {
                    await roadMapRef.current?.setDirectionRegions(node.directionKey, directionMapKeys);
                } else {
                    roadMapRef.current?.clearDirectionRegions();
                }
                if (request.signal.aborted || !isActiveGeneration(generation)) return;
            }

            const response = await fetchRm2GroupRoutes(node.id, snapshotVersionRef.current, request.signal);
            if (request.signal.aborted || !isActiveGeneration(generation)) return;
            if (response.mismatch) {
                await refreshRm2();
                return;
            }

            const completed = completedLineIdsByGroupRef.current.get(node.id) ?? new Set<string>();
            response.routes.filter(isCompletedRoute).forEach((route) => completed.add(route.lineId));
            response.positions
                .filter((position) => position.status === 'finished')
                .forEach((position) => completed.add(position.lineId));
            if (completed.size > 0) completedLineIdsByGroupRef.current.set(node.id, completed);
            const routes = response.routes.filter((route) => !isCompletedRoute(route) && !completed.has(route.lineId));
            if (routes.length === 0) {
                const next = node.playbackNext;
                if (next && next !== node) {
                    await playNodeRef.current(next);
                } else {
                    currentNodeRef.current = null;
                    activeGroupIdRef.current = null;
                    activeRouteLineIdsRef.current.clear();
                    setActiveGroupId(null);
                    activeRoutesRef.current.clear();
                    setRouteOrders([]);
                    roadMapRef.current?.clearRoads();
                    await refreshRm2();
                }
                return;
            }

            const accepted = routes.map(adaptRenderRoute).filter((route): route is NonNullable<typeof route> => route !== null);
            if (accepted.length === 0) {
                const next = node.playbackNext;
                if (next && next !== node) await playNodeRef.current(next);
                return;
            }
            accepted.forEach((route) => completedRouteIdsRef.current.delete(route.lineId));
            let activeRoutes = accepted
                .map(createActiveRoute)
                .filter((route): route is ActiveRoute => route !== null);
            activeRoutes = hydrateRoutePositions(activeRoutes, response.positions);
            if (activeRoutes.length === 0) {
                const next = node.playbackNext;
                if (next && next !== node) await playNodeRef.current(next);
                else await refreshRm2();
                return;
            }

            activeRoutesRef.current = new Map(activeRoutes.map((route) => [route.lineId, route]));
            activeRouteLineIdsRef.current = new Set(activeRoutes.map((route) => route.lineId));
            setRouteOrders(activeRoutes);

            if (previousGroupId !== node.id) {
                roadMapRef.current?.clearRoads();
                showRoutes(activeRoutes);
            } else {
                const nextLineIds = new Set(activeRoutes.map((route) => route.lineId));
                previousLineIds.forEach((lineId) => {
                    if (!nextLineIds.has(lineId)) roadMapRef.current?.removeRoadPath(lineId);
                });
                const now = performance.now();
                activeRoutes.forEach((route) => {
                    if (!previousLineIds.has(route.lineId)) syncRoadRoute(route);
                    renderTruckPosition(route, now);
                });
            }

            await waitForPaint();
            if (!isActiveGeneration(generation)) return;

            const next = node.playbackNext;
            if (next && next !== node) {
                const nextDirectionMapKeys = (next.directionMapKeys ?? [])
                    .filter((key) => key !== next.provinceKey);
                const nextProvinceChanged = next.provinceKey !== node.provinceKey
                    || !sameKeys(next.provinceMapKeys, node.provinceMapKeys);
                const nextDirectionChanged = nextProvinceChanged
                    || next.directionKey !== node.directionKey
                    || !sameKeys(next.directionMapKeys, node.directionMapKeys);
                const tailPreloads: Promise<void>[] = [];
                if (nextProvinceChanged && next.provinceKey) {
                    tailPreloads.push(
                        roadMapRef.current?.preloadProvinceRegion(next.provinceKey) ?? Promise.resolve(),
                    );
                }
                if (nextDirectionChanged && next.directionKey && nextDirectionMapKeys.length > 0) {
                    tailPreloads.push(
                        roadMapRef.current?.preloadDirectionRegions(next.directionKey, nextDirectionMapKeys)
                        ?? Promise.resolve(),
                    );
                }
                void Promise.all(tailPreloads).catch((error) => {
                    if ((error as DOMException).name !== 'AbortError') {
                        console.warn('[RM2 playback] next map preload failed', {
                            currentGroupId: node.id,
                            nextGroupId: next.id,
                            error,
                        });
                    }
                });
            }

            const durationMs = node.durationMs ?? 15_000;
            timerRef.current = window.setTimeout(() => {
                timerRef.current = null;
                if (next) void playNodeRef.current(next);
            }, durationMs);
        } catch (error) {
            if ((error as DOMException).name !== 'AbortError') {
                console.warn('[RM2 playback] group load failed', { groupId: node.id, error });
                const next = node.playbackNext;
                if (next && next !== node) void playNodeRef.current(next);
            }
        } finally {
            if (isActiveGeneration(generation)) setIsLoading(false);
        }
    }, [activeRoutesRef, completedRouteIdsRef, createActiveRoute, hydrateRoutePositions, isActiveGeneration, refreshRm2, renderTruckPosition, roadMapRef, setRouteOrders, showRoutes, stopTimer, syncRoadRoute]);

    useEffect(() => {
        playNodeRef.current = playNode;
    }, [playNode]);

    const loadGroup = useCallback((groupId: string) => {
        const node = findNode(groupId);
        if (node) void playNodeRef.current(node);
    }, [findNode]);

    const handleSnapshotChanged = useCallback((message: RouteSnapshotChangedMessage) => {
        if (view !== 'roadMap2' || !sceneReady) return;
        if (message.scope === 'rm2' && message.snapshotVersion !== snapshotVersionRef.current) {
            if (topologyRefreshTimerRef.current !== null) {
                window.clearTimeout(topologyRefreshTimerRef.current);
            }
            topologyRefreshTimerRef.current = window.setTimeout(() => {
                topologyRefreshTimerRef.current = null;
                void refreshRm2();
            }, TOPOLOGY_REFRESH_DEBOUNCE_MS);
        }
    }, [refreshRm2, sceneReady, view]);

    const handleVehiclePositions = useCallback((message: VehiclePositionsMessage) => {
        if (view !== 'roadMap2' || !sceneReady || message.scope !== 'rm2') return;
        if (message.snapshotVersion && message.snapshotVersion !== snapshotVersionRef.current) return;
        message.positions.forEach((position) => {
            if (position.scope !== 'rm2') return;
            if (position.groupId !== activeGroupIdRef.current) return;
            if (!activeRouteLineIdsRef.current.has(position.lineId)) return;
            handleTruckPosition(position);
        });
    }, [handleTruckPosition, sceneReady, view]);

    useEffect(() => {
        if (view !== 'roadMap2' || !sceneReady) {
            generationRef.current += 1;
            groupsRequestRef.current?.abort();
            groupRequestRef.current?.abort();
            stopTimer();
            return;
        }

        void refreshRm2();
        const topologyInterval = window.setInterval(
            () => void refreshRm2(),
            TOPOLOGY_REFRESH_INTERVAL_MS,
        );
        return () => {
            window.clearInterval(topologyInterval);
            generationRef.current += 1;
            groupsRequestRef.current?.abort();
            groupRequestRef.current?.abort();
            if (topologyRefreshTimerRef.current !== null) {
                window.clearTimeout(topologyRefreshTimerRef.current);
                topologyRefreshTimerRef.current = null;
            }
            stopTimer();
        };
    }, [refreshRm2, sceneReady, stopTimer, view]);

    useEffect(() => () => {
        groupsRequestRef.current?.abort();
        groupRequestRef.current?.abort();
        if (topologyRefreshTimerRef.current !== null) {
            window.clearTimeout(topologyRefreshTimerRef.current);
        }
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
        handleVehiclePositions,
        playbackPhase: activeGroupId ? 'showing' : 'idle',
        isFading: false,
    };
}
