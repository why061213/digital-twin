import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChainNode } from '../playback/chain';
import { buildPlaybackChain } from '../playback/chain';
import type { RenderRouteDTO, Rm2GroupDTO } from '../services/renderRouteApi';
import { adaptRenderRoute, fetchRm2Groups } from '../services/renderRouteApi';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import type { ViewMode } from '../types';

const POSITION_POLL_MS = 2000;
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

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
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const snapshotVersionRef = useRef('');
    const routesCacheRef = useRef<Map<string, RenderRouteDTO[]>>(new Map());

    // 渲染路线到地图
    const renderRoutes = useCallback((routes: RenderRouteDTO[]) => {
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
            map.updateTruckPosition(r.lineId, r.coordinates[0], {});
        });
    }, [roadMapRef]);

    // 位置轮询
    const startPolling = useCallback((lineIds: string[]) => {
        pollRef.current && clearInterval(pollRef.current);
        if (lineIds.length === 0) return;
        pollRef.current = setInterval(async () => {
            try {
                const res = await fetch(`${API_BASE}/api/road/vehicles/positions/query`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lineIds }),
                });
                if (!res.ok) return;
                const data = await res.json();
                const positions = data.positions as Array<{ lineId: string; position: [number, number] }> | undefined;
                const map = roadMapRef.current;
                if (!map || !positions) return;
                for (const p of positions) {
                    map.updateTruckPosition(p.lineId, p.position, {});
                }
            } catch { /* ignore poll errors */ }
        }, POSITION_POLL_MS);
    }, [roadMapRef]);

    const stopTimer = useCallback(() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    }, []);

    const stopPolling = useCallback(() => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }, []);

    // 播放一个 node：渲染 → 位置轮询 → 计时 → 切换到 next
    const playNode = useCallback((node: ChainNode) => {
        stopTimer();
        stopPolling();

        // 深入 child 直到叶子层
        let leaf = node;
        while (leaf.child) leaf = leaf.child;

        const routes = leaf.routes ?? [];
        currentNodeRef.current = leaf;
        setCurrentLabel(leaf.label);
        setCurrentRoutes(routes);
        renderRoutes(routes);

        const lineIds = routes.map((r) => r.lineId);
        startPolling(lineIds);

        const duration = leaf.durationMs ?? 15000;
        timerRef.current = setTimeout(() => {
            const next = leaf.next;
            if (next) playNode(next);
            else stop();
        }, duration);
    }, [renderRoutes, startPolling, stopTimer, stopPolling]);

    // 同步 groups 并重建链表
    const syncAndStart = useCallback(async () => {
        setStatus('playing');
        try {
            const resp = await fetchRm2Groups();
            if (resp.snapshotVersion === snapshotVersionRef.current && chainRef.current) {
                // 版本未变，继续当前播放
                if (currentNodeRef.current) playNode(currentNodeRef.current);
                return;
            }
            snapshotVersionRef.current = resp.snapshotVersion;

            // 预加载所有 routes
            const routeMap = new Map<string, RenderRouteDTO[]>();
            for (const g of resp.groups) {
                try {
                    const rResp = await fetch(`${API_BASE}/api/road/rm2/groups/${encodeURIComponent(g.groupId)}/routes?snapshotVersion=${resp.snapshotVersion}`);
                    if (!rResp.ok) continue;
                    const rData = await rResp.json();
                    if (rData.routes) routeMap.set(g.groupId, rData.routes);
                } catch { /* skip failed group */ }
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
        stopPolling();
        setStatus('idle');
        setCurrentRoutes([]);
    }, [stopTimer, stopPolling]);

    // 生命周期
    useEffect(() => {
        if (view !== 'roadMap2' || !sceneReady) { stop(); return; }
        syncAndStart();
        return () => { stop(); };
    }, [view, sceneReady]); // eslint-disable-line react-hooks/exhaustive-deps

    return { status, currentLabel, currentRoutes, chainRef, syncAndStart, stop };
}
