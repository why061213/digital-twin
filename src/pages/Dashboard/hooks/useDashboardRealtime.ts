import { useEffect, useRef } from 'react';
import type { RouteSnapshotChangedMessage } from '../services/renderRouteApi';
import { DAILY_KPI_EVENT, isDailyOrderStatistics } from '../services/dashboardKpi';
import { getDashboardAccessToken } from '../services/dashboardAuth';
import type { ViewMode } from '../types';

type CityRaiseMessage = {
    type: 'city_raise';
    from: string;
    to: string;
    fromCoords: [number, number];
    toCoords: [number, number];
    lineId: string;
};

type CityFallMessage = {
    type: 'city_fall';
    from: string;
    to: string;
    lineId: string;
};

export type RoadPathMessage = {
    type: 'road_path';
    lineId: string;
    groupId?: string;
    orderId?: string;
    orderFamilyId?: string;
    orderName?: string;
    orderTotalTons?: number;
    orderVehicleCount?: number;
    pathKey?: string;
    from?: string;
    to?: string;
    coordinates: [number, number][];
    travelDurationMs?: number;
    routeLengthKm?: number;
    speedKmh?: number;
    plate?: string;
    cargo?: string;
    cargoWeight?: number;
    cargoUnit?: string;
    status?: string;
    vehicleId?: string;
    colorKey?: string;
    isRouteBranch?: boolean;
};

export type TruckPositionMessage = {
    type: 'truck_position';
    lineId: string;
    position?: [number, number];
    speed?: [number, number];
    velocity?: [number, number];
    speedKmh?: number;
    progress?: number;
    status?: 'running' | 'finished' | string;
    scope?: 'rm1' | 'rm2';
    groupId?: string;
    snapshotVersion?: string;
    vehicleId?: string;
    colorKey?: string;
    isRouteBranch?: boolean;
    plate?: string;
    source?: string;
    stale?: boolean;
    fetchedAt?: string;
    speedQuality?: 'provider' | 'calculated' | 'fallback' | 'rejected';
    driverName?: string;
    address?: string;
    stateStr?: string;
    alarmStr?: string;
    alarmSeverity?: 'none' | 'warning' | 'critical';
    online?: boolean;
    directionDeg?: number;
    directionLabel?: string;
    routeRevision?: number;
    routeCoordinates?: [number, number][];
    deviationCoordinates?: [number, number][];
    routeLengthKm?: number;
    travelDurationMs?: number;
    pathKey?: string;
    routeDeviationCount?: number;
    routeDeviationDistanceKm?: number;
    sequence?: number;
};

export type VehiclePositionsMessage = {
    type: 'vehicle_positions';
    scope: 'rm1' | 'rm2';
    serverTime: string;
    snapshotVersion?: string;
    positions: TruckPositionMessage[];
};

export type WarehouseFocusPanel = {
    id: string;
    title: string;
    chartType: 'table' | 'bar' | 'line' | 'pie' | 'ring';
    height?: number;
    columns?: Array<{ key: string; label: string }>;
    rows?: Array<Record<string, any>>;
    option?: any;
};

export type WarehouseFocusStyle = {
    width?: number;
    maxHeight?: number;
    padding?: number;
    titleFontSize?: number;
    bodyFontSize?: number;
    chartTextFontSize?: number;
    placement?: string;
    theme?: string;
};

type DashboardMessage =
    | CityRaiseMessage
    | CityFallMessage
    | RoadPathMessage
    | TruckPositionMessage
    | VehiclePositionsMessage
    | { type?: string; [key: string]: unknown };

export type RouteOrder = {
    lineId: string;
    orderId?: string;
    from: string;
    to: string;
    fromCoords: [number, number];
    toCoords: [number, number];
    currentPosition?: [number, number];
    routeLengthKm?: number;
    travelDurationMs?: number;
    pathKey?: string;
    orderFamilyId?: string;
    orderTotalTons?: number;
    plate: string;
    cargo: string;
    cargoWeight?: number;
    cargoUnit?: string;
    status: string;
    colorKey?: string;
    isRouteBranch?: boolean;
    speedKmh?: number | null;
    driverName?: string;
    address?: string;
    stateStr?: string;
    alarmStr?: string;
    alarmSeverity?: 'none' | 'warning' | 'critical';
    online?: boolean;
    directionDeg?: number;
    directionLabel?: string;
};

