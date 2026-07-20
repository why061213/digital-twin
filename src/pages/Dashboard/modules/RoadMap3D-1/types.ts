import * as THREE from 'three';

export type RoadMap3DHandle = {
    setRoadPath: (coords: [number, number][]) => void;
    addRoadPath: (id: string, coords: [number, number][], info?: RoadObjectInfo) => void;
    removeRoadPath: (id: string) => void;
    clearRoads: () => void;
    updateTruckPosition: (lineId: string, position: [number, number], info?: RoadObjectInfo) => void;
    setHighlightedVehicle: (lineId: string | null) => void;
    refreshAllPositions: () => void;
};

export type RoadObjectInfo = {
    plate?: string;
    cargo?: string;
    from?: string;
    to?: string;
    status?: string;
    speedKmh?: number | null;
    routeLengthKm?: number;
    orderId?: string;
    orderFamilyId?: string;
    orderName?: string;
    pathKey?: string;
    directionDeg?: number;
    driverName?: string;
    address?: string;
    stateStr?: string;
    alarmStr?: string;
    alarmSeverity?: 'none' | 'warning' | 'critical';
    online?: boolean;
    directionLabel?: string;
    manualMarker?: boolean;
    colorKey?: string;
    isRouteBranch?: boolean;
};

export type VehicleBarState = {
    lineId: string;
    orderId: string;
    bar: THREE.Mesh;
    baseScale: THREE.Vector3;
    progress: number;
    currentCoords: [number, number];
    info: RoadObjectInfo;
    upgradeProgress: number;
    upgradeAnimationFrame?: number;
    truckVisual?: THREE.Group;
    alertRipple?: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
    alertSeverity?: 'none' | 'warning' | 'critical';
};

export type OrderLaneState = {
    orderId: string;
    color: number;
    progressTube: THREE.Mesh;
    endpointLayer: THREE.Group;
    vehicles: Map<string, VehicleBarState>;
    maxProgress: number;
    laneIndex: number;
};

export interface RoadState {
    pathKey: string;
    group: THREE.Group;
    pathCurve: THREE.CurvePath<THREE.Vector3>;
    grayTube: THREE.Mesh;
    selectionTube: THREE.Mesh;
    sharedProgressTube: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    samples: THREE.Vector3[];
    cumulativeLengths: number[];
    totalLength: number;
    tubularSegments: number;
    radialSegments: number;
    currentCoords: [number, number];
    labelAnchor: THREE.Vector3;
    info: RoadObjectInfo;
    orders: Map<string, OrderLaneState>;
    lineIds: Set<string>;
    renderedOrderCount: number;
    isSelected: boolean;
}

export type HoverInfo = {
    x: number;
    y: number;
    title: string;
    subtitle: string;
    status: string;
    rows: Array<[string, string]>;
};
