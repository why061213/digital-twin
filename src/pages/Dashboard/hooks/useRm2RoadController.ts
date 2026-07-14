import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import {
    adaptRenderRoute,
    fetchRm2GroupRoutes,
    fetchRm2Groups,
    type RenderRouteDTO,
    type Rm2GroupDTO,
} from '../services/renderRouteApi';
import type { ViewMode } from '../types';

const FIXTURE_GROUPS: Rm2GroupDTO[] = [
    { groupId: 'rm2-fixture-fs-gz', groupName: '佛山 - 广州', index: 0, count: 2, lineIds: ['rm2-fs-gz-01', 'rm2-fs-gz-02'], mapKey: '440000' },
    { groupId: 'rm2-fixture-dg-sz', groupName: '东莞 - 深圳', index: 1, count: 2, lineIds: ['rm2-dg-sz-01', 'rm2-dg-sz-02'], mapKey: '440000' },
    { groupId: 'rm2-fixture-zs-zh', groupName: '中山 - 珠海', index: 2, count: 1, lineIds: ['rm2-zs-zh-01'], mapKey: '440000' },
];

function fixtureRoute(
    lineId: string, orderId: string, plate: string, cargo: string, from: string, to: string,
    groupId: string, pathKey: string, coordinates: [number, number][],
): RenderRouteDTO {
    return {
    lineId, orderId, plate, cargo, from, to, groupId, pathKey, coordinates,
    fromCoords: coordinates[0], toCoords: coordinates[coordinates.length - 1],
    routeLengthKm: 36, speedKmh: 42, status: '运输中', travelDurationMs: 2_712_000,
    scope: 'rm2' as const, role: 'primary' as const, coordinateSystem: 'GCJ02', routeSignature: `${lineId}-fixture`,
    };
}

const FIXTURE_ROUTES: RenderRouteDTO[] = [
    fixtureRoute('rm2-fs-gz-01', 'RM2-FS-GZ', '粤E63962', '18吨', '佛山南海', '广州白云', 'rm2-fixture-fs-gz', 'rm2-foshan-guangzhou', [[113.145, 23.045], [113.225, 23.095], [113.315, 23.155], [113.365, 23.245]]),
    fixtureRoute('rm2-fs-gz-02', 'RM2-FS-GZ', '粤E05619D', '15吨', '佛山南海', '广州白云', 'rm2-fixture-fs-gz', 'rm2-foshan-guangzhou', [[113.145, 23.045], [113.225, 23.095], [113.315, 23.155], [113.365, 23.245]]),
    fixtureRoute('rm2-dg-sz-01', 'RM2-DG-SZ', '粤S88520', '12吨', '东莞松山湖', '深圳龙华', 'rm2-fixture-dg-sz', 'rm2-dongguan-shenzhen', [[113.92, 22.91], [113.98, 22.84], [114.055, 22.77], [114.10, 22.71]]),
    fixtureRoute('rm2-dg-sz-02', 'RM2-DG-SZ', '粤B71208', '10吨', '东莞松山湖', '深圳龙华', 'rm2-fixture-dg-sz', 'rm2-dongguan-shenzhen', [[113.92, 22.91], [113.98, 22.84], [114.055, 22.77], [114.10, 22.71]]),
    fixtureRoute('rm2-zs-zh-01', 'RM2-ZS-ZH', '粤T52601', '9吨', '中山坦洲', '珠海香洲', 'rm2-fixture-zs-zh', 'rm2-zhongshan-zhuhai', [[113.49, 22.47], [113.535, 22.42], [113.575, 22.36]]),
];

type Options = { roadMapRef: RefObject<RoadMap3D2Handle | null>; view: ViewMode; sceneReady: boolean };

export function useRm2RoadController({ roadMapRef, view, sceneReady }: Options) {
    const [groups, setGroups] = useState<Rm2GroupDTO[]>([]);
    const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const sourceRef = useRef<'backend' | 'fixture'>('backend');
    const requestRef = useRef<AbortController | null>(null);

    const loadGroup = useCallback(async (groupId: string) => {
        requestRef.current?.abort();
        const request = new AbortController();
        requestRef.current = request;
        setActiveGroupId(groupId);
        setIsLoading(true);
        try {
            const routes = sourceRef.current === 'backend'
                ? (await fetchRm2GroupRoutes(groupId, request.signal)).routes
                : FIXTURE_ROUTES.filter((route) => route.groupId === groupId);
            if (request.signal.aborted) return;

            const roadMap = roadMapRef.current;
            if (!roadMap) return;
            roadMap.clearRoads();
            routes.map(adaptRenderRoute).filter((route): route is NonNullable<typeof route> => route !== null).forEach((route) => {
                const info = { plate: route.plate, cargo: route.cargo, from: route.from, to: route.to, status: route.status, speedKmh: route.speedKmh, routeLengthKm: route.routeLengthKm, orderId: route.orderId, pathKey: route.pathKey };
                roadMap.addRoadPath(route.lineId, route.coordinates, info);
                roadMap.updateTruckPosition(route.lineId, route.coordinates[0], info);
            });
        } catch (error) {
            if ((error as DOMException).name !== 'AbortError') console.warn('RM2 group load failed', error);
        } finally {
            if (!request.signal.aborted) setIsLoading(false);
        }
    }, [roadMapRef]);

    useEffect(() => {
        if (view !== 'roadMap2' || !sceneReady || !roadMapRef.current) return;
        const request = new AbortController();
        requestRef.current?.abort();
        requestRef.current = request;
        setIsLoading(true);
        void (async () => {
            try {
                const response = await fetchRm2Groups(request.signal);
                if (request.signal.aborted) return;
                sourceRef.current = 'backend';
                setGroups(response.groups);
                if (response.groups[0]) await loadGroup(response.groups[0].groupId);
            } catch (error) {
                if (request.signal.aborted) return;
                console.warn('RM2 API unavailable; using fixture fallback', error);
                sourceRef.current = 'fixture';
                setGroups(FIXTURE_GROUPS);
                await loadGroup(FIXTURE_GROUPS[0].groupId);
            } finally {
                if (!request.signal.aborted) setIsLoading(false);
            }
        })();
        return () => {
            request.abort();
            requestRef.current?.abort();
        };
    }, [loadGroup, roadMapRef, sceneReady, view]);

    return { groups, activeGroupId, isLoading, loadGroup };
}
