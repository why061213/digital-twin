import type { RoadPathMessage, RouteOrder as RealtimeRouteOrder } from './hooks/useDashboardRealtime';

export type ViewMode = 'warehouse' | 'chinaMap' | 'roadMap';
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
    arrivalCheckRequested: boolean;
};

export type RoadGroupSummary = {
    groupId: string;
    index: number;
    count: number;
    groupScenario?: string;
    displayTemplate?: string;
    scenarioReason?: string;
    groupKey?: string;
    orderIds?: string[];
};

export type RoadGroupsResponse = {
    groupSize: number;
    strategy?: string;
    totalRoutes: number;
    groups: RoadGroupSummary[];
};

export type RoadGroupRoutesResponse = {
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
