import { useEffect, useRef } from 'react';
import type { TownRoadRenderCommand, TownRoadRenderIncoming } from '../modules/TownRoadMap3D';

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
    carId?: string;
    cargo?: string;
};

export type TruckPositionMessage = {
    type: 'truck_position';
    lineId: string;
    position: [number, number];
    speed?: [number, number];
    velocity?: [number, number];
    speedKmh?: number;
    progress?: number;
    status?: 'running' | 'finished' | string;
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
    | TownRoadRenderCommand
    | { type?: string; [key: string]: unknown };

export type RouteOrder = {
    lineId: string;
    from: string;
    to: string;
    fromCoords: [number, number];
    toCoords: [number, number];
    routeLengthKm?: number;
    plate: string;
    cargo: string;
    status: string;
};

type UseDashboardRealtimeOptions = {
    onCityRaise: (cityName: string) => void;
    onCityFall: (cityName: string) => void;
    onRouteRaise: (order: RouteOrder) => void;
    onRouteFall?: (lineId: string) => void;
    onRoadPath?: (message: RoadPathMessage) => void;
    onTruckPosition?: (message: TruckPositionMessage) => void;
    onWarehouseUpdate?: (cityName: string, action: string, displayData: Record<string, any>) => void;
    onWarehouseFocus?: (cityName: string, panels: WarehouseFocusPanel[], style?: WarehouseFocusStyle) => void;
    onCameraControl?: (cityNames: string[], mode: 'overview' | 'focus') => void;

    // TownRoadMap 后端渲染命令复用同一条 /ws/realtime，避免另开一条 WebSocket。
    onTownRoadRender?: (payload: TownRoadRenderIncoming) => void;
};

const WS_TOKEN = String(import.meta.env.VITE_WS_TOKEN || 'jushen-screen-token');
const HEADQUARTERS = '佛山';
const CARGO_NAMES = ['铝锭', '铜材', '钢材', '化工原料', '其他'];
const PLATE_PREFIXES = ['粤A', '粤B', '湘E', '赣C', '苏E', '浙A'];
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
    const baseUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws';
    const normalizedBase = String(baseUrl).replace(/\/$/, '');
    const endpoint = normalizedBase.endsWith('/realtime') ? normalizedBase : `${normalizedBase}/realtime`;
    const url = new URL(endpoint);
    url.searchParams.set('token', WS_TOKEN);
    return url.toString();
}

function normalizeCityName(cityName: string) {
    return cityName.endsWith('市') ? cityName.slice(0, -1) : cityName;
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
        plate: `${PLATE_PREFIXES[hash % PLATE_PREFIXES.length]}·${line.lineId.slice(0, 6).toUpperCase()}`,
        cargo: CARGO_NAMES[hash % CARGO_NAMES.length],
        status: '运输中',
    };
}

function isTownRoadRenderCommandPayload(payload: any): payload is TownRoadRenderCommand {
    if (!payload || payload.type !== 'town_road_render') return false;
    return Array.isArray(payload.renderProvinces)
        || Array.isArray(payload.orders)
        || Array.isArray(payload.routeGroups)
        || Array.isArray(payload.provinceEdges)
        || Array.isArray(payload.renderAdcodes)
        || Array.isArray(payload.tasks);
}

function extractTownRoadRenderPayload(message: DashboardMessage): TownRoadRenderIncoming | null {
    if (message?.type !== 'town_road_render') return null;
    const payload = message as any;

    // 新后端结构：外层是一次轮询/模拟结果，真正要渲染的是 commands[]。
    // 这里保留 wrapper 本身，避免丢失 primaryCommandId / diff 等预处理信息。
    if (Array.isArray(payload.commands)) {
        const commands = payload.commands.filter(isTownRoadRenderCommandPayload);
        return commands.length > 0 ? { ...payload, commands } : null;
    }

    // 兼容旧结构：后端直接广播单个 town_road_render 命令。
    if (isTownRoadRenderCommandPayload(payload)) {
        return payload;
    }

    return null;
}

export function useDashboardRealtime(options: UseDashboardRealtimeOptions) {
    const optionsRef = useRef(options);
    const activeLinesRef = useRef<Map<string, { from: string; to: string; startedAt: number }>>(new Map());
    const activeCityCountRef = useRef<Map<string, number>>(new Map());
    const cityFallTimersRef = useRef<Map<string, number>>(new Map());
    const reconnectTimerRef = useRef<number | null>(null);
    const heartbeatTimerRef = useRef<number | null>(null);
    const connectTimerRef = useRef<number | null>(null);
    const reconnectAttemptRef = useRef(0);
    const lastMessageAtRef = useRef(0);

    optionsRef.current = options;

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
            if (message.type === 'ping') return;
            const townRoadPayload = extractTownRoadRenderPayload(message);
            if (townRoadPayload) {
                optionsRef.current.onTownRoadRender?.(townRoadPayload);
                return;
            }

            console.log('📩 收到 WebSocket 消息:', message);

            if (message.type === 'city_raise') {
                const line = message as CityRaiseMessage;
                const oldTimer = cityFallTimersRef.current.get(line.lineId);
                if (oldTimer !== undefined) {
                    window.clearTimeout(oldTimer);
                    cityFallTimersRef.current.delete(line.lineId);
                }

                activeLinesRef.current.set(line.lineId, {
                    from: line.from,
                    to: line.to,
                    startedAt: performance.now(),
                });
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

            if (message.type === 'warehouse_update' && optionsRef.current.onWarehouseUpdate) {
                const { cityName, action, displayData } = message as any;
                console.log('🏭 仓库更新:', cityName, action, displayData);
                optionsRef.current.onWarehouseUpdate(cityName, action, displayData ?? {});
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
                currentSocket.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
            }, HEARTBEAT_INTERVAL_MS);
        };

        const connect = () => {
            if (disposed) return;
            if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
            socket = new WebSocket(buildRealtimeUrl());

            socket.onopen = () => {
                reconnectAttemptRef.current = 0;
                startHeartbeat(socket as WebSocket);
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
                if (disposed) return;
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
                scheduleReconnect();
            };
        };

        // 延迟到下一轮事件循环再连接，避免 React StrictMode 初次 mount/unmount
        // 立刻关闭 CONNECTING socket 造成“closed before established”的开发期噪音。
        connectTimerRef.current = window.setTimeout(() => {
            connectTimerRef.current = null;
            connect();
        }, 0);

        return () => {
            disposed = true;
            if (connectTimerRef.current !== null) {
                window.clearTimeout(connectTimerRef.current);
                connectTimerRef.current = null;
            }
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
}
