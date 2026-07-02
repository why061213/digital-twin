import * as THREE from 'three';
import { DragControls } from 'three/examples/jsm/controls/DragControls.js';

export type RoadMap3DHandle = {
    setRoadPath: (coords: [number, number][]) => void;
    addRoadPath: (id: string, coords: [number, number][], info?: RoadObjectInfo) => void;
    removeRoadPath: (id: string) => void;
    clearRoads: () => void;
    updateTruckPosition: (lineId: string, position: [number, number], info?: RoadObjectInfo) => void;
};

export type RoadObjectInfo = {
    plate?: string;
    cargo?: string;
    from?: string;
    to?: string;
    status?: string;
    speedKmh?: number | null;
    routeLengthKm?: number;
};

export interface RoadState {
    group: THREE.Group;
    grayTube: THREE.Mesh;
    selectionTube: THREE.Mesh;
    greenTube: THREE.Mesh;
    truck: THREE.Mesh;
    truckGlow: THREE.Mesh;
    selectionRing: THREE.Mesh;
    dragControls: DragControls;
    samples: THREE.Vector3[];
    cumulativeLengths: number[];
    totalLength: number;
    tubularSegments: number;
    radialSegments: number;
    progressRef: { current: number };
    currentCoords: [number, number];
    labelAnchor: THREE.Vector3;
    info: RoadObjectInfo;
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