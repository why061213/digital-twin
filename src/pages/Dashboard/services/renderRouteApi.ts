import { API_BASE_URL } from '../constants';
import type { RoadPathMessage } from '../hooks/useDashboardRealtime';

export type RenderRouteDTO = {
    lineId: string;
    orderId?: string;
    plate?: string;
    vehicleId?: string;
    from: string;
    to: string;
    fromCoords: [number, number];
    toCoords: [number, number];
    coordinates: [number, number][];
    routeLengthKm?: number;
    speedKmh?: number | null;
    status: string;
    cargo?: string;
    travelDurationMs?: number;
    pathKey: string;
    scope: 'rm1' | 'rm2';
    groupId: string;
    role: 'primary' | 'along';
    coordinateSystem: string;
    updatedAt?: string;
    routeSignature: string;
};

export type Rm2GroupDTO = {
    groupId: string;
    groupName: string;
    index: number;
    count: number;
    lineIds: string[];
    mapKey: string;
};

export type Rm2GroupsResponse = {
    snapshotVersion: string;
    scope: 'rm2';
    groupSize: number;
    totalRoutes: number;
    groups: Rm2GroupDTO[];
};

export type Rm2GroupRoutesResponse = {
    snapshotVersion: string;
    scope: 'rm2';
    groupId: string;
    coordinateSystem: string;
    routes: RenderRouteDTO[];
    rejected: unknown[];
};

const CHINA_LNG_MIN = 72;
const CHINA_LNG_MAX = 136;
const CHINA_LAT_MIN = 3;
const CHINA_LAT_MAX = 54;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isValidLonLat(value: unknown): value is [number, number] {
    if (!Array.isArray(value) || value.length < 2) return false;
    const [lng, lat] = value;
    return typeof lng === 'number'
        && typeof lat === 'number'
        && Number.isFinite(lng)
        && Number.isFinite(lat)
        && lng >= CHINA_LNG_MIN
        && lng <= CHINA_LNG_MAX
        && lat >= CHINA_LAT_MIN
        && lat <= CHINA_LAT_MAX;
}

export function isValidCoordinates(value: unknown): value is [number, number][] {
    return Array.isArray(value) && value.length >= 2 && value.every(isValidLonLat);
}

function isRm2Group(value: unknown): value is Rm2GroupDTO {
    if (!isRecord(value)) return false;
    return typeof value.groupId === 'string'
        && typeof value.groupName === 'string'
        && typeof value.index === 'number'
        && typeof value.count === 'number'
        && typeof value.mapKey === 'string'
        && Array.isArray(value.lineIds)
        && value.lineIds.every((lineId) => typeof lineId === 'string');
}

function isRenderRoute(value: unknown): value is RenderRouteDTO {
    if (!isRecord(value)) return false;
    return value.scope === 'rm2'
        && typeof value.lineId === 'string'
        && value.lineId.length > 0
        && typeof value.groupId === 'string'
        && typeof value.pathKey === 'string'
        && typeof value.from === 'string'
        && typeof value.to === 'string'
        && isValidCoordinates(value.coordinates);
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${API_BASE_URL}${path}`, { signal });
    if (!response.ok) throw new Error(`RM2 request failed: ${response.status}`);
    return response.json() as Promise<unknown>;
}

export async function fetchRm2Groups(signal?: AbortSignal): Promise<Rm2GroupsResponse> {
    const data = await getJson('/road/rm2/groups', signal);
    if (!isRecord(data) || data.scope !== 'rm2' || !Array.isArray(data.groups)) {
        throw new Error('Invalid RM2 groups response');
    }

    return {
        snapshotVersion: typeof data.snapshotVersion === 'string' ? data.snapshotVersion : '',
        scope: 'rm2',
        groupSize: typeof data.groupSize === 'number' ? data.groupSize : 12,
        totalRoutes: typeof data.totalRoutes === 'number' ? data.totalRoutes : 0,
        groups: data.groups.filter(isRm2Group),
    };
}

export async function fetchRm2GroupRoutes(groupId: string, signal?: AbortSignal): Promise<Rm2GroupRoutesResponse> {
    const data = await getJson(`/road/rm2/groups/${encodeURIComponent(groupId)}/routes`, signal);
    if (!isRecord(data) || data.scope !== 'rm2' || data.groupId !== groupId || !Array.isArray(data.routes)) {
        throw new Error('Invalid RM2 group routes response');
    }

    const invalidCount = data.routes.filter((route) => !isRenderRoute(route)).length;
    return {
        snapshotVersion: typeof data.snapshotVersion === 'string' ? data.snapshotVersion : '',
        scope: 'rm2',
        groupId,
        coordinateSystem: typeof data.coordinateSystem === 'string' ? data.coordinateSystem : 'GCJ02',
        routes: data.routes.filter(isRenderRoute),
        rejected: [...(Array.isArray(data.rejected) ? data.rejected : []), ...Array(invalidCount).fill('client-invalid-route')],
    };
}

export function adaptRenderRoute(route: RenderRouteDTO): RoadPathMessage | null {
    if (route.scope !== 'rm2' || !isValidCoordinates(route.coordinates)) return null;

    return {
        type: 'road_path',
        lineId: route.lineId,
        groupId: route.groupId,
        orderId: route.orderId,
        pathKey: route.pathKey,
        plate: route.plate,
        vehicleId: route.vehicleId,
        cargo: route.cargo,
        status: route.status,
        from: route.from,
        to: route.to,
        coordinates: route.coordinates,
        routeLengthKm: route.routeLengthKm,
        speedKmh: route.speedKmh ?? undefined,
        travelDurationMs: route.travelDurationMs,
    };
}
