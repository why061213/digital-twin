import { API_BASE_URL } from '../constants';
import type { RoadPathMessage, TruckPositionMessage } from '../hooks/useDashboardRealtime';

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
    orderLineIds: string[];
    mapKey: string;
};

export type Rm2GroupsResponse = {
    snapshotVersion: string;
    scope: 'rm2';
    groupSize: number;
    totalRoutes: number;
    groups: Rm2GroupDTO[];
    diagnostics: Rm2GroupsDiagnostics;
};

export type Rm2GroupsDiagnostics = {
    snapshotVersion: string;
    totalRoutes: number;
    backendGroupCount: number;
    acceptedGroupCount: number;
    rejectedGroups: string[];
};

export type Rm2GroupRoutesResponse = {
    snapshotVersion: string;
    scope: 'rm2';
    groupId: string;
    coordinateSystem: string;
    routes: RenderRouteDTO[];
    positions: TruckPositionMessage[];
    rejected: unknown[];
    receivedRouteCount: number;
    /** 版本不一致时后端返回 mismatch:true + 空 routes */
    mismatch?: boolean;
};

export type RouteSnapshotChangedMessage = {
    type: 'route_snapshot_changed';
    scope: 'rm2';
    snapshotVersion: string;
    changedGroupIds: string[];
    removedGroupIds: string[];
    serverTime: string;
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

function groupRejectReason(value: unknown): string | null {
    if (!isRecord(value)) return 'group is not an object';
    if (typeof value.groupId !== 'string' || value.groupId.length === 0) return 'missing groupId';
    if (typeof value.groupName !== 'string' || value.groupName.length === 0) return `${value.groupId}: missing groupName`;
    if (typeof value.index !== 'number' || !Number.isFinite(value.index)) return `${value.groupId}: invalid index`;
    if (typeof value.count !== 'number' || !Number.isFinite(value.count)) return `${value.groupId}: invalid count`;
    const lineIds = (value as Record<string, unknown>).orderLineIds ?? (value as Record<string, unknown>).lineIds;
    if (!Array.isArray(lineIds) || !lineIds.every((lineId: unknown) => typeof lineId === 'string')) return `${value.groupId}: invalid orderLineIds`;
    if (typeof value.mapKey !== 'string' || value.mapKey.length === 0) return `${value.groupId}: missing mapKey`;
    return null;
}

function isRm2Group(value: unknown): value is Rm2GroupDTO {
    return groupRejectReason(value) === null;
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

    const snapshotVersion = typeof data.snapshotVersion === 'string' ? data.snapshotVersion : '';
    const totalRoutes = typeof data.totalRoutes === 'number' ? data.totalRoutes : 0;
    const rejectedGroups = data.groups
        .map(groupRejectReason)
        .filter((reason): reason is string => reason !== null);
    const groups = data.groups.filter(isRm2Group);
    const diagnostics = {
        snapshotVersion,
        totalRoutes,
        backendGroupCount: data.groups.length,
        acceptedGroupCount: groups.length,
        rejectedGroups,
    };
    console.info('[RM2 groups]', diagnostics);

    return {
        snapshotVersion,
        scope: 'rm2',
        groupSize: typeof data.groupSize === 'number' ? data.groupSize : 12,
        totalRoutes,
        groups,
        diagnostics,
    };
}

export async function fetchRm2GroupRoutes(
    groupId: string,
    snapshotVersion: string,
    signal?: AbortSignal,
): Promise<Rm2GroupRoutesResponse> {
    const query = new URLSearchParams({ snapshotVersion });
    const data = await getJson(
        `/road/rm2/groups/${encodeURIComponent(groupId)}/routes?${query}`,
        signal,
    );

    // 版本不一致：后端返回 mismatch:true + 空 routes
    if (isRecord(data) && data.mismatch === true) {
        return {
            snapshotVersion: typeof data.snapshotVersion === 'string' ? data.snapshotVersion : '',
            scope: 'rm2',
            groupId,
            coordinateSystem: 'GCJ02',
            routes: [],
            positions: [],
            rejected: [],
            receivedRouteCount: 0,
            mismatch: true,
        };
    }

    if (!isRecord(data) || data.scope !== 'rm2' || data.groupId !== groupId || !Array.isArray(data.routes)) {
        throw new Error('Invalid RM2 group routes response');
    }

    const invalidCount = data.routes.filter((route) => !isRenderRoute(route)).length;
    const positions = Array.isArray(data.positions)
        ? data.positions.filter((position): position is TruckPositionMessage => (
            isRecord(position)
            && typeof position.lineId === 'string'
            && Array.isArray(position.position)
        ))
        : [];
    return {
        snapshotVersion: typeof data.snapshotVersion === 'string' ? data.snapshotVersion : '',
        scope: 'rm2',
        groupId,
        coordinateSystem: typeof data.coordinateSystem === 'string' ? data.coordinateSystem : 'GCJ02',
        routes: data.routes.filter(isRenderRoute),
        positions,
        rejected: [...(Array.isArray(data.rejected) ? data.rejected : []), ...Array(invalidCount).fill('client-invalid-route')],
        receivedRouteCount: data.routes.length,
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
