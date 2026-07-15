import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChainNode } from '../playback/chain';
import { buildPlaybackChain } from '../playback/chain';
import type { RenderRouteDTO } from '../services/renderRouteApi';
import { adaptRenderRoute, fetchRm2Groups } from '../services/renderRouteApi';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import type { ViewMode, LonLat } from '../types';
import type { TruckPositionMessage } from './useDashboardRealtime';
import { useVehicleMotionController } from './useVehicleMotionController';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const CALIBRATION_INTERVAL_MS = 12_000;

type Options = { roadMapRef: React.RefObject<RoadMap3D2Handle | null>; view: ViewMode; sceneReady: boolean };

export function useRm2PlaybackController({ roadMapRef, view, sceneReady }: Options) {
    const [status, setStatus] = useState<'idle' | 'playing'>('idle');
    const [currentLabel, setCurrentLabel] = useState('');
    const [currentRoutes, setCurrentRoutes] = useState<RenderRouteDTO[]>([]);

    const chainRef = useRef<ChainNode | null>(null);
    const currentNodeRef = useRef<ChainNode | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const calibrateRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const snapshotVersionRef = useRef('');
    const retryRef = useRef(0);

    const mapAdapter = useRef({
        updateVehicle: (lineId: string, pos: LonLat, info: { speedKmh: number | null; status: string }) => {
            roadMapRef.current?.updateTruckPosition(lineId, pos, info);
        },
        removeVehicle: (lineId: string) => { roadMapRef.current?.removeRoadPath(lineId); },
    });

    const fetchPositions = useCallback(async (lineIds: string[]): Promise<TruckPositionMessage[]> => {
        try {
            const res = await fetch(`${API_BASE}/api/road/vehicles/positions/query`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lineIds }),
            });
            if (!res.ok) return [];
            const data = await res.json();
            return (data.positions as any[] ?? []).map((p: any) => ({
                type: 'truck_position' as const, lineId: p.lineId, groupId: '',
                position: p.position, speedKmh: p.speedKmh ?? null,
                status: p.status ?? '运输中', scope: 'rm2' as const, serverTime: data.serverTime,
            }));
        } catch { return []; }
    }, []);

    const motionActive = status === 'playing' && currentRoutes.length > 0;
    const motion = useVehicleMotionController({
        scope: 'rm2', viewActive: view === 'roadMap2' && sceneReady && motionActive,
        activeGroupId: currentNodeRef.current?.id ?? null,
        snapshotVersion: snapshotVersionRef.current,
        mapAdapter: mapAdapter.current, fetchPositions,
    });

    const stopTimer = useCallback(() => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } }, []);
    const stopCalibration = useCallback(() => { if (calibrateRef.current) { clearInterval(calibrateRef.current); calibrateRef.current = null; } }, []);

    const playNode = useCallback(async (node: ChainNode) => {
        stopTimer(); stopCalibration();
        let leaf = node;
        while (leaf.child) leaf = leaf.child;

        const routes = leaf.routes ?? [];
        currentNodeRef.current = leaf;
        setCurrentLabel(leaf.label);
        setCurrentRoutes(routes);

        if (routes.length > 0) {
            const map = roadMapRef.current;
            if (map) {
                map.clearRoads();
                const accepted = routes.map(adaptRenderRoute).filter((r): r is NonNullable<typeof r> => r !== null);
                accepted.forEach((r) => map.addRoadPath(r.lineId, r.coordinates, {
                    plate: r.plate, cargo: r.cargo, from: r.from, to: r.to,
                    status: r.status, speedKmh: r.speedKmh,
                    routeLengthKm: r.routeLengthKm, orderId: r.orderId, pathKey: r.pathKey,
                }));
            }
            await motion.loadGroup(routes.map((r) => ({
                lineId: r.lineId, groupId: r.groupId, coordinates: r.coordinates as LonLat[],
                routeLengthKm: r.routeLengthKm, speedKmh: r.speedKmh,
                travelDurationMs: r.travelDurationMs, status: r.status,
            })));
            calibrateRef.current && clearInterval(calibrateRef.current);
            calibrateRef.current = setInterval(async () => {
                const node = currentNodeRef.current;
                if (!node?.routes || node.routes.length === 0) return;
                const positions = await fetchPositions(node.routes.map((r) => r.lineId));
                positions.forEach((p) => motion.handlePositionFrame({
                    type: 'vehicle_positions', scope: 'rm2', serverTime: new Date().toISOString(), positions: [p],
                }));
            }, CALIBRATION_INTERVAL_MS);
        }

        timerRef.current = setTimeout(() => {
            const next = leaf.next;
            if (next) playNode(next);
            else stop();
        }, leaf.durationMs ?? 15000);
    }, [roadMapRef, motion, fetchPositions, stopTimer, stopCalibration]);

    const stop = useCallback(() => { stopTimer(); stopCalibration(); setStatus('idle'); setCurrentRoutes([]); }, [stopTimer, stopCalibration]);

    const syncAndStart = useCallback(async () => {
        try {
            const resp = await fetchRm2Groups();
            if (resp.groups.length === 0) {
                if (retryRef.current < 10) {
                    retryRef.current++;
                    setCurrentLabel('等待数据...');
                    try { await fetch(`${API_BASE}/api/road/town/provinces/raw`, { method: 'POST' }); } catch { /* */ }
                    setTimeout(() => syncAndStart(), 2000);
                } else { setCurrentLabel('暂无数据'); setStatus('idle'); }
                return;
            }
            retryRef.current = 0;
            if (resp.snapshotVersion === snapshotVersionRef.current && chainRef.current) return;
            snapshotVersionRef.current = resp.snapshotVersion;
            const emptyMap = new Map<string, RenderRouteDTO[]>();
            resp.groups.forEach((g) => emptyMap.set(g.groupId, []));
            chainRef.current = buildPlaybackChain(resp.groups, emptyMap);
            setStatus('playing');
            if (chainRef.current?.child) playNode(chainRef.current.child);
        } catch (e) { console.warn('[RM2 playback]', e); setStatus('idle'); }
    }, [playNode]);

    useEffect(() => {
        if (view !== 'roadMap2' || !sceneReady) { stop(); return; }
        syncAndStart();
        return () => { stop(); };
    }, [view, sceneReady]); // eslint-disable-line react-hooks/exhaustive-deps

    return { status, currentLabel, currentRoutes };
}
