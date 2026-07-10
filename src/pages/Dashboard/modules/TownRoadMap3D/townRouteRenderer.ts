import * as THREE from 'three';

// ============ 从 RoadMap/useRoadControls.ts 原封不动复制 ============

export const UNIFIED_COLORS = [
    0x00ff88, 0x00ccff, 0xffaa00, 0xff44aa, 0xaaff00,
    0x00ffff, 0xff8800, 0x44aaff, 0xff0000, 0xffff00,
    0xff00ff, 0x00ff00,
];

export function clamp01(value: number) { return Math.min(Math.max(value, 0), 1); }

export function orderColor(orderId: string, index: number) {
    let hash = 0;
    for (const char of orderId) hash += char.charCodeAt(0);
    return UNIFIED_COLORS[(hash + index) % UNIFIED_COLORS.length];
}

function indexCount(geometry: THREE.BufferGeometry) {
    return geometry.index?.count ?? geometry.attributes.position.count;
}

export function drawTubeProgress(tube: THREE.Mesh, progress: number, tubularSegments: number, radialSegments: number) {
    const p = clamp01(progress);
    const totalIndexCount = indexCount(tube.geometry);
    if (p <= 0 || tubularSegments <= 0 || totalIndexCount <= 0) { tube.geometry.setDrawRange(0, 0); return; }
    const completedSegments = Math.max(1, Math.ceil(p * tubularSegments));
    tube.geometry.setDrawRange(0, Math.min(totalIndexCount, completedSegments * radialSegments * 6));
}

export function disposeObject3D(object: THREE.Object3D) {
    object.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
            child.geometry.dispose();
            const material = child.material;
            if (Array.isArray(material)) { material.forEach((m) => m.dispose()); }
            else { material.dispose(); }
        }
    });
}

// ============ TownRoad 适配：RoadMap 类型映射 ============

export type TownVehicleBar = {
    lineId: string;
    orderId: string;
    bar: THREE.Mesh;
    baseScale: THREE.Vector3;
    progress: number;
    currentCoords: [number, number];
    info: Record<string, unknown>;
};

export type TownOrderLane = {
    orderId: string;
    color: number;
    progressTube: THREE.Mesh;
    vehicles: Map<string, TownVehicleBar>;
    maxProgress: number;
    laneIndex: number;
};

export type TownRoadState = {
    pathKey: string;
    group: THREE.Group;
    pathCurve: THREE.CurvePath<THREE.Vector3>;
    grayTube: THREE.Mesh;
    selectionTube: THREE.Mesh;
    samples: THREE.Vector3[];
    cumulativeLengths: number[];
    totalLength: number;
    tubularSegments: number;
    radialSegments: number;
    currentCoords: [number, number];
    info: Record<string, unknown>;
    orders: Map<string, TownOrderLane>;
    lineIds: Set<string>;
    renderedOrderCount: number;
    isSelected: boolean;
};

// ============ 复制 RoadMap 核心逻辑 ============

function trackKeyFor(from: [number, number], to: [number, number]) {
    return `${from[0].toFixed(4)},${from[1].toFixed(4)}>${to[0].toFixed(4)},${to[1].toFixed(4)}`;
}

function orderKeyFor(task: { orderId?: string | null; lineId: string }) {
    return task.orderId ?? `order-${task.lineId}`;
}

function makeLinearCurve(points: THREE.Vector3[]) {
    const path = new THREE.CurvePath<THREE.Vector3>();
    path.add(new THREE.LineCurve3(points[0], points[points.length - 1]));
    return path;
}

export function progressOnRoad(road: TownRoadState, worldPos: THREE.Vector3) {
    if (road.samples.length < 2 || road.cumulativeLengths.length !== road.samples.length || road.totalLength <= 0) return 0;
    let nearestDistanceSq = Number.POSITIVE_INFINITY;
    let distanceAlongPath = 0;
    for (let i = 0; i < road.samples.length - 1; i++) {
        const start = road.samples[i], end = road.samples[i + 1];
        const abX = end.x - start.x, abZ = end.z - start.z;
        const segmentLengthSq = abX * abX + abZ * abZ;
        if (segmentLengthSq <= 0.000001) continue;
        const apX = worldPos.x - start.x, apZ = worldPos.z - start.z;
        const segmentProgress = clamp01((apX * abX + apZ * abZ) / segmentLengthSq);
        const dx = worldPos.x - (start.x + abX * segmentProgress);
        const dz = worldPos.z - (start.z + abZ * segmentProgress);
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq < nearestDistanceSq) {
            nearestDistanceSq = distanceSq;
            distanceAlongPath = road.cumulativeLengths[i] + Math.sqrt(segmentLengthSq) * segmentProgress;
        }
    }
    return clamp01(distanceAlongPath / road.totalLength);
}