type UseDashboardRealtimeOptions = {
    view?: ViewMode;
    onCityRaise: (cityName: string) => void;
    onCityFall: (cityName: string) => void;
    onRouteRaise: (order: RouteOrder) => void;
    onRouteFall?: (lineId: string) => void;
    onRoadPath?: (message: RoadPathMessage) => void;
    onTruckPosition?: (message: TruckPositionMessage) => void;
    onVehiclePositions?: (message: VehiclePositionsMessage) => void;
    onWarehouseUpdate?: (cityName: string, action: string, displayData: Record<string, any>) => void;
    onWarehouseFocus?: (cityName: string, panels: WarehouseFocusPanel[], style?: WarehouseFocusStyle) => void;
    onCameraControl?: (cityNames: string[], mode: 'overview' | 'focus') => void;
    onRouteSnapshotChanged?: (message: RouteSnapshotChangedMessage) => void;
};

const HEADQUARTERS = '\u4f5b\u5c71';
const CARGO_NAMES = ['\u94dd\u952d', '\u94dc\u6750', '\u94a2\u6750', '\u5316\u5de5\u539f\u6599', '\u5176\u4ed6'];
const PLATE_PREFIXES = ['\u7ca4A', '\u7ca4B', '\u6e58E', '\u8d63C', '\u82cfE', '\u6d59A'];
const CITY_RISE_DELAY = 500;
const CITY_RISE_DURATION = 1200;
const FLY_LINE_DELAY = CITY_RISE_DELAY + CITY_RISE_DURATION + 120;
const FLY_GROW_DURATION = 1300;
const FLY_TRAVEL_DURATION = 2400;
const ROUTE_MIN_LIFETIME = FLY_LINE_DELAY + FLY_GROW_DURATION + FLY_TRAVEL_DURATION * 2;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_STALE_MS = 55_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;

function buildRealtimeUrl() {
    const accessToken = getDashboardAccessToken();
    if (!accessToken) return null;
    const defaultProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const baseUrl = import.meta.env.VITE_WS_URL || `${defaultProtocol}//${window.location.host}/ws`;
    const normalizedBase = String(baseUrl).replace(/\/$/, '');
    const endpoint = normalizedBase.endsWith('/realtime') ? normalizedBase : `${normalizedBase}/realtime`;
    const url = new URL(endpoint);
    url.searchParams.set('token', accessToken);
    return url.toString();
}

function normalizeCityName(cityName: string) {
    return cityName.endsWith('\u5e02') ? cityName.slice(0, -1) : cityName;
}

