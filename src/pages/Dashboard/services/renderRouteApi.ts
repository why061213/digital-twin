import { API_BASE_URL } from '../constants';
import { dashboardFetch } from './dashboardAuth';
import type { RoadPathMessage, TruckPositionMessage } from '../hooks/useDashboardRealtime';

export type RouteAnalysisDTO = {
    analysisVersion: string;
    totalLengthM: number;
    parts: Array<{
        partId: string;
        fromMeasureM: number;
        toMeasureM: number;
        routeRole: 'NORMAL' | 'DEVIATION';
        coordinates: [number, number][];
        sharedGroupId?: string | null;
        branchGroupId?: string | null;
        sharedWith: Array<{
            lineId: string;
            visualKey?: string | null;
            orderId?: string | null;
            plate?: string | null;
        }>;
    }>;
};

export type RenderRouteDTO = {
    lineId: string;
    orderId?: string;
    businessLineId: string;
    plate?: string;
    vehicleId?: string;
    from: string;
    to: string;
    fromCoords: [number, number];
    toCoords: [number, number];
    coordinates: [number, number][];
    baselineCoordinates?: [number, number][];
    routeLengthKm?: number;
    speedKmh?: number | null;
    status: string;
    cargo?: string;
    cargoWeight?: number;
    cargoUnit?: string;
    travelDurationMs?: number;
    pathKey: string;
    baselinePathKey?: string;
    routeRevision?: number;
    deviationCoordinates?: [number, number][];
    colorKey?: string;
    isRouteBranch?: boolean;
    scope: 'rm1' | 'rm2';
    groupId: string;
    role: 'primary' | 'along';
    coordinateSystem: string;
    updatedAt?: string;
    routeSignature: string;
    analysis?: RouteAnalysisDTO;
    meta?: {
        tripId?: string;
        visualKey?: string;
        runtimeLineId?: string;
        currentLegId?: string;
        planVersion?: number;
        targetStopId?: string;
        targetOrderInstanceId?: string;
        targetAction?: 'PICKUP' | 'DELIVERY';
        tripPhase?: string;
        tripDecision?: string;
        positionQuality?: string;
        pendingOrderCount?: number;
        onboardOrderCount?: number;
        completedOrderCount?: number;
    };
};

export type Rm2GroupDTO = {
    groupId: string;
    groupName: string;
    index: number;
    count: number;
    orderLineIds: string[];
    vehicleLineIds: string[];
    vehicleLineIdsByOrderLineId: Record<string, string[]>;
    vehicleCount: number;
    mapKey: string;
    fromProvinceKey: string;
    toProvinceKey: string;
    directionKey: string;
    renderProvinceKeys: string[];
    pageIndex: number;
};

export type Rm2ChainNodeDTO = {
    nodeId: string;
    nodeType: 'province' | 'direction' | 'group';
    parentNodeId: string;
    key: string;
    label: string;
    index: number;
    nextNodeId: string;
    childNodeIds: string[];
    groupId?: string | null;
    renderProvinceKeys: string[];
};

export type Rm2ChainStructureResponse = {
    snapshotVersion: string;
    scope: 'rm2';
    headNodeId: string | null;
    nodes: Rm2ChainNodeDTO[];
    leafGroupIds: string[];
};

export type Rm2GroupsResponse = {
    snapshotVersion: string;
    scope: 'rm2';
    groupSize: number;
    totalRoutes: number;
    totalVehicles: number;
    groups: Rm2GroupDTO[];
    diagnostics: Rm2GroupsDiagnostics;
    mismatch?: boolean;
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
    if (!Array.isArray(value.vehicleLineIds) || !value.vehicleLineIds.every((lineId: unknown) => typeof lineId === 'string')) return `${value.groupId}: invalid vehicleLineIds`;
    if (!isRecord(value.vehicleLineIdsByOrderLineId)) return `${value.groupId}: invalid vehicleLineIdsByOrderLineId`;
    if (!Object.values(value.vehicleLineIdsByOrderLineId).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) return `${value.groupId}: invalid vehicle line mapping`;
    if (typeof value.vehicleCount !== 'number' || !Number.isFinite(value.vehicleCount)) return `${value.groupId}: invalid vehicleCount`;
    if (typeof value.mapKey !== 'string' || value.mapKey.length === 0) return `${value.groupId}: missing mapKey`;
    if (typeof value.fromProvinceKey !== 'string' || value.fromProvinceKey.length === 0) return `${value.groupId}: missing fromProvinceKey`;
    if (typeof value.toProvinceKey !== 'string' || value.toProvinceKey.length === 0) return `${value.groupId}: missing toProvinceKey`;
    if (typeof value.directionKey !== 'string' || value.directionKey.length === 0) return `${value.groupId}: missing directionKey`;
    if (!Array.isArray(value.renderProvinceKeys)
        || !value.renderProvinceKeys.every((key) => typeof key === 'string' && /^\d{6}$/.test(key))) {
        return `${value.groupId}: invalid renderProvinceKeys`;
    }
    if (typeof value.pageIndex !== 'number' || !Number.isFinite(value.pageIndex)) return `${value.groupId}: invalid pageIndex`;
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
        && typeof value.businessLineId === 'string'
        && value.businessLineId.length > 0
        && typeof value.groupId === 'string'
        && typeof value.pathKey === 'string'
        && typeof value.from === 'string'
        && typeof value.to === 'string'
        && isValidCoordinates(value.coordinates);
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await dashboardFetch(`${API_BASE_URL}${path}`, { signal });
    if (!response.ok) throw new Error(`RM2 request failed: ${response.status}`);
    return response.json() as Promise<unknown>;
}