function pointAndTangentAtProgress(road: TownRoadState, progress: number) {
    const index = Math.min(road.samples.length - 1, Math.max(0, Math.round(progress * (road.samples.length - 1))));
    const point = road.samples[index]?.clone() ?? new THREE.Vector3();
    const prev = road.samples[Math.max(0, index - 1)] ?? point;
    const next = road.samples[Math.min(road.samples.length - 1, index + 1)] ?? point;
    const tangent = next.clone().sub(prev);
    if (tangent.lengthSq() < 0.000001) tangent.set(1, 0, 0);
    tangent.normalize();
    return { point, tangent };
}

export function setVehicleBarTransform(
    road: TownRoadState, lane: TownOrderLane, vehicle: TownVehicleBar, truckLift: number,
) {
    const { point, tangent } = pointAndTangentAtProgress(road, vehicle.progress);
    const laneCount = Math.max(1, road.orders.size);
    const laneOffset = (lane.laneIndex - (laneCount - 1) / 2) * 0.2;
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const position = point.add(normal.clone().multiplyScalar(laneOffset)).setY(truckLift + 0.05 + lane.laneIndex * 0.0035);
    vehicle.bar.position.copy(position);
    vehicle.bar.rotation.y = -Math.atan2(normal.z, normal.x);
}

export function ensureOrderLane(road: TownRoadState, orderId: string) {
    let lane = road.orders.get(orderId);
    if (lane) return lane;
    const laneIndex = road.orders.size;
    const color = orderColor(orderId, laneIndex);
    const progressGeo = new THREE.TubeGeometry(road.pathCurve, road.tubularSegments, 0.072, road.radialSegments, false);
    progressGeo.setDrawRange(0, 0);
    const progressTube = new THREE.Mesh(progressGeo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
    }));
    progressTube.renderOrder = 9 + laneIndex;
    progressTube.userData = { roadId: road.pathKey, objectType: '订单进度' };
    road.group.add(progressTube);
    lane = { orderId, color, progressTube, vehicles: new Map(), maxProgress: 0, laneIndex };
    road.orders.set(orderId, lane);
    return lane;
}