function hashText(text: string) {
    return Array.from(text).reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function createRouteOrder(line: CityRaiseMessage): RouteOrder {
    const hash = hashText(line.lineId);
    return {
        lineId: line.lineId,
        from: line.from,
        to: line.to,
        fromCoords: line.fromCoords,
        toCoords: line.toCoords,
        plate: `${PLATE_PREFIXES[hash % PLATE_PREFIXES.length]}\u00b7${line.lineId.slice(0, 6).toUpperCase()}`,
        cargo: CARGO_NAMES[hash % CARGO_NAMES.length],
        status: '\u8fd0\u8f93\u4e2d',
    };
}

export function useDashboardRealtime(options: UseDashboardRealtimeOptions) {
    const optionsRef = useRef(options);
    const socketRef = useRef<WebSocket | null>(null);
    const subscribedVehiclePositionScopeRef = useRef<'rm1' | 'rm2' | null>(null);
    const activeLinesRef = useRef<Map<string, { from: string; to: string; startedAt: number }>>(new Map());
    const activeCityCountRef = useRef<Map<string, number>>(new Map());
    const cityFallTimersRef = useRef<Map<string, number>>(new Map());
    const reconnectTimerRef = useRef<number | null>(null);
    const heartbeatTimerRef = useRef<number | null>(null);
    const reconnectAttemptRef = useRef(0);
    const lastMessageAtRef = useRef(0);

    optionsRef.current = options;

    const syncVehiclePositionSubscription = () => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const nextScope = optionsRef.current.view === 'roadMap2'
            ? 'rm2'
            : optionsRef.current.view === 'roadMap'
                ? 'rm1'
                : null;
        if (subscribedVehiclePositionScopeRef.current === nextScope) return;
        socket.send(JSON.stringify({
            type: 'vehicle_position_subscription',
            scope: nextScope ?? '',
            active: nextScope !== null,
            clientTime: Date.now(),
        }));
        subscribedVehiclePositionScopeRef.current = nextScope;
    };

    useEffect(() => {
        let socket: WebSocket | null = null;
        let disposed = false;


        const riseTrackedCity = (cityName: string) => {
            const normalized = normalizeCityName(cityName);
            activeCityCountRef.current.set(normalized, (activeCityCountRef.current.get(normalized) ?? 0) + 1);
            optionsRef.current.onCityRaise(normalized);
        };

        const fallTrackedCity = (cityName: string) => {
            const normalized = normalizeCityName(cityName);
            if (normalized === HEADQUARTERS) return;

            const nextCount = (activeCityCountRef.current.get(normalized) ?? 1) - 1;
            if (nextCount > 0) {
                activeCityCountRef.current.set(normalized, nextCount);
                return;
            }

            activeCityCountRef.current.delete(normalized);
            optionsRef.current.onCityFall(normalized);
        };

        const handleMessage = (message: DashboardMessage) => {
            console.log('📩 收到 WebSocket 消息:', message);
            if (message.type === 'city_raise') {
                const line = message as CityRaiseMessage;
                const oldTimer = cityFallTimersRef.current.get(line.lineId);
                if (oldTimer !== undefined) {
                    window.clearTimeout(oldTimer);
                    cityFallTimersRef.current.delete(line.lineId);
                }
                activeLinesRef.current.set(line.lineId, { from: line.from, to: line.to, startedAt: performance.now() });
                optionsRef.current.onRouteRaise(createRouteOrder(line));
                riseTrackedCity(line.from);
                riseTrackedCity(line.to);
                return;
            }

            if (message.type === 'city_fall') {
                const line = message as CityFallMessage;
                const activeLine = activeLinesRef.current.get(line.lineId);
                if (!activeLine) return;

                activeLinesRef.current.delete(line.lineId);
                optionsRef.current.onRouteFall?.(line.lineId);

                const elapsed = performance.now() - activeLine.startedAt;
                const remaining = Math.max(0, ROUTE_MIN_LIFETIME - elapsed);
                const releaseCities = () => {
                    cityFallTimersRef.current.delete(line.lineId);
                    fallTrackedCity(activeLine.from);
                    fallTrackedCity(activeLine.to);
                };

                if (remaining === 0) {
                    releaseCities();
                } else {
                    const timer = window.setTimeout(releaseCities, remaining);
                    cityFallTimersRef.current.set(line.lineId, timer);
                }
                return;
            }

            if (message.type === 'road_path') {
                optionsRef.current.onRoadPath?.(message as RoadPathMessage);
                return;
            }

            if (message.type === 'truck_position') {
                optionsRef.current.onTruckPosition?.(message as TruckPositionMessage);
                return;
            }

            if (message.type === 'vehicle_positions') {
                optionsRef.current.onVehiclePositions?.(message as VehiclePositionsMessage);
                return;
            }

            if (message.type === 'daily_kpis' && isDailyOrderStatistics(message)) {
                window.dispatchEvent(new CustomEvent(DAILY_KPI_EVENT, { detail: message }));
                return;
            }

            if (message.type === 'warehouse_update' && optionsRef.current.onWarehouseUpdate) {
                const { cityName, action, displayData } = message as any;
                console.log('🏭 仓库更新:', cityName, action, displayData);
                optionsRef.current.onWarehouseUpdate(cityName, action, displayData ??{});
                return;
            }
            if (message.type === 'warehouse_focus' && optionsRef.current.onWarehouseFocus) {
                const { cityName, panels, style } = message as any;
                optionsRef.current.onWarehouseFocus(cityName, panels ?? [], style);
                return;
            }
            if (message.type === 'camera_control' && optionsRef.current.onCameraControl) {
                const { cityNames, mode } = message as any;
                optionsRef.current.onCameraControl(cityNames, mode);
                return;
            }
            if (message.type === 'route_snapshot_changed' && optionsRef.current.onRouteSnapshotChanged) {
                optionsRef.current.onRouteSnapshotChanged(message as RouteSnapshotChangedMessage);
                return;
            }
        };

        const clearHeartbeat = () => {
            if (heartbeatTimerRef.current !== null) {
                window.clearInterval(heartbeatTimerRef.current);
                heartbeatTimerRef.current = null;
            }
        };

        const scheduleReconnect = () => {
            if (disposed || reconnectTimerRef.current !== null) return;
            const attempt = reconnectAttemptRef.current;
            const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
            reconnectAttemptRef.current = Math.min(attempt + 1, 6);
            reconnectTimerRef.current = window.setTimeout(() => {
                reconnectTimerRef.current = null;
                connect();
            }, delay);
        };

        const startHeartbeat = (currentSocket: WebSocket) => {
            clearHeartbeat();
            lastMessageAtRef.current = Date.now();
            heartbeatTimerRef.current = window.setInterval(() => {
                if (currentSocket.readyState !== WebSocket.OPEN) return;

                const silentMs = Date.now() - lastMessageAtRef.current;
                if (silentMs > HEARTBEAT_STALE_MS) {
                    console.warn(`WebSocket heartbeat timeout after ${silentMs}ms, reconnecting`);
                    currentSocket.close(4000, 'heartbeat timeout');
                    return;
                }

                // 应用层心跳：浏览器不能主动发 websocket ping 帧，所以用 JSON ping/pong 保活和探活。
                currentSocket.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
            }, HEARTBEAT_INTERVAL_MS);
        };

        const connect = () => {
            if (disposed) return;
            if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

            const realtimeUrl = buildRealtimeUrl();
            if (!realtimeUrl) {
                scheduleReconnect();
                return;
            }
            socket = new WebSocket(realtimeUrl);
            socketRef.current = socket;

            socket.onopen = () => {
                reconnectAttemptRef.current = 0;
                startHeartbeat(socket as WebSocket);
                syncVehiclePositionSubscription();
                console.info('WebSocket connected');
            };

            socket.onmessage = (event) => {
                lastMessageAtRef.current = Date.now();
                try {
                    const message = JSON.parse(event.data);
                    if (message?.type === 'pong') return;
                    handleMessage(message);
                } catch (error) {
                    console.warn('Invalid dashboard websocket message', error);
                }
            };

            socket.onerror = (event) => {
                console.warn('WebSocket error', event);
            };

            socket.onclose = (event) => {
                clearHeartbeat();
                if (disposed) return;
                console.warn('WebSocket closed, scheduling reconnect', {
                    code: event.code,
                    reason: event.reason,
                    wasClean: event.wasClean,
                });
                socket = null;
                socketRef.current = null;
                subscribedVehiclePositionScopeRef.current = null;
                scheduleReconnect();
            };
        };

        connect();

        return () => {
            disposed = true;
            if (reconnectTimerRef.current !== null) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            clearHeartbeat();
            cityFallTimersRef.current.forEach((timer) => window.clearTimeout(timer));
            cityFallTimersRef.current.clear();
            socket?.close(1000, 'component unmounted');
        };
    }, []);

    useEffect(() => {
        syncVehiclePositionSubscription();
    }, [options.view]);
}