function isRm2ChainNode(value: unknown): value is Rm2ChainNodeDTO {
    if (!isRecord(value)) return false;
    return (value.nodeType === 'province' || value.nodeType === 'direction' || value.nodeType === 'group')
        && typeof value.nodeId === 'string'
        && typeof value.parentNodeId === 'string'
        && typeof value.key === 'string'
        && typeof value.label === 'string'
        && typeof value.index === 'number'
        && typeof value.nextNodeId === 'string'
        && Array.isArray(value.childNodeIds)
        && value.childNodeIds.every((nodeId) => typeof nodeId === 'string')
        && Array.isArray(value.renderProvinceKeys)
        && value.renderProvinceKeys.every((key) => typeof key === 'string' && /^\d{6}$/.test(key));
}

export async function fetchRm2ChainStructure(signal?: AbortSignal): Promise<Rm2ChainStructureResponse> {
    const data = await getJson('/road/groups/structure?scope=rm2', signal);
    if (!isRecord(data) || data.scope !== 'rm2' || !Array.isArray(data.nodes) || !Array.isArray(data.leafGroupIds)) {
        throw new Error('Invalid RM2 chain structure response');
    }
    const nodes = data.nodes.filter(isRm2ChainNode);
    if (nodes.length !== data.nodes.length) throw new Error('Invalid RM2 chain node');
    const nodeIds = new Set(nodes.map((node) => node.nodeId));
    const leafGroupIds = data.leafGroupIds.filter((groupId): groupId is string => typeof groupId === 'string');
    if (leafGroupIds.length !== data.leafGroupIds.length) throw new Error('Invalid RM2 leaf group ids');
    nodes.forEach((node) => {
        if (!nodeIds.has(node.nextNodeId)) throw new Error(`RM2 chain next node missing: ${node.nextNodeId}`);
        node.childNodeIds.forEach((childId) => {
            if (!nodeIds.has(childId)) throw new Error(`RM2 chain child node missing: ${childId}`);
        });
    });
    return {
        snapshotVersion: typeof data.snapshotVersion === 'string' ? data.snapshotVersion : '',
        scope: 'rm2',
        headNodeId: typeof data.headNodeId === 'string' ? data.headNodeId : null,
        nodes,
        leafGroupIds,
    };
}

export async function fetchRm2Groups(
    signal?: AbortSignal,
    expectedSnapshotVersion?: string,
): Promise<Rm2GroupsResponse> {
    const query = new URLSearchParams({ scope: 'rm2' });
    if (expectedSnapshotVersion) query.set('snapshotVersion', expectedSnapshotVersion);
    const data = await getJson(`/road/groups?${query}`, signal);
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
        groupSize: typeof data.groupSize === 'number' ? data.groupSize : 3,
        totalRoutes,
        totalVehicles: typeof data.totalVehicles === 'number' ? data.totalVehicles : 0,
        groups,
        diagnostics,
        mismatch: data.mismatch === true,
    };
}

export async function fetchRm2GroupRoutes(
    groupId: string,
    snapshotVersion: string,
    signal?: AbortSignal,
): Promise<Rm2GroupRoutesResponse> {
    const query = new URLSearchParams({ scope: 'rm2', snapshotVersion });
    const data = await getJson(
        `/road/groups/${encodeURIComponent(groupId)}/routes?${query}`,
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
            && (position.status === 'finished' || Array.isArray(position.position))
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
        orderFamilyId: route.businessLineId,
        pathKey: route.pathKey,
        routeRevision: route.routeRevision,
        colorKey: route.colorKey,
        isRouteBranch: route.isRouteBranch,
        vehicleRole: route.role,
        tripId: route.meta?.tripId,
        visualKey: route.meta?.visualKey,
        currentLegId: route.meta?.currentLegId,
        planVersion: route.meta?.planVersion,
        targetStopId: route.meta?.targetStopId,
        targetOrderInstanceId: route.meta?.targetOrderInstanceId,
        targetAction: route.meta?.targetAction,
        tripPhase: route.meta?.tripPhase,
        tripDecision: route.meta?.tripDecision,
        positionQuality: route.meta?.positionQuality,
        pendingOrderCount: route.meta?.pendingOrderCount,
        onboardOrderCount: route.meta?.onboardOrderCount,
        completedOrderCount: route.meta?.completedOrderCount,
        routeSignature: route.routeSignature,
        plate: route.plate,
        vehicleId: route.vehicleId,
        cargo: route.cargo,
        cargoWeight: route.cargoWeight,
        cargoUnit: route.cargoUnit,
        status: route.status,
        from: route.from,
        to: route.to,
        coordinates: route.coordinates,
        routeLengthKm: route.routeLengthKm,
        speedKmh: route.speedKmh ?? undefined,
        travelDurationMs: route.travelDurationMs,
    };
}
