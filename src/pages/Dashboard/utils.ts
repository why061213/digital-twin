import * as THREE from 'three';
import type { TruckPositionMessage } from './hooks/useDashboardRealtime';
import type { ActiveRoute, LonLat, RoadGroupRing, RoadGroupStrategy, RouteOrder } from './types';
import { LOW_SPEED_THRESHOLD_KMH, POSITION_QUERY_INTERVAL_MS, SLOW_POSITION_QUERY_INTERVAL_MS } from './constants';

export function createRoadGroupRing(): RoadGroupRing {
    return { head: null, tail: null, current: null, nodes: new Map() };
}

export function ensureRoadGroupRing(rings: Map<RoadGroupStrategy, RoadGroupRing>, strategy: RoadGroupStrategy) {
    let ring = rings.get(strategy);
    if (!ring) {
        ring = createRoadGroupRing();
        rings.set(strategy, ring);
    }
    return ring;
}

export function hashText(text: string) {
    return Array.from(text).reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

export function lerp(start: number, end: number, progress: number) {
    return start + (end - start) * progress;
}

export function clamp01(value: number) {
    return Math.min(Math.max(value, 0), 1);
}

export function waitFrame() {
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

export function waitMs(delay: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, delay));
}

export function distance(a: LonLat, b: LonLat) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    return Math.sqrt(dx * dx + dy * dy);
}

export function buildPlate(lineId: string) {
    const prefixes = ['粤A', '粤B', '湘E', '赣C', '苏E', '浙A'];
    const hash = hashText(lineId);
    return `${prefixes[hash % prefixes.length]}路${lineId.slice(0, 6).toUpperCase()}`;
}

export function buildCargo(lineId: string) {
    const cargos = ['铝锭', '铜材', '钢材', '化工原料', '其他'];
    return cargos[hashText(lineId) % cargos.length];
}

export function pathLength(coordinates: LonLat[]) {
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
        total += distance(coordinates[i - 1], coordinates[i]);
    }
    return total;
}

export function distanceKm(a: LonLat, b: LonLat) {
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

export function pathLengthKm(coordinates: LonLat[]) {
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
        total += distanceKm(coordinates[i - 1], coordinates[i]);
    }
    return total;
}

export const FALLBACK_TRUCK_SPEED_KMH = 60;
export const MAX_TRUSTED_TRUCK_SPEED_KMH = 130;
const MIN_MEASURED_SPEED_INTERVAL_MS = 5_000;

export function trustedTruckSpeedKmh(value: unknown): number | null {
    const speed = Number(value);
    return Number.isFinite(speed) && speed >= 0 && speed <= MAX_TRUSTED_TRUCK_SPEED_KMH
        ? speed
        : null;
}

export function pathSpeedFromKmh(
    pathLengthValue: number,
    routeLengthKm: number,
    speedKmh: number,
) {
    if (pathLengthValue <= 0 || routeLengthKm <= 0 || speedKmh <= 0) return 0;
    return pathLengthValue * speedKmh / routeLengthKm / 3_600_000;
}

export function safeTravelDurationMs(
    routeLengthKm: number,
    suppliedDurationMs: unknown,
    speedKmh: number,
) {
    const duration = Number(suppliedDurationMs);
    const impliedSpeedKmh = duration > 0 && routeLengthKm > 0
        ? routeLengthKm / duration * 3_600_000
        : Number.POSITIVE_INFINITY;
    if (Number.isFinite(duration)
        && duration >= 60_000
        && impliedSpeedKmh <= MAX_TRUSTED_TRUCK_SPEED_KMH) {
        return duration;
    }
    return routeLengthKm > 0
        ? Math.max(60_000, routeLengthKm / Math.max(1, speedKmh) * 3_600_000)
        : 60_000;
}

type RouteCorridorResult = {
    inside: boolean;
    nearestSegmentIndex: number;
    distanceKm: number;
};

function localKilometers(point: LonLat, referenceLatitude: number): [number, number] {
    const latitudeRadians = referenceLatitude * Math.PI / 180;
    return [
        point[0] * 111.32 * Math.cos(latitudeRadians),
        point[1] * 110.574,
    ];
}

/**
 * 判断位置是否落在任意节点线段两侧 toleranceKm 的矩形内。
 * 不使用端点圆帽，超出线段首尾的点会被视为走廊外。
 */
export function inspectRouteCorridor(
    nodes: LonLat[],
    point: LonLat,
    toleranceKm: number,
): RouteCorridorResult {
    if (nodes.length < 2) {
        return { inside: false, nearestSegmentIndex: 0, distanceKm: Number.POSITIVE_INFINITY };
    }

    let inside = false;
    let nearestSegmentIndex = 0;
    let nearestDistanceKm = Number.POSITIVE_INFINITY;

    for (let index = 1; index < nodes.length; index += 1) {
        const start = nodes[index - 1];
        const end = nodes[index];
        const referenceLatitude = (start[1] + end[1] + point[1]) / 3;
        const [startX, startY] = localKilometers(start, referenceLatitude);
        const [endX, endY] = localKilometers(end, referenceLatitude);
        const [pointX, pointY] = localKilometers(point, referenceLatitude);
        const segmentX = endX - startX;
        const segmentY = endY - startY;
        const segmentLengthSq = segmentX * segmentX + segmentY * segmentY;
        if (segmentLengthSq <= Number.EPSILON) continue;

        const rawProgress = ((pointX - startX) * segmentX + (pointY - startY) * segmentY)
            / segmentLengthSq;
        const clampedProgress = clamp01(rawProgress);
        const projectedX = startX + segmentX * clampedProgress;
        const projectedY = startY + segmentY * clampedProgress;
        const distanceToSegment = Math.hypot(pointX - projectedX, pointY - projectedY);

        if (distanceToSegment < nearestDistanceKm) {
            nearestDistanceKm = distanceToSegment;
            nearestSegmentIndex = index - 1;
        }
        if (rawProgress >= 0 && rawProgress <= 1 && distanceToSegment <= toleranceKm) {
            inside = true;
        }
    }

    return { inside, nearestSegmentIndex, distanceKm: nearestDistanceKm };
}

