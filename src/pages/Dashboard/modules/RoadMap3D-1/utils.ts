import * as THREE from 'three';

export type CachedTruckPosition = {
    lineId: string;
    position: [number, number];
    status?: string;
    speedKmh?: number | null;
    updatedAt?: string;
};

const TRUCK_POSITION_CACHE_KEY = 'dashboard.truck.positions.v1';

type TruckPositionCachePayload = {
    savedAt: number;
    positions: CachedTruckPosition[];
};

export function loadTruckPositionsFromCache(maxAgeMs = 5 * 60_000): CachedTruckPosition[] {
    try {
        const raw = localStorage.getItem(TRUCK_POSITION_CACHE_KEY);
        if (!raw) return [];

        const payload = JSON.parse(raw) as TruckPositionCachePayload;

        if (!payload || !Array.isArray(payload.positions)) {
            return [];
        }

        if (Date.now() - payload.savedAt > maxAgeMs) {
            return [];
        }

        return payload.positions;
    } catch {
        return [];
    }
}

export function saveTruckPositionsToCache(positions: CachedTruckPosition[]) {
    try {
        const payload: TruckPositionCachePayload = {
            savedAt: Date.now(),
            positions,
        };

        localStorage.setItem(TRUCK_POSITION_CACHE_KEY, JSON.stringify(payload));
    } catch {
        // ignore
    }
}

export function saveTruckPositionToCache(position: CachedTruckPosition) {
    try {
        const current = loadTruckPositionsFromCache(Number.POSITIVE_INFINITY);
        const nextMap = new Map<string, CachedTruckPosition>();

        current.forEach((item) => {
            nextMap.set(item.lineId, item);
        });

        nextMap.set(position.lineId, position);

        saveTruckPositionsToCache(Array.from(nextMap.values()));
    } catch {
        // ignore
    }
}

export function clearTruckPositionsCache() {
    try {
        localStorage.removeItem(TRUCK_POSITION_CACHE_KEY);
    } catch {
        // ignore
    }
}
export function disposeObject3D(object: THREE.Object3D) {
    object.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
            child.geometry.dispose();
            const material = child.material;
            if (Array.isArray(material)) {
                material.forEach((item) => item.dispose());
            } else {
                material.dispose();
            }
        }
    });
}

export function clamp01(value: number) {
    return Math.min(Math.max(value, 0), 1);
}

export function makeLinearCurve(points: THREE.Vector3[]) {
    const path = new THREE.CurvePath<THREE.Vector3>();
    path.add(new THREE.LineCurve3(points[0], points[points.length - 1]));
    return path;
}

export function makePathCurve(points: THREE.Vector3[]) {
    if (points.length === 2) {
        return makeLinearCurve(points);
    }
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < points.length - 1; i++) {
        path.add(new THREE.LineCurve3(points[i], points[i + 1]));
    }
    return path;
}

export function indexCount(geometry: THREE.BufferGeometry) {
    return geometry.index?.count ?? geometry.attributes.position.count;
}

export function formatNumber(value: number | null | undefined, digits = 2) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

export function screenPosition(point: THREE.Vector3, camera: THREE.Camera, container: HTMLDivElement) {
    const projected = point.clone().project(camera);
    return {
        x: (projected.x * 0.5 + 0.5) * container.clientWidth,
        y: (-projected.y * 0.5 + 0.5) * container.clientHeight,
    };
}
