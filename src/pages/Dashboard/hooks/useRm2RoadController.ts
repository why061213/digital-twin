import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import {
    adaptRenderRoute,
    fetchRm2GroupRoutes,
    fetchRm2Groups,
    type RenderRouteDTO,
    type Rm2GroupDTO,
    type Rm2GroupsDiagnostics,
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
    const [groups, setGroups] = useState<Rm2GroupDTO[]>([]);
    const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [diagnostics, setDiagnostics] = useState<Rm2GroupsDiagnostics | null>(null);
    const sourceRef = useRef<'backend' | 'fixture'>('backend');
    const activeGroupIdRef = useRef<string | null>(null);
    const groupRequestRef = useRef<AbortController | null>(null);
    const routeRequestRef = useRef<AbortController | null>(null);
    /** 请求代次：每次同步递增，旧响应直接丢弃 */
    const requestGenerationRef = useRef(0);
    /** 当前快照版本 */
    const snapshotVersionRef = useRef<string>('');
    /** 按 version:groupId 缓存路线 */
    const groupRoutesCacheRef = useRef<Map<string, RenderRouteDTO[]>>(new Map());
    /** groupId → 组信息速查 */
    const groupsByIdRef = useRef<Map<string, Rm2GroupDTO>>(new Map());

    const cacheKey = (version: string, gid: string) => `${version}:${gid}`;

    const loadGroup = useCallback(async (groupId: string) => {
        routeRequestRef.current?.abort();
        const request = new AbortController();
        routeRequestRef.current = request;
        activeGroupIdRef.current = groupId;
        setActiveGroupId(groupId);

        const gen = requestGenerationRef.current;
        const version = snapshotVersionRef.current;
        const cachedKey = cacheKey(version, groupId);
        const cached = groupRoutesCacheRef.current.get(cachedKey);

        if (cached) {
            if (gen !== requestGenerationRef.current) return;
            const accepted = cached.map(adaptRenderRoute).filter((r): r is NonNullable<typeof r> => r !== null);
            const roadMap = roadMapRef.current;
            if (roadMap) {
                roadMap.clearRoads();
                accepted.forEach((route) => {
                    roadMap.addRoadPath(route.lineId, route.coordinates, {
                        plate: route.plate, cargo: route.cargo, from: route.from, to: route.to,
                        status: route.status, speedKmh: route.speedKmh,
                        routeLengthKm: route.routeLengthKm, orderId: route.orderId, pathKey: route.pathKey,
                    });
                    roadMap.updateTruckPosition(route.lineId, route.coordinates[0], {});
                });
            }
            return;
        }

        setIsLoading(true);
        try {
            const response = sourceRef.current === 'backend'
                ? await fetchRm2GroupRoutes(groupId, request.signal)
                : { routes: FIXTURE_ROUTES.filter((route) => route.groupId === groupId), snapshotVersion: version };
            if (request.signal.aborted) return;
            if (gen !== requestGenerationRef.current) return;

            const accepted = response.routes.map(adaptRenderRoute).filter((r): r is NonNullable<typeof r> => r !== null);

            // 缓存
            if (response.snapshotVersion) {
                groupRoutesCacheRef.current.set(cacheKey(response.snapshotVersion, groupId), response.routes);
            }

            console.info('[RM2 render]', { groupId, receivedRoutes: response.routes.length, acceptedRoutes: accepted.length });
            const roadMap = roadMapRef.current;
            if (!roadMap) return;
            roadMap.clearRoads();
            accepted.forEach((route) => {
                roadMap.addRoadPath(route.lineId, route.coordinates, {
                    plate: route.plate, cargo: route.cargo, from: route.from, to: route.to,
                    status: route.status, speedKmh: route.speedKmh,
                    routeLengthKm: route.routeLengthKm, orderId: route.orderId, pathKey: route.pathKey,
                });
                roadMap.updateTruckPosition(route.lineId, route.coordinates[0], {});
            });
        } catch (error) {
            if ((error as DOMException).name !== 'AbortError') console.warn('RM2 group load failed', { groupId, error });
        } finally {
            if (!request.signal.aborted && gen === requestGenerationRef.current) setIsLoading(false);
        }
    }, [roadMapRef]);

    const refreshRm2 = useCallback(async () => {
        groupRequestRef.current?.abort();
        const request = new AbortController();
        groupRequestRef.current = request;
        const gen = ++requestGenerationRef.current;
        setIsLoading(true);
        try {
            const response = await fetchRm2Groups(request.signal);
            if (request.signal.aborted) return;
            if (gen !== requestGenerationRef.current) return;
            sourceRef.current = 'backend';

            // 版本变化 → 清除旧缓存
            if (response.snapshotVersion !== snapshotVersionRef.current) {
                groupRoutesCacheRef.current.clear();
                snapshotVersionRef.current = response.snapshotVersion;
            }

            // 更新速查表
            const byId = new Map<string, Rm2GroupDTO>();
            response.groups.forEach((g) => byId.set(g.groupId, g));
            groupsByIdRef.current = byId;

            setGroups(response.groups);
            setDiagnostics(response.diagnostics);
            const preferred = response.groups.find((g) => g.groupId === activeGroupIdRef.current) ?? response.groups[0];
            if (preferred) await loadGroup(preferred.groupId);
            else roadMapRef.current?.clearRoads();
        } catch (error) {
            if (request.signal.aborted) return;
            if (gen !== requestGenerationRef.current) return;
            console.warn('RM2 API unavailable; using fixture fallback', error);
            sourceRef.current = 'fixture';
            setGroups(FIXTURE_GROUPS);
            setDiagnostics(FIXTURE_DIAGNOSTICS);
            const preferred = FIXTURE_GROUPS.find((g) => g.groupId === activeGroupIdRef.current) ?? FIXTURE_GROUPS[0];
            if (preferred) await loadGroup(preferred.groupId);
            else roadMapRef.current?.clearRoads();
        } finally {
            if (!request.signal.aborted && gen === requestGenerationRef.current) setIsLoading(false);
        }
    }, [loadGroup, roadMapRef]);

    useEffect(() => {
        if (view !== 'roadMap2' || !sceneReady || !roadMapRef.current) return;
        void refreshRm2();
        if (!import.meta.env.DEV) return;
        const timer = window.setInterval(() => void refreshRm2(), 30_000);
        return () => {
            window.clearInterval(timer);
            groupRequestRef.current?.abort();
            routeRequestRef.current?.abort();
        };
    }, [refreshRm2, roadMapRef, sceneReady, view]);

    return { groups, activeGroupId, isLoading, diagnostics, loadGroup, refreshRm2 };
}