export function ensureVehicleBar(road: TownRoadState, lane: TownOrderLane, lineId: string, info: Record<string, unknown>) {
    let vehicle = lane.vehicles.get(lineId);
    if (vehicle) { vehicle.info = { ...vehicle.info, ...info }; return vehicle; }
    const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.07, 0.1),
        new THREE.MeshBasicMaterial({ color: lane.color, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    bar.renderOrder = 22;
    bar.userData = { roadId: road.pathKey, lineId, objectType: '车辆进度条' };
    road.group.add(bar);
    vehicle = { lineId, orderId: lane.orderId, bar, baseScale: new THREE.Vector3(1, 1, 1), progress: 0, currentCoords: road.currentCoords, info };
    lane.vehicles.set(lineId, vehicle);
    road.lineIds.add(lineId);
    return vehicle;
}

export function updateOrderVisuals(road: TownRoadState, truckLift: number) {
    const orderCount = Math.max(1, road.orders.size);
    if (road.renderedOrderCount !== orderCount) {
        const routeWidthFactor = Math.min(2.8, 0.7 + 0.3 * orderCount);
        const baseRadius = 0.105 * routeWidthFactor;
        road.grayTube.geometry.dispose();
        road.grayTube.geometry = new THREE.TubeGeometry(road.pathCurve, road.tubularSegments, baseRadius, road.radialSegments, false);
        road.selectionTube.geometry.dispose();
        road.selectionTube.geometry = new THREE.TubeGeometry(road.pathCurve, road.tubularSegments, baseRadius + 0.075, road.radialSegments, false);
        road.renderedOrderCount = orderCount;
    }
    Array.from(road.orders.values()).forEach((lane, laneIndex) => {
        lane.laneIndex = laneIndex;
        const vehicles = Array.from(lane.vehicles.values());
        lane.maxProgress = Math.max(0, ...vehicles.map(v => v.progress));
        const leadVehicle = vehicles.reduce<TownVehicleBar | null>((lead, v) => (!lead || v.progress > lead.progress) ? v : lead, null);
        lane.progressTube.position.y = 0.04 + laneIndex * 0.055;
        drawTubeProgress(lane.progressTube, lane.maxProgress, road.tubularSegments, road.radialSegments);
        vehicles.forEach((vehicle, vehicleIndex) => {
            const material = vehicle.bar.material as THREE.MeshBasicMaterial;
            const isLead = vehicle === leadVehicle;
            if (isLead) { material.color.setHex(lane.color); }
            else {
                let ci = (laneIndex + vehicleIndex) % UNIFIED_COLORS.length;
                if (UNIFIED_COLORS[ci] === lane.color) ci = (ci + 1) % UNIFIED_COLORS.length;
                material.color.setHex(UNIFIED_COLORS[ci]);
            }
            material.opacity = isLead ? 1.0 : 0.85;
            const baseScale = isLead ? { x: 1.08, y: 1.22, z: 1.08 } : { x: 0.65, y: 0.80, z: 0.65 };
            vehicle.baseScale.set(baseScale.x, baseScale.y, baseScale.z);
            vehicle.bar.scale.copy(vehicle.baseScale);
            vehicle.bar.renderOrder = isLead ? 36 : 18 + (vehicleIndex % 8);
            setVehicleBarTransform(road, lane, vehicle, truckLift);
        });
    });
}

// ============ TownRoad 专用：从 tasks 构建路线 ============

export function buildRouteFromTasks(
    tasks: Array<{ lineId: string; orderId?: string | null; from: { coords?: [number, number] }; to: { coords?: [number, number] }; [k: string]: unknown }>,
    mapPosition: (coords: [number, number], lift: number) => THREE.Vector3 | null,
    scene: THREE.Scene,
    roadLift: number,
    truckLift: number,
) {
    const routeMap = new Map<string, typeof tasks>();
    tasks.forEach(t => {
        if (!t.from.coords || !t.to.coords) return;
        const k = trackKeyFor(t.from.coords, t.to.coords);
        if (!routeMap.has(k)) routeMap.set(k, []);
        routeMap.get(k)!.push(t);
    });

    const roads: TownRoadState[] = [];
    const PATH_SAMPLE_COUNT = 160;

    routeMap.forEach((routeTasks, pathKey) => {
        const ref = routeTasks[0];
        const start = mapPosition(ref.from.coords!, roadLift);
        const end = mapPosition(ref.to.coords!, roadLift);
        if (!start || !end) return;

        // 直线！不要曲线
        const pathCurve = makeLinearCurve([start, end]);
        const tubularSegments = PATH_SAMPLE_COUNT;
        const radialSegments = 6;
        const samples = pathCurve.getSpacedPoints(tubularSegments);
        const cumulativeLengths: number[] = [0];
        for (let i = 1; i < samples.length; i++) cumulativeLengths[i] = cumulativeLengths[i - 1] + samples[i - 1].distanceTo(samples[i]);

        const grayTube = new THREE.Mesh(
            new THREE.TubeGeometry(pathCurve, tubularSegments, 0.08, radialSegments, false),
            new THREE.MeshBasicMaterial({ color: 0x6b7280, transparent: true, opacity: 0.45, depthWrite: false }),
        );
        grayTube.renderOrder = 2;
        grayTube.userData = { roadId: pathKey, objectType: '共享路线' };

        const selectionTube = new THREE.Mesh(
            new THREE.TubeGeometry(pathCurve, tubularSegments, 0.17, radialSegments, false),
            new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0, depthWrite: false }),
        );
        selectionTube.renderOrder = 12;

        const group = new THREE.Group();
        group.add(grayTube, selectionTube);
        scene.add(group);

        const road: TownRoadState = {
            pathKey, group, pathCurve, grayTube, selectionTube,
            samples, cumulativeLengths,
            totalLength: cumulativeLengths[cumulativeLengths.length - 1] ?? 0,
            tubularSegments, radialSegments,
            currentCoords: ref.from.coords!,
            info: {}, orders: new Map(), lineIds: new Set(),
            renderedOrderCount: 0, isSelected: false,
        };
        roads.push(road);

        // 按订单分组创建车道和车辆
        const orderMap = new Map<string, typeof tasks>();
        routeTasks.forEach(t => { const o = orderKeyFor(t as { orderId?: string | null; lineId: string }); if (!orderMap.has(o)) orderMap.set(o, []); orderMap.get(o)!.push(t); });
        orderMap.forEach((orderTasks, orderId) => {
            const lane = ensureOrderLane(road, orderId);
            orderTasks.forEach(task => {
                const vehicle = ensureVehicleBar(road, lane, task.lineId, task);
                // 模拟进度
                const status = (task as Record<string, unknown>).status as string ?? '';
                vehicle.progress = status.includes('完成') ? 1 : status.includes('装载') ? 0.05 : clamp01(0.15 + Math.random() * 0.7);
                vehicle.currentCoords = task.from.coords!;
            });
        });
        updateOrderVisuals(road, truckLift);
    });

    return roads;
}
