import type { RoadPathMessage, RouteOrder as RealtimeRouteOrder } from './hooks/useDashboardRealtime';

export type ViewMode = 'chinaMap' | 'roadMap' | 'roadMap2';
export type LonLat = [number, number];
export type RoadGroupStrategy = 'business-priority' | 'by-order' | 'by-path' | 'by-route';
export type RouteOrder = RealtimeRouteOrder;

export type ActiveRoute = RouteOrder & {
    orderId?: string;
    orderFamilyId?: string;
    orderName?: string;
    orderTotalTons?: number;
    orderVehicleCount?: number;
    pathKey?: string;
    routeRevision?: number;
    startedAt: number;
    fallbackDuration: number;
    coordinates: LonLat[];
    /** 用于偏移走廊判断的折线节点；coordinates 可以是其平滑采样结果。 */
    routeNodes?: LonLat[];
    calibratedAt: number;
    calibratedDistance: number;
    pathSpeed: number;
    pathLength: number;
    routeLengthKm: number;
    speedKmh: number | null;
    driverName?: string;
    address?: string;
    stateStr?: string;
    alarmStr?: string;
    alarmSeverity?: 'none' | 'warning' | 'critical';
    online?: boolean;
    directionDeg?: number;
    directionLabel?: string;
    routeDeviationState?: 'BASELINE' | 'SUSPECTED' | 'ALTERNATIVE' | 'EXPECTED' | 'ANOMALOUS' | 'UNKNOWN';
    routeDeviationReasonCode?: string;
    routeDeviationConfidence?: number;
    routeAnomalyScore?: number;
    nextCalibrationAt: number;
    arrivalCheckRequested: boolean;
};

export type RoadGroupSummary = {
    groupId: string;
    index: number;
    count: number;
    vehicleCount?: number;
    groupScenario?: string;
    displayTemplate?: string;
    scenarioReason?: string;
    groupKey?: string;
    orderIds?: string[];
};

export type RoadGroupsResponse = {
    scope?: 'rm1';
    groupSize: number;
    strategy?: string;
    totalRoutes: number;
    groups: RoadGroupSummary[];
};

export type RoadGroupRoutesResponse = {
    scope?: 'rm1';
    groupId: string;
    routes: RoadPathMessage[];
};

export type RoadGroupNode = {
    groupId: string;
    next: RoadGroupNode | null;
};

export type RoadGroupRing = {
    head: RoadGroupNode | null;
    tail: RoadGroupNode | null;
    current: RoadGroupNode | null;
    nodes: Map<string, RoadGroupNode>;
};
