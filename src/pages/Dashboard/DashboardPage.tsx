import { useCallback, useEffect, useRef, useState } from 'react';
import MainLayout from '@/components/Layout/MainLayout';
import Header from '@/components/Layout/Header';
import Warehouse3D from './modules/Warehouse3D';
import ChinaMap3D from './modules/ChinaMap3D/index';
import type { ChinaMap3DHandle } from './modules/ChinaMap3D';
import RoadMap3D from './modules/RoadMap3D';
import type { RoadMap3DHandle } from './modules/RoadMap3D';
import { useDashboardRealtime } from './hooks/useDashboardRealtime';
import type { RoadPathMessage, RouteOrder, TruckPositionMessage, WarehouseFocusPanel, WarehouseFocusStyle } from './hooks/useDashboardRealtime';

type ViewMode = 'warehouse' | 'chinaMap' | 'roadMap';
type LonLat = [number, number];

type ActiveRoute = RouteOrder & {
    startedAt: number;
    fallbackDuration: number;
    coordinates: LonLat[];
    calibratedAt: number;
    calibratedDistance: number;
    pathSpeed: number;
    pathLength: number;
    routeLengthKm: number;
    speedKmh: number | null;
    nextCalibrationAt: number;
};

type RoadGroupSummary = {
    groupId: string;
    index: number;
    count: number;
};

type RoadGroupsResponse = {
    groupSize: number;
    totalRoutes: number;
    groups: RoadGroupSummary[];
};

type RoadGroupRoutesResponse = {
    groupId: string;
    routes: RoadPathMessage[];
};

const DEFAULT_POSITION_QUERY_INTERVAL_MS = 60_000;
const DEFAULT_REAL_POSITION_QUERY_INTERVAL_MS = 1_800_000;
const DEFAULT_SLOW_POSITION_QUERY_INTERVAL_MS = 15_000;
const DEFAULT_REAL_SLOW_POSITION_QUERY_INTERVAL_MS = 300_000;
const DEFAULT_POSITION_RENDER_TICK_MS = 500;
const DEFAULT_LOW_SPEED_THRESHOLD_KMH = 50;
const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api').replace(/\/$/, '');

function readPositiveEnv(key: string, fallback: number) {
    const raw = import.meta.env[key];
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SIMULATION_PROFILE = String(import.meta.env.VITE_TRUCK_SIMULATION_PROFILE || 'test').toLowerCase();
const POSITION_QUERY_INTERVAL_MS = SIMULATION_PROFILE === 'real'
    ? readPositiveEnv('VITE_TRUCK_POSITION_QUERY_INTERVAL_REAL_MS', DEFAULT_REAL_POSITION_QUERY_INTERVAL_MS)
    : readPositiveEnv('VITE_TRUCK_POSITION_QUERY_INTERVAL_TEST_MS', DEFAULT_POSITION_QUERY_INTERVAL_MS);
const SLOW_POSITION_QUERY_INTERVAL_MS = SIMULATION_PROFILE === 'real'
    ? readPositiveEnv('VITE_TRUCK_SLOW_POSITION_QUERY_INTERVAL_REAL_MS', DEFAULT_REAL_SLOW_POSITION_QUERY_INTERVAL_MS)
    : readPositiveEnv('VITE_TRUCK_SLOW_POSITION_QUERY_INTERVAL_TEST_MS', DEFAULT_SLOW_POSITION_QUERY_INTERVAL_MS);
const LOW_SPEED_THRESHOLD_KMH = readPositiveEnv('VITE_TRUCK_LOW_SPEED_THRESHOLD_KMH', DEFAULT_LOW_SPEED_THRESHOLD_KMH);
const POSITION_RENDER_TICK_MS = readPositiveEnv('VITE_TRUCK_POSITION_RENDER_TICK_MS', DEFAULT_POSITION_RENDER_TICK_MS);

function hashText(text: string) {
    return Array.from(text).reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function lerp(start: number, end: number, progress: number) {
    return start + (end - start) * progress;
}

function clamp01(value: number) {
    return Math.min(Math.max(value, 0), 1);
}

function distance(a: LonLat, b: LonLat) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    return Math.sqrt(dx * dx + dy * dy);
}

function buildPlate(lineId: string) {
    const prefixes = ['粤A', '粤B', '湘E', '赣C', '苏E', '浙A'];
    const hash = hashText(lineId);
    return `${prefixes[hash % prefixes.length]}·${lineId.slice(0, 6).toUpperCase()}`;
}

function buildCargo(lineId: string) {
    const cargos = ['铝锭', '铜材', '钢材', '化工原料', '其他'];
    return cargos[hashText(lineId) % cargos.length];
}

function pathLength(coordinates: LonLat[]) {
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
        total += distance(coordinates[i - 1], coordinates[i]);
    }
    return total;
}

