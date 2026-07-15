import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChainNode } from '../playback/chain';
import { buildPlaybackChain } from '../playback/chain';
import type { RenderRouteDTO, RouteSnapshotChangedMessage } from '../services/renderRouteApi';
import { adaptRenderRoute, fetchRm2Groups } from '../services/renderRouteApi';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import type { ViewMode, LonLat } from '../types';
import type { TruckPositionMessage } from './useDashboardRealtime';
import { useVehicleMotionController } from './useVehicleMotionController';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const CALIBRATION_INTERVAL_MS = 12_000; // 每 12 秒向后端拉一次真实位置修正

type Options = {
    roadMapRef: React.RefObject<RoadMap3D2Handle | null>;
    view: ViewMode;
    sceneReady: boolean;
};

export function useRm2PlaybackController({ roadMapRef, view, sceneReady }: Options) {
    const [status, setStatus] = useState<'idle' | 'playing' | 'paused'>('idle');
    const [currentLabel, setCurrentLabel] = useState('');
    const [currentRoutes, setCurrentRoutes] = useState<RenderRouteDTO[]>([]);

    const chainRef = useRef<ChainNode | null>(null);
    const currentNodeRef = useRef<ChainNode | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const calibrateRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const snapshotVersionRef = useRef('');
    const routesCacheRef = useRef<Map<string, RenderRouteDTO[]>>(new Map());

    // 地图适配器
    const mapAdapter = useRef({
        updateVehicle: (lineId: string, position: LonLat, info: { speedKmh: number | null; status: string }) => {
            roadMapRef.current?.updateTruckPosition(lineId, position, info);
        },
        removeVehicle: (lineId: string) => {
            roadMapRef.current?.removeRoadPath(lineId);
        },
    });

    // 位置查询回调：批量 POST 后端
    const fetchPositions = useCallback(async (lineIds: string[]): Promise<TruckPositionMessage[]> => {
        try {
            const res = await fetch(`${API_BASE}/api/road/vehicles/positions/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lineIds }),
            });
            if (!res.ok) return [];
            const data = await res.json();
            return (data.positions as any[] ?? []).map((p: any) => ({
                type: 'truck_position' as const,
                lineId: p.lineId,
                groupId: '',
                position: p.position,
                speedKmh: p.speedKmh ?? null,
                status: p.status ?? '运输中',
                scope: 'rm2' as const,
                serverTime: data.serverTime,
            }));
        } catch { return []; }
    }, []);

    // 运动控制器：帧循环预测 + 定时修正
    const motion = useVehicleMotionController({
        scope: 'rm2',
        viewActive: view === 'roadMap2' && sceneReady,
        activeGroupId: currentNodeRef.current?.id ?? null,
        snapshotVersion: snapshotVersionRef.current,
        mapAdapter: mapAdapter.current,
        fetchPositions,
    });

    // 渲染路线到地图 + 启动预测
    const renderGroup = useCallback(async (routes: RenderRouteDTO[]) => {
        const map = roadMapRef.current;
        if (!map) return;
        map.clearRoads();
        const accepted = routes.map(adaptRenderRoute).filter((r): r is NonNullable<typeof r> => r !== null);
        accepted.forEach((r) => {
            map.addRoadPath(r.lineId, r.coordinates, {
                plate: r.plate, cargo: r.cargo, from: r.from, to: r.to,
                status: r.status, speedKmh: r.speedKmh,
                routeLengthKm: r.routeLengthKm, orderId: r.orderId, pathKey: r.pathKey,
            });
        });
        // 启动预测引擎
        await motion.loadGroup(routes.map((r) => ({
            lineId: r.lineId,
            groupId: r.groupId,
            coordinates: r.coordinates as LonLat[],
            routeLengthKm: r.routeLengthKm,
            speedKmh: r.speedKmh,
            travelDurationMs: r.travelDurationMs,
            status: r.status,
        })));
    }, [roadMapRef, motion]);

    // 定时修正：每 12s 拉一次后端位置
    const startCalibration = useCallback(() => {
        calibrateRef.current && clearInterval(calibrateRef.current);
        calibrateRef.current = setInterval(async () => {
            const node = currentNodeRef.current;
            if (!node?.routes || node.routes.length === 0) return;
            const positions = await fetchPositions(node.routes.map((r) => r.lineId));
            positions.forEach((p) => {
                motion.handlePositionFrame({
                    type: 'vehicle_positions',
                    scope: 'rm2',
                    serverTime: new Date().toISOString(),
                    positions: [p],
                });
            });
        }, CALIBRATION_INTERVAL_MS);
    }, [fetchPositions, motion]);

    const stopCalibration = useCallback(() => {
        if (calibrateRef.current) { clearInterval(calibrateRef.current); calibrateRef.current = null; }
    }, []);

    const stopTimer = useCallback(() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    }, []);

    // 播放一个节点
    const playNode = useCallback((node: ChainNode) => {
        stopTimer();

        let leaf = node;
        while (leaf.child) leaf = leaf.child;

        const routes = leaf.routes ?? [];
        currentNodeRef.current = leaf;
        setCurrentLabel(leaf.label);
        setCurrentRoutes(routes);
        renderGroup(routes);
        startCalibration();

        const duration = leaf.durationMs ?? 15000;
        timerRef.current = setTimeout(() => {
            const next = leaf.next;
            if (next) playNode(next);
            else stop();
        }, duration);
    }, [renderGroup, startCalibration, stopTimer]);

    // 同步并开始
    const syncAndStart = useCallback(async () => {
        setStatus('playing');
        try {
            const resp = await fetchRm2Groups();
            if (resp.snapshotVersion === snapshotVersionRef.current && chainRef.current) {
                if (currentNodeRef.current) playNode(currentNodeRef.current);
                return;
            }
            snapshotVersionRef.current = resp.snapshotVersion;

            const routeMap = new Map<string, RenderRouteDTO[]>();
            for (const g of resp.groups) {
                try {
                    const rResp = await fetch(`${API_BASE}/api/road/rm2/groups/${encodeURIComponent(g.groupId)}/routes?snapshotVersion=${resp.snapshotVersion}`);
                    if (!rResp.ok) continue;
                    const rData = await rResp.json();
                    if (rData.routes) routeMap.set(g.groupId, rData.routes);
                } catch { /* skip */ }
            }
            routesCacheRef.current = routeMap;
            const chain = buildPlaybackChain(resp.groups, routeMap);
            chainRef.current = chain;
            if (chain?.child) playNode(chain.child);
        } catch (e) {
            console.warn('RM2 playback sync failed', e);
            setStatus('idle');
        }
    }, [playNode]);

    const stop = useCallback(() => {
        stopTimer();
        stopCalibration();
        setStatus('idle');
        setCurrentRoutes([]);
    }, [stopTimer, stopCalibration]);

    // WebSocket 快照更新
    const handleSnapshotChanged = useCallback((msg: RouteSnapshotChangedMessage) => {
        if (msg.scope !== 'rm2' || msg.snapshotVersion === snapshotVersionRef.current) return;
        setTimeout(() => void syncAndStart(), 200);
    }, [syncAndStart]);

    useEffect(() => {
        if (view !== 'roadMap2' || !sceneReady) { stop(); return; }
        syncAndStart();
        return () => { stop(); };
    }, [view, sceneReady]); // eslint-disable-line react-hooks/exhaustive-deps

    return { status, currentLabel, currentRoutes, syncAndStart, stop, handleSnapshotChanged };
}