export function insertRouteNode(nodes: LonLat[], point: LonLat, afterSegmentIndex: number): LonLat[] {
    const insertionIndex = Math.min(Math.max(1, afterSegmentIndex + 1), nodes.length - 1);
    return [
        ...nodes.slice(0, insertionIndex),
        [point[0], point[1]],
        ...nodes.slice(insertionIndex),
    ];
}

/** 生成经过全部节点的 centripetal Catmull-Rom 曲线采样。 */
export function buildCentripetalRoute(nodes: LonLat[], samplesPerSegment = 32): LonLat[] {
    if (nodes.length < 3) return nodes.map((point) => [point[0], point[1]]);
    const curve = new THREE.CatmullRomCurve3(
        nodes.map(([lng, lat]) => new THREE.Vector3(lng, lat, 0)),
        false,
        'centripetal',
    );
    const segmentCount = nodes.length - 1;
    return curve
        .getPoints(Math.max(segmentCount * samplesPerSegment, 64))
        .map((point): LonLat => [point.x, point.y]);
}

export function positionAtDistance(coordinates: LonLat[], targetDistance: number): LonLat {
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

export function projectDistanceOnPath(coordinates: LonLat[], point: LonLat) {
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

export function predictedPosition(route: ActiveRoute, now: number): LonLat {
    return positionAtDistance(route.coordinates, predictedDistance(route, now));
}

export function predictedDistance(route: ActiveRoute, now: number) {
    if (route.pathLength <= 0) return 0;
    const elapsed = Math.max(0, now - route.calibratedAt);
    return Math.min(route.pathLength, route.calibratedDistance + route.pathSpeed * elapsed);
}

export function nextQueryInterval(speedKmh: number | null) {
    if (speedKmh !== null && speedKmh < LOW_SPEED_THRESHOLD_KMH) {
        return SLOW_POSITION_QUERY_INTERVAL_MS;
    }
    return POSITION_QUERY_INTERVAL_MS;
}

export function initialPositionQueryDelay(lineId: string) {
    return 800 + (hashText(lineId) % 4_200);
}

export function routeProgressPatch(route: ActiveRoute, now: number) {
    const currentDistance = predictedDistance(route, now);
    return {
        progress: route.pathLength > 0 ? clamp01(currentDistance / route.pathLength) : 0,
        calibratedDistance: currentDistance,
        currentPosition: positionAtDistance(route.coordinates, currentDistance),
        pathLength: route.pathLength,
        routeLengthKm: route.routeLengthKm,
        speedKmh: route.speedKmh,
    };
}

export function applyTruckPositionToRoute(route: ActiveRoute, message: TruckPositionMessage, now: number) {
    if (!message.position) return;
    const elapsedSinceLastCalibration = now - route.calibratedAt;
    const nextDistance = projectDistanceOnPath(route.coordinates, message.position);
    const measuredPathSpeed = elapsedSinceLastCalibration >= MIN_MEASURED_SPEED_INTERVAL_MS
        ? Math.max(0, (nextDistance - route.calibratedDistance) / elapsedSinceLastCalibration)
        : null;
    const measuredSpeedKmh = measuredPathSpeed !== null && route.pathLength > 0
        ? measuredPathSpeed / route.pathLength * route.routeLengthKm * 3_600_000
        : null;
    const trustedSpeedKmh = trustedTruckSpeedKmh(message.speedKmh)
        ?? trustedTruckSpeedKmh(measuredSpeedKmh)
        ?? trustedTruckSpeedKmh(route.speedKmh)
        ?? FALLBACK_TRUCK_SPEED_KMH;

    route.pathSpeed = pathSpeedFromKmh(route.pathLength, route.routeLengthKm, trustedSpeedKmh);
    route.speedKmh = trustedSpeedKmh;
    route.calibratedAt = now;
    route.calibratedDistance = nextDistance;
    route.nextCalibrationAt = now + nextQueryInterval(route.speedKmh);
    route.arrivalCheckRequested = false;
}

export function mergeVisibleRouteOrders(previous: RouteOrder[], incoming: ActiveRoute[], completedIds: Set<string>) {
    const merged = new Map<string, RouteOrder>();

    previous.forEach((route) => {
        merged.set(route.lineId, route);
    });

    incoming.forEach((route) => {
        const old = merged.get(route.lineId);
        merged.set(route.lineId, {
            ...old,
            ...route,
            status: completedIds.has(route.lineId) ? '已完成' : route.status,
        });
    });

    completedIds.forEach((lineId) => {
        const route = merged.get(lineId);
        if (route) {
            merged.set(lineId, { ...route, status: '已完成' });
        }
    });

    return Array.from(merged.values());
}
