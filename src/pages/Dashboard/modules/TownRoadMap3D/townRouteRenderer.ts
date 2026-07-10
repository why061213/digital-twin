import * as THREE from 'three';
import type { LonLat, TownTransportTask } from './types';

// ============ 从 RoadMap/useRoadControls.ts 直接搬过来的核心逻辑 ============

/** 统一颜色池（与 RoadMap 一致） */
export const UNIFIED_COLORS = [
    0x00ff88, 0x00ccff, 0xffaa00, 0xff44aa, 0xaaff00,
    0x00ffff, 0xff8800, 0x44aaff, 0xff0000, 0xffff00,
    0xff00ff, 0x00ff00,
];

export function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

export function orderColor(orderId: string, index: number) {
    let hash = 0;
    for (const c of orderId) hash += c.charCodeAt(0);
    return UNIFIED_COLORS[(hash + index) % UNIFIED_COLORS.length];
}

function indexCount(geometry: THREE.BufferGeometry) {
    return geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
}

/** 画进度管（完全复用 RoadMap） */
export function drawTubeProgress(
    tube: THREE.Mesh, progress: number, tubularSegments: number, radialSegments: number
) {
    const p = clamp01(progress);
    const totalIdx = indexCount(tube.geometry);
    if (p <= 0 || tubularSegments <= 0 || totalIdx <= 0) {
        tube.geometry.setDrawRange(0, 0);
        return;
    }
    const done = Math.max(1, Math.ceil(p * tubularSegments));
    tube.geometry.setDrawRange(0, Math.min(totalIdx, done * radialSegments * 6));
}

// ============ TownRoad 适配类型 ============

export type TownVehicleBar = {
    lineId: string;
    orderId: string;
    bar: THREE.Mesh;
    progress: number;
    info: TownTransportTask;
    baseScale: THREE.Vector3;
};

export type TownOrderLane = {
    orderId: string;
    color: number;
    progressTube: THREE.Mesh;
    vehicles: TownVehicleBar[];
    maxProgress: number;
    laneIndex: number;
};

export type TownRouteState = {
    pathKey: string;
    group: THREE.Group;
    curve: THREE.QuadraticBezierCurve3;
    grayTube: THREE.Mesh;
    orders: Map<string, TownOrderLane>;
    samples: THREE.Vector3[];
    totalLength: number;
    tubularSegments: number;
    radialSegments: number;
};

// ============ 路线构建 ============

export function routeKey(from: LonLat | undefined, to: LonLat | undefined) {
    if (!from || !to) return null;
    return `${from[0].toFixed(4)},${from[1].toFixed(4)}>${to[0].toFixed(4)},${to[1].toFixed(4)}`;
}

export function buildRouteState(
    curve: THREE.QuadraticBezierCurve3,
    grayTube: THREE.Mesh,
    group: THREE.Group,
    key: string,
    tubularSegments: number,
    radialSegments: number,
): TownRouteState {
    const samples = curve.getSpacedPoints(tubularSegments);
    const totalLength = curve.getLength();
    return { pathKey: key, group, curve, grayTube, orders: new Map(), samples, totalLength, tubularSegments, radialSegments };
}

// ============ 车道 & 车辆（复用 RoadMap 逻辑） ============

/**
 * 创建订单车道 —— 完全复用 RoadMap ensureOrderLane 逻辑
 */
export function ensureOrderLane(
    route: TownRouteState,
    orderId: string,
    laneIndex: number,
    curve: THREE.QuadraticBezierCurve3,
    laneOffset: number,
    laneRadius: number,
): TownOrderLane {
    const color = orderColor(orderId, laneIndex);

    // 车道偏移曲线
    const liftedCurve = laneOffset !== 0
        ? new THREE.QuadraticBezierCurve3(
            curve.v0.clone().add(new THREE.Vector3(0, laneOffset * 0.4, 0)),
            curve.v1.clone().add(new THREE.Vector3(0, laneOffset * 0.5, 0)),
            curve.v2.clone().add(new THREE.Vector3(0, laneOffset * 0.4, 0)),
        )
        : curve;

    const progressGeo = new THREE.TubeGeometry(liftedCurve, route.tubularSegments, laneRadius, route.radialSegments, false);
    progressGeo.setDrawRange(0, 0);
    const progressTube = new THREE.Mesh(progressGeo, new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -8,
        polygonOffsetUnits: -8,
    }));
    progressTube.renderOrder = 10 + laneIndex;
    progressTube.userData = { orderId, objectType: '订单进度' };
    route.group.add(progressTube);

    return { orderId, color, progressTube, vehicles: [], maxProgress: 0, laneIndex };
}

/**
 * 创建车辆进度条 —— 完全复用 RoadMap ensureVehicleBar 逻辑
 */
export function ensureVehicleBar(
    route: TownRouteState,
    lane: TownOrderLane,
    lineId: string,
    info: TownTransportTask,
    isLead: boolean,
    vehicleIndex: number,
): TownVehicleBar {
    const barColor = isLead ? lane.color : UNIFIED_COLORS[(lane.laneIndex + vehicleIndex + 5) % UNIFIED_COLORS.length];
    const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.07, 0.1),
        new THREE.MeshBasicMaterial({
            color: barColor,
            transparent: true,
            opacity: isLead ? 1 : 0.85,
            depthWrite: false,
        }),
    );
    bar.renderOrder = isLead ? 36 : 18 + (vehicleIndex % 8);
    bar.userData = { lineId, orderId: lane.orderId, objectType: '车辆进度条' };
    route.group.add(bar);

    const baseScale = isLead
        ? new THREE.Vector3(1.08, 1.22, 1.08)
        : new THREE.Vector3(0.65, 0.80, 0.65);

    return { lineId, orderId: lane.orderId, bar, progress: 0, info, baseScale };
}

/**
 * 设置车辆在车道上的位置 —— 复用 RoadMap setVehicleBarTransform 逻辑
 */
export function setVehicleBarTransform(
    curve: THREE.QuadraticBezierCurve3,
    lane: TownOrderLane,
    vehicle: TownVehicleBar,
    laneCount: number,
    barLift: number,
) {
    const pt = curve.getPoint(vehicle.progress);
    const n = laneCount > 1 ? (lane.laneIndex - (laneCount - 1) / 2) * 0.15 : 0;
    const pos = pt.clone().add(new THREE.Vector3(0, barLift + lane.laneIndex * 0.004, n));
    vehicle.bar.position.copy(pos);
    vehicle.bar.scale.copy(vehicle.baseScale);
}

/**
 * 更新整条路线上所有车道和车辆的视觉 —— 复用 RoadMap updateOrderVisuals 逻辑
 */
export function updateRouteVisuals(route: TownRouteState) {
    const lanes = Array.from(route.orders.values());
    lanes.forEach((lane) => {
        const maxP = Math.max(0, ...lane.vehicles.map(v => v.progress));
        lane.maxProgress = maxP;
        lane.progressTube.position.y = 0.04 + lane.laneIndex * 0.055;
        drawTubeProgress(lane.progressTube, maxP, route.tubularSegments, route.radialSegments);
    });
}