function distanceKm(a: LonLat, b: LonLat) {
    const earthRadiusKm = 6371;
    const lat1 = a[1] * Math.PI / 180;
    const lat2 = b[1] * Math.PI / 180;
    const deltaLat = (b[1] - a[1]) * Math.PI / 180;
    const deltaLng = (b[0] - a[0]) * Math.PI / 180;
    const h =
        Math.sin(deltaLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function pathLengthKm(coordinates: LonLat[]) {
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
        total += distanceKm(coordinates[i - 1], coordinates[i]);
    }
    return total;
}

function positionAtDistance(coordinates: LonLat[], targetDistance: number): LonLat {
    if (coordinates.length === 0) return [0, 0];
    if (coordinates.length === 1 || targetDistance <= 0) return coordinates[0];

    let walked = 0;
    for (let i = 1; i < coordinates.length; i++) {
        const start = coordinates[i - 1];
        const end = coordinates[i];
        const segmentLength = distance(start, end);
        if (segmentLength <= 0) continue;

        if (walked + segmentLength >= targetDistance) {
            const progress = clamp01((targetDistance - walked) / segmentLength);
            return [lerp(start[0], end[0], progress), lerp(start[1], end[1], progress)];
        }
        walked += segmentLength;
    }

    return coordinates[coordinates.length - 1];
}

function projectDistanceOnPath(coordinates: LonLat[], point: LonLat) {
    if (coordinates.length < 2) return 0;

    let walked = 0;
    let nearestDistance = 0;
    let nearestDistanceSq = Number.POSITIVE_INFINITY;

    for (let i = 1; i < coordinates.length; i++) {
        const start = coordinates[i - 1];
        const end = coordinates[i];
        const abX = end[0] - start[0];
        const abY = end[1] - start[1];
        const segmentLengthSq = abX * abX + abY * abY;
        if (segmentLengthSq <= 0) continue;

        const apX = point[0] - start[0];
        const apY = point[1] - start[1];
        const segmentProgress = clamp01((apX * abX + apY * abY) / segmentLengthSq);
        const projectedX = start[0] + abX * segmentProgress;
        const projectedY = start[1] + abY * segmentProgress;
        const dx = point[0] - projectedX;
        const dy = point[1] - projectedY;
        const currentDistanceSq = dx * dx + dy * dy;

        if (currentDistanceSq < nearestDistanceSq) {
            nearestDistanceSq = currentDistanceSq;
            nearestDistance = walked + Math.sqrt(segmentLengthSq) * segmentProgress;
        }

        walked += Math.sqrt(segmentLengthSq);
    }

    return nearestDistance;
}

function predictedPosition(route: ActiveRoute, now: number): LonLat {
    if (route.pathLength <= 0) return route.toCoords;
    const elapsed = Math.max(0, now - route.calibratedAt);
    const nextDistance = Math.min(route.pathLength, route.calibratedDistance + route.pathSpeed * elapsed);
    return positionAtDistance(route.coordinates, nextDistance);
}

function nextQueryInterval(speedKmh: number | null) {
    if (speedKmh !== null && speedKmh < LOW_SPEED_THRESHOLD_KMH) {
        return SLOW_POSITION_QUERY_INTERVAL_MS;
    }
    return POSITION_QUERY_INTERVAL_MS;
}

function DashboardPage() {
    const [view, setView] = useState<ViewMode>('warehouse');
    const [, setRouteOrders] = useState<RouteOrder[]>([]);
    const [roadGroups, setRoadGroups] = useState<RoadGroupSummary[]>([]);
    const [activeRoadGroupId, setActiveRoadGroupId] = useState<string | null>(null);
    const [isDispatching, setIsDispatching] = useState(false);
    const [isLoadingRoadGroup, setIsLoadingRoadGroup] = useState(false);
    const [chinaMapSession, setChinaMapSession] = useState(0);
    const previousViewRef = useRef<ViewMode>('warehouse');
    const mapRef = useRef<ChinaMap3DHandle>(null);
    const roadMapRef = useRef<RoadMap3DHandle>(null);
    const activeRoutesRef = useRef<Map<string, ActiveRoute>>(new Map());
    const positionRequestsRef = useRef<Set<string>>(new Set());

    const handleCityRaise = useCallback((cityName: string) => {
        mapRef.current?.riseCity(cityName);
    }, []);

    const handleCityFall = useCallback((cityName: string) => {
        mapRef.current?.fallCity(cityName);
    }, []);

    const syncRoadRoute = useCallback((route: ActiveRoute) => {
        roadMapRef.current?.addRoadPath(route.lineId, route.coordinates, {
            plate: route.plate,
            cargo: route.cargo,
            from: route.from,
            to: route.to,
            status: route.status,
            speedKmh: route.speedKmh,
            routeLengthKm: route.routeLengthKm,
        });
    }, []);

    const renderTruckPosition = useCallback((route: ActiveRoute, now: number) => {
        roadMapRef.current?.updateTruckPosition(route.lineId, predictedPosition(route, now), {
            plate: route.plate,
            cargo: route.cargo,
            from: route.from,
            to: route.to,
            status: route.status,
            speedKmh: route.speedKmh,
            routeLengthKm: route.routeLengthKm,
        });
    }, []);

    const createActiveRoute = useCallback(
        (message: RoadPathMessage): ActiveRoute | null => {
            if (!message.coordinates || message.coordinates.length < 2) return null;

            const now = performance.now();
            const existing = activeRoutesRef.current.get(message.lineId);
            const fallbackDuration = Math.max(
                POSITION_QUERY_INTERVAL_MS * 2,
                message.travelDurationMs ?? 14_000 + (hashText(message.lineId) % 9_000)
            );
            const totalPathLength = pathLength(message.coordinates);
            const routeLengthKm = message.routeLengthKm ?? pathLengthKm(message.coordinates);
            const speedKmh = message.speedKmh ?? existing?.speedKmh ?? null;

            if (existing) {
                const currentPosition = predictedPosition(existing, now);
                const updated: ActiveRoute = {
                    ...existing,
                    from: message.from ?? existing.from,
                    to: message.to ?? existing.to,
                    fromCoords: message.coordinates[0],
                    toCoords: message.coordinates[message.coordinates.length - 1],
                    routeLengthKm,
                    fallbackDuration,
                    coordinates: message.coordinates,
                    calibratedAt: now,
                    calibratedDistance: projectDistanceOnPath(message.coordinates, currentPosition),
                    pathLength: totalPathLength,
                    speedKmh,
                };
                activeRoutesRef.current.set(updated.lineId, updated);
                return updated;
            }

            const route: ActiveRoute = {
                lineId: message.lineId,
                from: message.from ?? '起点',
                to: message.to ?? '目的地',
                fromCoords: message.coordinates[0],
                toCoords: message.coordinates[message.coordinates.length - 1],
                routeLengthKm,
                plate: buildPlate(message.lineId),
                cargo: buildCargo(message.lineId),
                status: '运输中',
                startedAt: now,
                fallbackDuration,
                coordinates: message.coordinates,
                calibratedAt: now,
                calibratedDistance: 0,
                pathSpeed: totalPathLength / fallbackDuration,
                pathLength: totalPathLength,
                speedKmh,
                nextCalibrationAt: now + nextQueryInterval(speedKmh),
            };

            activeRoutesRef.current.set(route.lineId, route);
            return route;
        },
        []
    );

    const showRoutes = useCallback(
        (routes: ActiveRoute[]) => {
            const now = performance.now();
            setRouteOrders(routes);
            routes.forEach((route) => {
                syncRoadRoute(route);
                renderTruckPosition(route, now);
            });
        },
        [renderTruckPosition, syncRoadRoute]
    );

    const fetchRoadGroups = useCallback(async () => {
        const response = await fetch(`${API_BASE_URL}/road/groups`);
        if (!response.ok) throw new Error(`Groups request failed: ${response.status}`);
        const data = await response.json() as RoadGroupsResponse;
        setRoadGroups(data.groups ?? []);
        return data.groups ?? [];
    }, []);

    const loadRoadGroup = useCallback(
        async (groupId: string) => {
            setIsLoadingRoadGroup(true);
            try {
                const response = await fetch(`${API_BASE_URL}/road/groups/${encodeURIComponent(groupId)}/routes`);
                if (!response.ok) throw new Error(`Group routes request failed: ${response.status}`);
                const data = await response.json() as RoadGroupRoutesResponse;
                const loadedGroupId = data.groupId || groupId;
                const isSameGroup = activeRoadGroupId === loadedGroupId;
                const previousIds = new Set(activeRoutesRef.current.keys());
                const routes = (data.routes ?? [])
                    .map(createActiveRoute)
                    .filter((route): route is ActiveRoute => Boolean(route));

                activeRoutesRef.current = new Map(routes.map((route) => [route.lineId, route]));
                setActiveRoadGroupId(loadedGroupId);
                setRouteOrders(routes);

                const nextIds = new Set(routes.map((route) => route.lineId));
                if (!isSameGroup) {
                    roadMapRef.current?.clearRoads();
                    showRoutes(routes);
                    return;
                }

                previousIds.forEach((lineId) => {
                    if (!nextIds.has(lineId)) {
                        roadMapRef.current?.removeRoadPath(lineId);
                    }
                });

                const now = performance.now();
                routes.forEach((route) => {
                    if (!previousIds.has(route.lineId)) {
                        syncRoadRoute(route);
                    }
                    renderTruckPosition(route, now);
                });
            } catch (error) {
                console.warn('Road group load failed', error);
            } finally {
                setIsLoadingRoadGroup(false);
            }
        },
        [activeRoadGroupId, createActiveRoute, renderTruckPosition, showRoutes, syncRoadRoute]
    );

    const refreshRoadGroups = useCallback(
        async (preferredGroupId?: string) => {
            try {
                const groups = await fetchRoadGroups();
                const nextGroupId = preferredGroupId
                    ?? (activeRoadGroupId && groups.some((group) => group.groupId === activeRoadGroupId) ? activeRoadGroupId : groups[0]?.groupId);

                if (nextGroupId) {
                    await loadRoadGroup(nextGroupId);
                } else {
                    activeRoutesRef.current.clear();
                    roadMapRef.current?.clearRoads();
                    setRouteOrders([]);
                    setActiveRoadGroupId(null);
                }
            } catch (error) {
                console.warn('Road groups refresh failed', error);
            }
        },
        [activeRoadGroupId, fetchRoadGroups, loadRoadGroup]
    );

    const handleRoadPath = useCallback(
        (message: RoadPathMessage) => {
            void refreshRoadGroups(message.groupId);
        },
        [refreshRoadGroups]
    );

    const finishRoute = useCallback((lineId: string) => {
        activeRoutesRef.current.delete(lineId);
        roadMapRef.current?.removeRoadPath(lineId);
        setRouteOrders((prev) =>
            prev.map((item) => (item.lineId === lineId ? { ...item, status: '已完成' } : item))
        );
    }, []);

    const handleRouteRaise = useCallback((_order: RouteOrder) => {
        // 城市飞线事件由 ChinaMap3D 处理；道路级地图只加载后端分组后的路线。
    }, []);

    const handleTruckPosition = useCallback(
        (message: TruckPositionMessage, forceCalibration = false) => {
            const route = activeRoutesRef.current.get(message.lineId);
            if (!route) return;

            if (message.status === 'finished') {
                finishRoute(message.lineId);
                return;
            }

            const now = performance.now();
            if (!forceCalibration && now < route.nextCalibrationAt) return;

            const pushedVelocity = message.velocity ?? message.speed;
            const elapsedSinceLastCalibration = now - route.calibratedAt;
            const nextDistance = projectDistanceOnPath(route.coordinates, message.position);
            const measuredPathSpeed = elapsedSinceLastCalibration > 0
                ? Math.max(0, (nextDistance - route.calibratedDistance) / elapsedSinceLastCalibration)
                : route.pathSpeed;
            const measuredSpeedKmh = elapsedSinceLastCalibration > 0 && route.pathLength > 0
                ? measuredPathSpeed / route.pathLength * route.routeLengthKm * 3_600_000
                : null;
            const pushedPathSpeed = pushedVelocity
                ? Math.sqrt(pushedVelocity[0] * pushedVelocity[0] + pushedVelocity[1] * pushedVelocity[1])
                : null;

            route.pathSpeed = pushedPathSpeed ?? measuredPathSpeed ?? route.pathSpeed;
            route.speedKmh = message.speedKmh ?? measuredSpeedKmh ?? route.speedKmh;
            route.calibratedAt = now;
            route.calibratedDistance = nextDistance;
            route.nextCalibrationAt = now + nextQueryInterval(route.speedKmh);
            renderTruckPosition(route, now);
            setRouteOrders((prev) => prev.map((item) => (item.lineId === route.lineId ? { ...item, speedKmh: route.speedKmh } : item)));
        },
        [finishRoute, renderTruckPosition]
    );

    const requestTruckPosition = useCallback(
        async (lineId: string) => {
            if (positionRequestsRef.current.has(lineId)) return;
            positionRequestsRef.current.add(lineId);
            try {
                const response = await fetch(`${API_BASE_URL}/road/routes/${encodeURIComponent(lineId)}/position`);
                if (!response.ok) throw new Error(`Position request failed: ${response.status}`);
                handleTruckPosition(await response.json(), true);
            } catch (error) {
                console.warn('Truck position request failed', error);
                const route = activeRoutesRef.current.get(lineId);
                if (route) route.nextCalibrationAt = performance.now() + POSITION_QUERY_INTERVAL_MS;
            } finally {
                positionRequestsRef.current.delete(lineId);
            }
        },
        [handleTruckPosition]
    );

    const requestDispatch = useCallback(async () => {
        if (isDispatching) return;
        setIsDispatching(true);
        setView('roadMap');
        try {
            const response = await fetch(`${API_BASE_URL}/road/dispatch`, { method: 'POST' });
            if (!response.ok) throw new Error(`Dispatch failed: ${response.status}`);
            const route = await response.json() as RoadPathMessage;
            await refreshRoadGroups(route.groupId);
        } catch (error) {
            console.warn('Route dispatch failed', error);
        } finally {
            setIsDispatching(false);
        }
    }, [isDispatching, refreshRoadGroups]);


    const handleWarehouseUpdate = useCallback((cityName: string, action: string, displayData: Record<string, any>) => {
        console.log('🏗️ 处理仓库更新:', cityName, action, displayData);
        const hasDisplayData = Boolean(displayData && Object.keys(displayData).length > 0);
        if (action !== 'fall' || hasDisplayData) {
            mapRef.current?.riseCity(cityName);
            mapRef.current?.updateCityData(cityName, displayData);
        } else if (action === 'fall') {
            mapRef.current?.fallCity(cityName);
            mapRef.current?.updateCityData(cityName, null);
        }
    }, []);

    const handleCameraControl = useCallback((cityNames: string[], mode: string) => {
        // 仓库地图进入时使用前端本地巡航流程；后端 camera_control 先保留接入点，避免打断巡航。
        void cityNames;
        void mode;
    }, []);
    const handleWarehouseFocus = useCallback((cityName: string, panels: WarehouseFocusPanel[], style?: WarehouseFocusStyle) => {
        mapRef.current?.showCityPanels(cityName, panels, style);
    }, []);

    const requestWarehouseSnapshot = useCallback(async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/warehouse/snapshot/push`, { method: 'POST' });
            if (!response.ok) throw new Error(`Warehouse snapshot request failed: ${response.status}`);
            const messages = await response.json() as Array<{
                cityName: string;
                action: string;
                displayData: Record<string, any>;
            }>;
            messages.forEach((message) => {
                handleWarehouseUpdate(message.cityName, message.action, message.displayData);
            });
            await Promise.all(messages.map(async (message) => {
                try {
                    const focusResponse = await fetch(`${API_BASE_URL}/warehouse/focus/${encodeURIComponent(message.cityName)}`);
                    if (!focusResponse.ok) return;
                    const focusMessage = await focusResponse.json() as { cityName: string; panels: WarehouseFocusPanel[]; style?: WarehouseFocusStyle };
                    handleWarehouseFocus(focusMessage.cityName, focusMessage.panels ?? [], focusMessage.style);
                } catch (error) {
                    console.warn('Warehouse focus request failed', error);
                }
            }));
            window.setTimeout(() => {
                mapRef.current?.startWarehouseTour();
            }, 180);
        } catch (error) {
            console.warn('Warehouse snapshot request failed', error);
        }
    }, [handleWarehouseFocus, handleWarehouseUpdate]);

    useDashboardRealtime({
        onCityRaise: handleCityRaise,
        onCityFall: handleCityFall,
        onRouteRaise: handleRouteRaise,
        onRouteFall: finishRoute,
        onRoadPath: handleRoadPath,
        onTruckPosition: handleTruckPosition,
        onWarehouseUpdate: handleWarehouseUpdate,
        onWarehouseFocus: handleWarehouseFocus,
        onCameraControl: handleCameraControl,
    });

    useEffect(() => {
        if (previousViewRef.current !== 'chinaMap' && view === 'chinaMap') {
            setChinaMapSession((session) => session + 1);
        }
        previousViewRef.current = view;
    }, [view]);

    useEffect(() => {
        if (view !== 'roadMap') return;
        void refreshRoadGroups(activeRoadGroupId ?? undefined);
    }, [activeRoadGroupId, refreshRoadGroups, view]);

    useEffect(() => {
        if (view !== 'chinaMap') return;
        if (chinaMapSession <= 0) return;
        void requestWarehouseSnapshot();
    }, [chinaMapSession, requestWarehouseSnapshot, view]);

    useEffect(() => {
        if (view !== 'roadMap') return;
        const replayTimer = window.setTimeout(() => {
            const now = performance.now();
            roadMapRef.current?.clearRoads();
            activeRoutesRef.current.forEach((route) => {
                syncRoadRoute(route);
                renderTruckPosition(route, now);
            });
        }, 0);

        return () => window.clearTimeout(replayTimer);
    }, [renderTruckPosition, syncRoadRoute, view]);

    useEffect(() => {
        const timer = window.setInterval(() => {
            const now = performance.now();
            activeRoutesRef.current.forEach((route) => {
                renderTruckPosition(route, now);
                if (now >= route.nextCalibrationAt) {
                    void requestTruckPosition(route.lineId);
                }
            });
        }, POSITION_RENDER_TICK_MS);

        return () => window.clearInterval(timer);
    }, [renderTruckPosition, requestTruckPosition]);

    const renderCenterPanel = () => {
        switch (view) {
            case 'warehouse':
                return <Warehouse3D key="warehouse" />;
            case 'chinaMap':
                return <ChinaMap3D key={`chinaMap-${chinaMapSession}`} ref={mapRef} />;
            case 'roadMap':
                return <RoadMap3D key="roadMap" ref={roadMapRef} />;
            default:
                return null;
        }
    };

    const viewButtons = (
        <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 gap-2">
            {[
                ['warehouse', '仓库视图'],
                ['chinaMap', '数字孪生地图'],
                ['roadMap', '道路级地图'],
            ].map(([mode, label]) => (
                <button
                    key={mode}
                    onClick={() => setView(mode as ViewMode)}
                    className={`rounded-full border px-4 py-2 text-xs shadow-lg backdrop-blur-md transition-all pointer-events-auto ${
                        view === mode
                            ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-300'
                            : 'border-white/10 bg-white/10 text-gray-400 hover:bg-white/20'
                    }`}
                >
                    {label}
                </button>
            ))}
        </div>
    );

    const roadGroupQueue = view === 'roadMap' && roadGroups.length > 0 && (
        <div className="absolute left-4 top-4 z-40 flex max-w-[calc(100%-2rem)] gap-2 overflow-x-auto rounded-md border border-white/10 bg-slate-950/65 p-2 text-xs text-slate-300 shadow-xl backdrop-blur-md pointer-events-auto">
            {roadGroups.map((group) => (
                <button
                    key={group.groupId}
                    onClick={() => void loadRoadGroup(group.groupId)}
                    disabled={isLoadingRoadGroup && activeRoadGroupId === group.groupId}
                    className={`shrink-0 rounded border px-3 py-1.5 transition-all ${
                        activeRoadGroupId === group.groupId
                            ? 'border-cyan-300/50 bg-cyan-400/15 text-cyan-100'
                            : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                    }`}
                >
                    第 {group.index + 1} 组 · {group.count} 条
                </button>
            ))}
        </div>
    );

    const dispatchButton = view === 'roadMap' && (
        <button
            onClick={requestDispatch}
            disabled={isDispatching}
            className="absolute bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-200 shadow-lg backdrop-blur-md transition-all pointer-events-auto hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
            {isDispatching ? '调度中...' : '发起车辆调度'}
        </button>
    );

    return (
        <MainLayout
            header={<Header />}
            // leftPanel={<InventoryStats />}
            leftPanel={null}
            centerPanel={
                <div className="relative h-full w-full">
                    {renderCenterPanel()}
                    {roadGroupQueue}
                    {viewButtons}
                    {dispatchButton}
                </div>
            }
            rightPanel={null}
            // rightPanel={
            //     <>
            //         <VehicleSchedule routeOrders={routeOrders} />
            //         <TrafficMonitor />
            //     </>
            // }
        />
    );
}

export default DashboardPage;
