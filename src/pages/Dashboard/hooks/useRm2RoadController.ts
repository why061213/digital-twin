import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import { createRm2SceneAdapter } from '../playback/rm2SceneAdapter';
import { useRouteGroupPlaybackController } from '../playback/useRouteGroupPlaybackController';
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
    { groupId: 'rm2-fixture-fs-gz', groupName: '佛山 - 广州', index: 0, count: 2, orderLineIds: ['rm2-fs-gz-01', 'rm2-fs-gz-02'], mapKey: '440000' },
    { groupId: 'rm2-fixture-dg-sz', groupName: '东莞 - 深圳', index: 1, count: 2, orderLineIds: ['rm2-dg-sz-01', 'rm2-dg-sz-02'], mapKey: '440000' },
    { groupId: 'rm2-fixture-zs-zh', groupName: '中山 - 珠海', index: 2, count: 1, orderLineIds: ['rm2-zs-zh-01'], mapKey: '440000' },
];

function fixtureRoute(lineId: string, orderId: string, plate: string, cargo: string, from: string, to: string, groupId: string, pathKey: string, coordinates: [number, number][]): RenderRouteDTO {
    return { lineId, orderId, plate, cargo, from, to, groupId, pathKey, coordinates, fromCoords: coordinates[0], toCoords: coordinates[coordinates.length - 1], routeLengthKm: 36, speedKmh: 42, status: '运输中', travelDurationMs: 2_712_000, scope: 'rm2', role: 'primary', coordinateSystem: 'GCJ02', routeSignature: `${lineId}-fixture` };
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

export function useRm2RoadController({ roadMapRef, view, sceneReady }: Options) {
    const [diagnostics, setDiagnostics] = useState<Rm2GroupsDiagnostics | null>(null);
    const sourceRef = useRef<'backend' | 'fixture'>('backend');
    const snapshotVersionRef = useRef<string>('');
    const groupRoutesCacheRef = useRef<Map<string, RenderRouteDTO[]>>(new Map());
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const sceneAdapterRef = useRef<ReturnType<typeof createRm2SceneAdapter> | null>(null);

    useEffect(() => {
        sceneAdapterRef.current = createRm2SceneAdapter(roadMapRef);
        return () => sceneAdapterRef.current?.clearRenderedGroup();
    }, [roadMapRef]);

    const cacheKey = (version: string, gid: string) => `${version}:${gid}`;

    const fetchGroups = useCallback(async (signal?: AbortSignal) => {
        try {
            const response = await fetchRm2Groups(signal);
            sourceRef.current = 'backend';
            if (response.snapshotVersion !== snapshotVersionRef.current) {
                groupRoutesCacheRef.current.clear();
                snapshotVersionRef.current = response.snapshotVersion;
            }
            setDiagnostics(response.diagnostics);
            return { snapshotVersion: response.snapshotVersion, groups: response.groups };
        } catch (error) {
            if (signal?.aborted) throw error;
            if (import.meta.env.DEV && snapshotVersionRef.current.length === 0) {
                sourceRef.current = 'fixture';
                snapshotVersionRef.current = FIXTURE_DIAGNOSTICS.snapshotVersion;
                setDiagnostics(FIXTURE_DIAGNOSTICS);
                return { snapshotVersion: FIXTURE_DIAGNOSTICS.snapshotVersion, groups: FIXTURE_GROUPS };
            }
            throw error;
        }
    }, []);

    const fetchGroupRoutes = useCallback(async (groupId: string, signal?: AbortSignal) => {
        const version = snapshotVersionRef.current;
        const cached = groupRoutesCacheRef.current.get(cacheKey(version, groupId));
        if (cached) return cached;

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
        return response.routes;
    }, []);

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
    }, []);

    const clearRenderedGroup = useCallback(() => {
        sceneAdapterRef.current?.clearRenderedGroup();
    }, []);

    const isRouteComplete = useCallback((route: RenderRouteDTO) => (
        route.status === 'finished' || route.status.includes('完成')
    ), []);

    const getDisplayDuration = useCallback((_group: Rm2GroupDTO, routes: readonly RenderRouteDTO[]) => (
        Math.min(28_000, 10_000 + routes.length * 650)
    ), []);

    const {
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
        playbackPhase,
        isFading,
    };
}
