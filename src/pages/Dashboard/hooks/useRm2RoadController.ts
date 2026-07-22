import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import { createRm2SceneAdapter } from '../playback/rm2SceneAdapter';
import { useRouteGroupPlaybackController } from '../playback/useRouteGroupPlaybackController';
import { useVehicleMotionController } from './useVehicleMotionController';
import { fetchVehiclePositions } from '../services/roadApi';
import {
    fetchRm2GroupRoutes,
    fetchRm2Groups,
    type RenderRouteDTO,
    type Rm2GroupDTO,
    type Rm2GroupsDiagnostics,
    type RouteSnapshotChangedMessage,
} from '../services/renderRouteApi';
import type { ViewMode } from '../types';

const FIXTURE_GROUPS: Rm2GroupDTO[] = [
    { groupId: 'rm2-fixture-fs-gz', groupName: '佛山 - 广州', index: 0, count: 1, orderLineIds: ['RM2-FS-GZ::line-0'], vehicleLineIds: ['rm2-fs-gz-01', 'rm2-fs-gz-02'], vehicleLineIdsByOrderLineId: { 'RM2-FS-GZ::line-0': ['rm2-fs-gz-01', 'rm2-fs-gz-02'] }, vehicleCount: 2, mapKey: '440000', fromProvinceKey: '440000', toProvinceKey: '440000', directionKey: '440000:440000', renderProvinceKeys: ['440000'], pageIndex: 1 },
    { groupId: 'rm2-fixture-dg-sz', groupName: '东莞 - 深圳', index: 1, count: 1, orderLineIds: ['RM2-DG-SZ::line-0'], vehicleLineIds: ['rm2-dg-sz-01', 'rm2-dg-sz-02'], vehicleLineIdsByOrderLineId: { 'RM2-DG-SZ::line-0': ['rm2-dg-sz-01', 'rm2-dg-sz-02'] }, vehicleCount: 2, mapKey: '440000', fromProvinceKey: '440000', toProvinceKey: '440000', directionKey: '440000:440000', renderProvinceKeys: ['440000'], pageIndex: 2 },
    { groupId: 'rm2-fixture-zs-zh', groupName: '中山 - 珠海', index: 2, count: 1, orderLineIds: ['RM2-ZS-ZH::line-0'], vehicleLineIds: ['rm2-zs-zh-01'], vehicleLineIdsByOrderLineId: { 'RM2-ZS-ZH::line-0': ['rm2-zs-zh-01'] }, vehicleCount: 1, mapKey: '440000', fromProvinceKey: '440000', toProvinceKey: '440000', directionKey: '440000:440000', renderProvinceKeys: ['440000'], pageIndex: 3 },
];

function fixtureRoute(lineId: string, orderId: string, plate: string, cargo: string, from: string, to: string, groupId: string, pathKey: string, coordinates: [number, number][]): RenderRouteDTO {
    return { lineId, orderId, businessLineId: `${orderId}::line-0`, plate, cargo, from, to, groupId, pathKey, coordinates, fromCoords: coordinates[0], toCoords: coordinates[coordinates.length - 1], routeLengthKm: 36, speedKmh: 42, status: '运输中', travelDurationMs: 2_712_000, scope: 'rm2', role: 'primary', coordinateSystem: 'GCJ02', routeSignature: `${lineId}-fixture` };
}

const FIXTURE_ROUTES: RenderRouteDTO[] = [
    fixtureRoute('rm2-fs-gz-01', 'RM2-FS-GZ', '粤E63962', '18吨', '佛山南海', '广州白云', 'rm2-fixture-fs-gz', 'rm2-foshan-guangzhou', [[113.145, 23.045], [113.225, 23.095], [113.315, 23.155], [113.365, 23.245]]),
    fixtureRoute('rm2-fs-gz-02', 'RM2-FS-GZ', '粤E05619D', '15吨', '佛山南海', '广州白云', 'rm2-fixture-fs-gz', 'rm2-foshan-guangzhou', [[113.145, 23.045], [113.225, 23.095], [113.315, 23.155], [113.365, 23.245]]),
    fixtureRoute('rm2-dg-sz-01', 'RM2-DG-SZ', '粤S88520', '12吨', '东莞松山湖', '深圳龙华', 'rm2-fixture-dg-sz', 'rm2-dongguan-shenzhen', [[113.92, 22.91], [113.98, 22.84], [114.055, 22.77], [114.10, 22.71]]),
    fixtureRoute('rm2-dg-sz-02', 'RM2-DG-SZ', '粤B71208', '10吨', '东莞松山湖', '深圳龙华', 'rm2-fixture-dg-sz', 'rm2-dongguan-shenzhen', [[113.92, 22.91], [113.98, 22.84], [114.055, 22.77], [114.10, 22.71]]),
    fixtureRoute('rm2-zs-zh-01', 'RM2-ZS-ZH', '粤T52601', '9吨', '中山坦洲', '珠海香洲', 'rm2-fixture-zs-zh', 'rm2-zhongshan-zhuhai', [[113.49, 22.47], [113.535, 22.42], [113.575, 22.36]]),
];

