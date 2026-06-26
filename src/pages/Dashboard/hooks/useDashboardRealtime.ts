import { useEffect, useRef } from 'react';

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

type DashboardMessage = CityRaiseMessage | CityFallMessage | { type?: string; [key: string]: unknown };

export type RouteOrder = {
    lineId: string;
    from: string;
    to: string;
    fromCoords: [number, number];
    toCoords: [number, number];
    plate: string;
    cargo: string;
    status: string;
};

type UseDashboardRealtimeOptions = {
    onCityRaise: (cityName: string) => void;
    onCityFall: (cityName: string) => void;
    onRouteRaise: (order: RouteOrder) => void;
    onRouteFall?: (lineId: string) => void;
};

const WS_TOKEN = 'jushen-screen-token';
const HEADQUARTERS = '\u4f5b\u5c71';
const CARGO_NAMES = ['\u94dd\u952d', '\u94dc\u6750', '\u94a2\u6750', '\u5316\u5de5\u539f\u6599', '\u5176\u4ed6'];
const PLATE_PREFIXES = ['\u7ca4A', '\u7ca4B', '\u6e58E', '\u8d63C', '\u82cfE', '\u6d59A'];
const CITY_RISE_DELAY = 500;
const CITY_RISE_DURATION = 1200;
const FLY_LINE_DELAY = CITY_RISE_DELAY + CITY_RISE_DURATION + 120;
const FLY_GROW_DURATION = 1300;
const FLY_TRAVEL_DURATION = 2400;
const ROUTE_MIN_LIFETIME = FLY_LINE_DELAY + FLY_GROW_DURATION + FLY_TRAVEL_DURATION * 2;

function buildRealtimeUrl() {
    const baseUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws';
    const normalizedBase = String(baseUrl).replace(/\/$/, '');
    return `${normalizedBase}/realtime?token=${WS_TOKEN}`;
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

export function useDashboardRealtime({
    onCityRaise,
    onCityFall,
    onRouteRaise,
    onRouteFall,
}: UseDashboardRealtimeOptions) {
    const activeLinesRef = useRef<Map<string, { from: string; to: string; startedAt: number }>>(new Map());
    const activeCityCountRef = useRef<Map<string, number>>(new Map());
    const cityFallTimersRef = useRef<Map<string, number>>(new Map());
    const reconnectTimerRef = useRef<number | null>(null);

    useEffect(() => {
        let socket: WebSocket | null = null;
        let disposed = false;

        const riseTrackedCity = (cityName: string) => {
            const normalized = normalizeCityName(cityName);
            activeCityCountRef.current.set(normalized, (activeCityCountRef.current.get(normalized) ?? 0) + 1);
            onCityRaise(normalized);
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
            onCityFall(normalized);
        };

        const handleMessage = (message: DashboardMessage) => {
            if (message.type === 'city_raise') {
                const line = message as CityRaiseMessage;
                const oldTimer = cityFallTimersRef.current.get(line.lineId);
                if (oldTimer !== undefined) {
                    window.clearTimeout(oldTimer);
                    cityFallTimersRef.current.delete(line.lineId);
                }
                activeLinesRef.current.set(line.lineId, { from: line.from, to: line.to, startedAt: performance.now() });
                onRouteRaise(createRouteOrder(line));
                riseTrackedCity(line.from);
                riseTrackedCity(line.to);
                return;
            }

            if (message.type === 'city_fall') {
                const line = message as CityFallMessage;
                const activeLine = activeLinesRef.current.get(line.lineId);
                if (!activeLine) return;

                activeLinesRef.current.delete(line.lineId);
                onRouteFall?.(line.lineId);

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
            }
        };

        const connect = () => {
            socket = new WebSocket(buildRealtimeUrl());

            socket.onmessage = (event) => {
                try {
                    handleMessage(JSON.parse(event.data));
                } catch (error) {
                    console.warn('Invalid dashboard websocket message', error);
                }
            };

            socket.onclose = () => {
                if (disposed) return;
                reconnectTimerRef.current = window.setTimeout(connect, 3000);
            };
        };

        connect();

        return () => {
            disposed = true;
            if (reconnectTimerRef.current !== null) {
                window.clearTimeout(reconnectTimerRef.current);
            }
            cityFallTimersRef.current.forEach((timer) => window.clearTimeout(timer));
            cityFallTimersRef.current.clear();
            socket?.close();
        };
    }, [onCityFall, onCityRaise, onRouteFall, onRouteRaise]);
}