const FIXTURE_DIAGNOSTICS: Rm2GroupsDiagnostics = { snapshotVersion: 'fixture-fallback', totalRoutes: FIXTURE_ROUTES.length, backendGroupCount: FIXTURE_GROUPS.length, acceptedGroupCount: FIXTURE_GROUPS.length, rejectedGroups: [] };
type Options = { roadMapRef: RefObject<RoadMap3D2Handle | null>; view: ViewMode; sceneReady: boolean };

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

export function useRm2RoadController({ roadMapRef, view, sceneReady }: Options) {
    const [diagnostics, setDiagnostics] = useState<Rm2GroupsDiagnostics | null>(null);
    const sourceRef = useRef<'backend' | 'fixture'>('backend');
    const snapshotVersionRef = useRef<string>('');
    const groupRoutesCacheRef = useRef<Map<string, RenderRouteDTO[]>>(new Map());
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const sceneAdapterRef = useRef<ReturnType<typeof createRm2SceneAdapter> | null>(null);
    const motionLoadRef = useRef<(routes: Array<{ lineId: string; groupId: string; coordinates: [number, number][]; routeLengthKm?: number; speedKmh?: number | null; travelDurationMs?: number; status?: string }>) => Promise<void>>(async () => {});
    const completedLineIdsByGroupRef = useRef<Map<string, Set<string>>>(new Map());
    const playbackRef = useRef<{ activeGroupId: string | null; phase: string }>({ activeGroupId: null, phase: 'idle' });

    useEffect(() => {
        sceneAdapterRef.current = createRm2SceneAdapter(roadMapRef);
        return () => sceneAdapterRef.current?.clearRenderedGroup();
    }, [roadMapRef]);

    const cacheKey = (version: string, gid: string) => `${version}:${gid}`;

    const filterCompletedRoutes = useCallback((groupId: string, routes: readonly RenderRouteDTO[]) => {
        const completedLineIds = completedLineIdsByGroupRef.current.get(groupId);
        return routes.filter((route) => !isCompletedRoute(route) && !completedLineIds?.has(route.lineId));
    }, []);

    const rememberCompletedRoutes = useCallback((groupId: string, routes: readonly RenderRouteDTO[]) => {
        const completed = routes.filter(isCompletedRoute);
        if (completed.length === 0) return;
        const completedLineIds = completedLineIdsByGroupRef.current.get(groupId) ?? new Set<string>();
        completed.forEach((route) => completedLineIds.add(route.lineId));
        completedLineIdsByGroupRef.current.set(groupId, completedLineIds);
    }, []);

    const filterCompletedGroups = useCallback((groups: readonly Rm2GroupDTO[]) => (
        groups.flatMap((group) => {
            const isCurrentlyPlaying = playbackRef.current.activeGroupId === group.groupId
                && (playbackRef.current.phase === 'showing' || playbackRef.current.phase === 'transitioning');
            if (isCurrentlyPlaying) return [group];

            const completedLineIds = completedLineIdsByGroupRef.current.get(group.groupId);
            if (!completedLineIds || completedLineIds.size === 0) return [group];

            const filtered = withoutCompletedVehicles(group, completedLineIds);
            return filtered ? [filtered] : [];
        })
    ), []);

    const fetchGroups = useCallback(async (signal?: AbortSignal) => {
        try {
            const response = await fetchRm2Groups(signal);
            sourceRef.current = 'backend';
            if (response.snapshotVersion !== snapshotVersionRef.current) {
                groupRoutesCacheRef.current.clear();
                snapshotVersionRef.current = response.snapshotVersion;
            }
            const groups = filterCompletedGroups(response.groups);
            setDiagnostics({
                ...response.diagnostics,
                acceptedGroupCount: groups.length,
            });
            return { snapshotVersion: response.snapshotVersion, groups };
        } catch (error) {
            if (signal?.aborted) throw error;
            if (import.meta.env.DEV && snapshotVersionRef.current.length === 0) {
                sourceRef.current = 'fixture';
                snapshotVersionRef.current = FIXTURE_DIAGNOSTICS.snapshotVersion;
                setDiagnostics(FIXTURE_DIAGNOSTICS);
                return {
                    snapshotVersion: FIXTURE_DIAGNOSTICS.snapshotVersion,
                    groups: filterCompletedGroups(FIXTURE_GROUPS),
                };
            }
            throw error;
        }
    }, [filterCompletedGroups]);

    const fetchGroupRoutes = useCallback(async (groupId: string, signal?: AbortSignal) => {
        const version = snapshotVersionRef.current;
        const cached = groupRoutesCacheRef.current.get(cacheKey(version, groupId));
        if (cached) {
            rememberCompletedRoutes(groupId, cached);
            return filterCompletedRoutes(groupId, cached);
        }

        const response = sourceRef.current === 'backend'
            ? await fetchRm2GroupRoutes(groupId, version, signal)
            : {
                routes: FIXTURE_ROUTES.filter((route) => route.groupId === groupId),
                snapshotVersion: version,
                receivedRouteCount: FIXTURE_ROUTES.filter((route) => route.groupId === groupId).length,
                mismatch: false,
            };
        if (response.mismatch) {
            groupRoutesCacheRef.current.clear();
            snapshotVersionRef.current = response.snapshotVersion;
            throw new Error(`RM2 snapshot mismatch while loading ${groupId}`);
        }
        if (response.snapshotVersion) {
            groupRoutesCacheRef.current.set(cacheKey(response.snapshotVersion, groupId), response.routes);
        }
        rememberCompletedRoutes(groupId, response.routes);
        return filterCompletedRoutes(groupId, response.routes);
    }, [filterCompletedRoutes, rememberCompletedRoutes]);

    const prepareSceneForGroup = useCallback(async (group: Rm2GroupDTO) => {
        const adapter = sceneAdapterRef.current;
        if (!adapter) throw new Error('RM2 scene adapter is not ready');
        await adapter.prepareSceneForGroup(group);
    }, []);

    const replaceRenderedGroup = useCallback(async (group: Rm2GroupDTO, routes: readonly RenderRouteDTO[]) => {
        const adapter = sceneAdapterRef.current;
        if (!adapter) throw new Error('RM2 scene adapter is not ready');
        const prepared = await adapter.prepareRoutes(group, routes);
        console.info('[RM2 render]', {
            groupId: group.groupId,
            receivedRoutes: routes.length,
            acceptedRoutes: prepared.routes.length,
            renderedLineIds: prepared.routes.map((route) => route.lineId),
            rejectedLineIds: prepared.rejectedLineIds,
        });
        await adapter.replaceRenderedGroup(prepared);
        await motionLoadRef.current(routes.map((route) => ({
            lineId: route.lineId,
            groupId: route.groupId,
            coordinates: route.coordinates,
            routeLengthKm: route.routeLengthKm,
            speedKmh: route.speedKmh,
            travelDurationMs: route.travelDurationMs,
            status: route.status,
        })));
    }, []);

    const clearRenderedGroup = useCallback(() => {
        sceneAdapterRef.current?.clearRenderedGroup();
    }, []);

    const isRouteComplete = useCallback((route: RenderRouteDTO) => isCompletedRoute(route), []);

    const getDisplayDuration = useCallback((_group: Rm2GroupDTO, routes: readonly RenderRouteDTO[]) => (
        Math.min(28_000, 10_000 + routes.length * 650)
    ), []);

    const {
        snapshotVersion,
        groups,
        activeGroupId,
        phase: playbackPhase,
        isFading,
        refreshSnapshot,
        selectGroup,
        markRouteFinished,
        pause,
        resume,
    } = useRouteGroupPlaybackController<Rm2GroupDTO, RenderRouteDTO>({
        scope: 'rm2',
        sceneReady: view === 'roadMap2' && sceneReady,
        fetchGroups,
        fetchGroupRoutes,
        prepareSceneForGroup,
        replaceRenderedGroup,
        clearRenderedGroup,
        isRouteComplete,
        getDisplayDuration,
        maxLoadRetries: 2,
        retryDelayMs: 800,
        transitionDurationMs: 500,
    });

    useEffect(() => {
        playbackRef.current = { activeGroupId, phase: playbackPhase };
    }, [activeGroupId, playbackPhase]);

    const activeRoutesRef = useRef<Map<string, RenderRouteDTO>>(new Map());

    const mapAdapter = useMemo(() => ({
        updateVehicle: (lineId: string, position: [number, number], info: {
            speedKmh: number | null;
            status: string;
            routeLengthKm?: number;
            stateStr?: string;
            alarmStr?: string;
            alarmSeverity?: 'none' | 'warning' | 'critical';
            online?: boolean;
            colorKey?: string;
            isRouteBranch?: boolean;
            deviationCoordinates?: [number, number][];
        }) => {
            roadMapRef.current?.updateTruckPosition(lineId, position, {
                speedKmh: info.speedKmh,
                status: info.status,
                stateStr: info.stateStr,
                alarmStr: info.alarmStr,
                alarmSeverity: info.alarmSeverity,
                online: info.online,
            });
        },
        removeVehicle: (lineId: string) => roadMapRef.current?.removeRoadPath(lineId),
        replaceRoute: (
            lineId: string,
            coordinates: [number, number][],
            position: [number, number],
            info: {
                speedKmh: number | null;
                status: string;
                routeLengthKm?: number;
                stateStr?: string;
                alarmStr?: string;
                alarmSeverity?: 'none' | 'warning' | 'critical';
                online?: boolean;
                colorKey?: string;
                isRouteBranch?: boolean;
                deviationCoordinates?: [number, number][];
            },
        ) => {
            const roadMap = roadMapRef.current;
            const route = activeRoutesRef.current.get(lineId);
            if (!roadMap || !route) return;
            const routeInfo = {
                plate: route.plate,
                cargo: route.cargo,
                from: route.from,
                to: route.to,
                status: info.status,
                speedKmh: info.speedKmh,
                routeLengthKm: info.routeLengthKm ?? route.routeLengthKm,
                orderId: route.orderId,
                stateStr: info.stateStr,
                alarmStr: info.alarmStr,
                alarmSeverity: info.alarmSeverity,
                online: info.online,
                colorKey: info.colorKey ?? `branch:${lineId}`,
                isRouteBranch: true,
                deviationCoordinates: info.deviationCoordinates,
                // 越界车辆从共享道路中独立出来，后续改路复用同一个稳定轨道键。
                pathKey: `${route.pathKey}::adaptive::${lineId}`,
            };
            roadMap.removeRoadPath(lineId);
            roadMap.addRoadPath(lineId, coordinates, routeInfo);
            roadMap.updateTruckPosition(lineId, position, routeInfo);
        },
    }), [roadMapRef]);

    const motion = useVehicleMotionController({
        scope: 'rm2',
        viewActive: view === 'roadMap2' && sceneReady,
        activeGroupId,
        snapshotVersion,
        mapAdapter,
        fetchPositions: fetchVehiclePositions,
        onRouteFinished: (lineId) => {
            const route = activeRoutesRef.current.get(lineId);
            if (!route) return;
            const completedLineIds = completedLineIdsByGroupRef.current.get(route.groupId) ?? new Set<string>();
            completedLineIds.add(lineId);
            completedLineIdsByGroupRef.current.set(route.groupId, completedLineIds);
            groupRoutesCacheRef.current.delete(cacheKey(snapshotVersionRef.current, route.groupId));
            markRouteFinished(route);
        },
    });
    const loadMotionGroup = motion.loadGroup;

    useEffect(() => {
        motionLoadRef.current = async (routes) => {
            activeRoutesRef.current = new Map(routes.map((route) => [route.lineId, route as RenderRouteDTO]));
            await loadMotionGroup(routes);
        };
    }, [loadMotionGroup]);

    const scheduleRefresh = useCallback((delayMs = 200) => {
        if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(() => void refreshSnapshot(), delayMs);
    }, [refreshSnapshot]);

    const handleSnapshotChanged = useCallback((msg: RouteSnapshotChangedMessage) => {
        if (msg.scope !== 'rm2' || msg.snapshotVersion === snapshotVersionRef.current) return;
        scheduleRefresh(200);
    }, [scheduleRefresh]);

    useEffect(() => {
        if (view !== 'roadMap2') {
            pause();
            return;
        }

        void resume();
        const refreshTimer = window.setInterval(() => void refreshSnapshot(), 30_000);
        return () => {
            window.clearInterval(refreshTimer);
            if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
            pause();
        };
    }, [pause, refreshSnapshot, resume, view]);

    const isLoading = playbackPhase === 'syncing'
        || playbackPhase === 'preparing-scene'
        || playbackPhase === 'loading-group'
        || playbackPhase === 'transitioning';

    return {
        groups: Array.from(groups),
        activeGroupId,
        isLoading,
        diagnostics,
        loadGroup: selectGroup,
        refreshRm2: refreshSnapshot,
        handleSnapshotChanged,
        markRouteFinished,
        handleVehiclePositions: motion.handlePositionFrame,
        playbackPhase,
        isFading,
    };
}
