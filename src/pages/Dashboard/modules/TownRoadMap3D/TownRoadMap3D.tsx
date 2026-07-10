import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createLocalProjection, collectRenderProvinceAdcodes, collectTaskCoords, commandOrders, commandRenderProvinces, featureCoords, isLonLat, loadGeoJsonByRenderCommand } from './geo';
import { MAP_LIFT, MARKER_LIFT, ROUTE_LIFT, TOWN_ROUTE_CURVE_HEIGHT } from './constants';

const BAR_LIFT = ROUTE_LIFT + 0.3;
import type { LonLat, TownAnimationStage, TownBoundaryLayers, TownRoadMap3DHandle, TownRoadRenderCommand, TownTransportTask } from './types';

type TownRoadMap3DProps = {
    onVisualReady?: () => void;
};

type TownHoverInfo = {
    x: number;
    y: number;
    title: string;
    subtitle: string;
    rows: Array<[string, string]>;
};

type BoundaryLevel = 'province' | 'city' | 'district';

type BoundaryStyle = {
    color: number;
    opacity: number;
    lift: number;
    lineWidth: number;
    renderOrder: number;
};

// ---- 路线车道/车辆进度条（从 RoadMap 迁移） ----

const ORDER_LANE_COLORS = [
    0x00ff88, 0x00ccff, 0xffaa00, 0xff44aa, 0xaaff00,
    0x00ffff, 0xff8800, 0x44aaff, 0xff0000, 0xffff00,
    0xff00ff, 0x00ff00,
];

type TownVehicleBar = {
    lineId: string;
    orderId: string;
    bar: THREE.Mesh;
    progress: number;
    info: TownTransportTask;
};

type TownOrderLane = {
    orderId: string;
    color: number;
    progressTube: THREE.Mesh;
    vehicles: TownVehicleBar[];
    maxProgress: number;
    laneIndex: number;
};

type TownRouteState = {
    pathKey: string;
    routeGroup: THREE.Group;
    pathCurve: THREE.QuadraticBezierCurve3;
    grayTube: THREE.Mesh;
    orders: Map<string, TownOrderLane>;
    samples: THREE.Vector3[];
    totalLength: number;
};

function routeKey(from: LonLat | undefined, to: LonLat | undefined) {
    if (!from || !to) return null;
    return `${from[0].toFixed(4)},${from[1].toFixed(4)}>${to[0].toFixed(4)},${to[1].toFixed(4)}`;
}

function orderColor(orderId: string, index: number) {
    let hash = 0;
    for (const c of orderId) hash += c.charCodeAt(0);
    return ORDER_LANE_COLORS[(hash + index) % ORDER_LANE_COLORS.length];
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

function drawTubeProgress(tube: THREE.Mesh, progress: number, segments: number, radialSegs: number) {
    const idxCount = tube.geometry.index?.count ?? 0;
    if (progress <= 0 || segments <= 0 || idxCount <= 0) { tube.geometry.setDrawRange(0, 0); return; }
    const doneSeg = Math.max(1, Math.ceil(progress * segments));
    tube.geometry.setDrawRange(0, Math.min(idxCount, doneSeg * radialSegs * 6));
}

const BOUNDARY_STYLES: Record<BoundaryLevel, BoundaryStyle> = {
    // 省界：最高、最亮，用暖色，负责告诉用户“这是一整个省的外边界”。
    province: { color: 0xfbbf24, opacity: 0.88, lift: MAP_LIFT + 0.88, lineWidth: 3, renderOrder: 30 },
    // 市界：次高、偏 cyan，负责在省内分出地市层级。
    city: { color: 0x22d3ee, opacity: 0.54, lift: MAP_LIFT + 0.76, lineWidth: 2, renderOrder: 24 },
    // 县界：最细、最暗，主要由每个区县块自己的 EdgesGeometry 表达。
    district: { color: 0x93c5fd, opacity: 0.48, lift: MAP_LIFT + 0.58, lineWidth: 1, renderOrder: 12 },
};

function commandMapKey(command: TownRoadRenderCommand) {
    const renderLevel = command.renderLevel ?? 'province-district';
    const provinces = commandRenderProvinces(command).slice().sort().join('|');
    return `${renderLevel}:${provinces}`;
}

function extractFeatureRings(feature: any): LonLat[][] {
    const geometry = feature?.geometry;
    if (!geometry) return [];

    if (geometry.type === 'Polygon') {
        return (geometry.coordinates ?? []).filter((ring: LonLat[]) => Array.isArray(ring) && ring.length >= 2);
    }

    if (geometry.type === 'MultiPolygon') {
        const rings: LonLat[][] = [];
        geometry.coordinates?.forEach((polygon: LonLat[][]) => {
            polygon?.forEach((ring) => {
                if (Array.isArray(ring) && ring.length >= 2) rings.push(ring);
            });
        });
        return rings;
    }

    return [];
}

function createBoundaryOverlay(
    features: any[] | undefined,
    projection: ReturnType<typeof createLocalProjection>,
    level: BoundaryLevel
) {
    const group = new THREE.Group();
    const style = BOUNDARY_STYLES[level];
    const source = features ?? [];

    source.forEach((feature) => {
        const rings = extractFeatureRings(feature);
        rings.forEach((ring) => {
            const points: THREE.Vector3[] = [];
            ring.forEach((coord) => {
                const projected = projection(coord);
                if (!projected) return;
                points.push(new THREE.Vector3(-projected[0], style.lift, -projected[1]));
            });

            if (points.length < 2) return;
            const first = points[0];
            const last = points[points.length - 1];
            if (first.distanceToSquared(last) > 0.000001) {
                points.push(first.clone());
            }

            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({
                color: style.color,
                transparent: true,
                opacity: style.opacity,
                depthTest: false,
                depthWrite: false,
            });
            const line = new THREE.Line(geometry, material);
            line.renderOrder = style.renderOrder;
            line.userData = { objectType: level === 'province' ? '省界' : level === 'city' ? '市界' : '县界' };
            group.add(line);
        });
    });

    return group;
}

function disposeObject3D(object: THREE.Object3D) {
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

function statusTone(status: string) {
    if (status.includes('完成')) return 0x34d399;
    if (status.includes('装载')) return 0xfbbf24;
    if (status.includes('取消')) return 0x94a3b8;
    return 0x22d3ee;
}

function hashText(text: string) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash;
}

function screenPosition(point: THREE.Vector3, camera: THREE.Camera, container: HTMLDivElement) {
    const projected = point.clone().project(camera);
    return {
        x: (projected.x * 0.5 + 0.5) * container.clientWidth,
        y: (-projected.y * 0.5 + 0.5) * container.clientHeight,
    };
}

const TownRoadMap3D = forwardRef<TownRoadMap3DHandle, TownRoadMap3DProps>(({ onVisualReady }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const onVisualReadyRef = useRef(onVisualReady);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const mapGroupRef = useRef<THREE.Group | null>(null);
    const routesGroupRef = useRef<THREE.Group | null>(null);
    const projectionRef = useRef<ReturnType<typeof createLocalProjection> | null>(null);
    const renderedMapKeyRef = useRef<string | null>(null);
    const renderedMapPointsRef = useRef<THREE.Vector3[]>([]);
    const renderFrameRef = useRef(0);
    const renderRunRef = useRef(0);
    const inFlightMapKeyRef = useRef<string | null>(null);
    const pendingCommandForMapKeyRef = useRef<TownRoadRenderCommand | null>(null);
    const pendingCommandBeforeSceneRef = useRef<TownRoadRenderCommand | null>(null);
    const renderCommandRef = useRef<((command: TownRoadRenderCommand) => void) | null>(null);
    const raycasterRef = useRef(new THREE.Raycaster());
    const pointerRef = useRef(new THREE.Vector2());
    const interactiveObjectsRef = useRef<THREE.Object3D[]>([]);
    const [hoverInfo, setHoverInfo] = useState<TownHoverInfo | null>(null);

    onVisualReadyRef.current = onVisualReady;

    const clearMapData = useCallback(() => {
        const scene = sceneRef.current;
        if (mapGroupRef.current) {
            scene?.remove(mapGroupRef.current);
            disposeObject3D(mapGroupRef.current);
            mapGroupRef.current = null;
        }
        renderedMapKeyRef.current = null;
        renderedMapPointsRef.current = [];
        projectionRef.current = null;
    }, []);

    const clearRouteData = useCallback(() => {
        const scene = sceneRef.current;
        if (routesGroupRef.current) {
            scene?.remove(routesGroupRef.current);
            disposeObject3D(routesGroupRef.current);
            routesGroupRef.current = null;
        }
        interactiveObjectsRef.current = [];
        setHoverInfo(null);
    }, []);

    const clearRenderedData = useCallback(() => {
        clearRouteData();
        clearMapData();
    }, [clearMapData, clearRouteData]);

    const focusPoints = useCallback((points: THREE.Vector3[]) => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        const container = containerRef.current;
        if (!camera || !controls || points.length === 0) return;

        const box = new THREE.Box3().setFromPoints(points);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.z, 3);

        // 短途配送：更贴近地面
        let height = THREE.MathUtils.clamp(span * 0.65 + 10, 8, 64);
        let tilt = THREE.MathUtils.clamp(span * 0.28 + 5, 5, 30);

        // 指标2：路线在屏幕上至少 50px。
        // 视口高度 ≈ 2 * height * tan(fov/2)，50px 占比 = 50 / screenH
        const screenH = container?.clientHeight ?? 1080;
        const fovRad = THREE.MathUtils.degToRad(camera.fov);
        const viewportHeight = 2 * height * Math.tan(fovRad / 2);
        const minWorldSpan = viewportHeight * (50 / screenH);
        if (span < minWorldSpan) {
            // 路线太短，缩近相机让路线至少占 50px
            height = (span * screenH) / (50 * 2 * Math.tan(fovRad / 2));
            height = THREE.MathUtils.clamp(height, 5, 64);
            tilt = Math.max(4, height * 0.25);
        }

        camera.position.set(center.x, height, center.z - tilt);
        controls.target.set(center.x, 0, center.z);
        camera.lookAt(controls.target);
        controls.update();
    }, []);

    const mapPositionFactory = useCallback((projection: ReturnType<typeof createLocalProjection>) => {
        return (coords: LonLat, lift = 0) => {
            const projected = projection(coords);
            if (!projected) return null;
            return new THREE.Vector3(-projected[0], lift, -projected[1]);
        };
    }, []);

    const renderMapFeatures = useCallback((
        features: any[],
        projection: ReturnType<typeof createLocalProjection>,
        boundaryFeatures?: TownBoundaryLayers
    ) => {
        const group = new THREE.Group();
        const allPoints: THREE.Vector3[] = [];

        // 区县级区块：轻量平面填充 + 淡色细线边界
        features.forEach((feature) => {
            const geometry = feature.geometry;
            if (!geometry) return;

            const cityGroup = new THREE.Group();
            const rings: LonLat[][] = [];
            if (geometry.type === 'Polygon') {
                rings.push(...(geometry.coordinates ?? []));
            } else if (geometry.type === 'MultiPolygon') {
                geometry.coordinates?.forEach((polygon: LonLat[][]) => rings.push(...polygon));
            }

            rings.forEach((ring) => {
                if (!Array.isArray(ring) || ring.length < 3) return;
                const shape = new THREE.Shape();
                ring.forEach((coord, index) => {
                    const projected = projection(coord);
                    if (!projected) return;
                    const x = -projected[0];
                    const y = -projected[1];
                    if (index === 0) shape.moveTo(x, y);
                    else shape.lineTo(x, y);
                    allPoints.push(new THREE.Vector3(x, MAP_LIFT, y));
                });

                // 轻量平面实体填充（城市级块）
                const geom = new THREE.ShapeGeometry(shape);
                const mesh = new THREE.Mesh(
                    geom,
                    new THREE.MeshBasicMaterial({
                        color: 0x1e3d5c,
                        transparent: true,
                        opacity: 0.88,
                        side: THREE.DoubleSide,
                        depthWrite: false,
                    })
                );
                mesh.renderOrder = 8;
                cityGroup.add(mesh);


            });

            cityGroup.rotation.x = Math.PI / 2;
            group.add(cityGroup);
        });

        // 行政边界分级覆盖层：省界 + 市界 + 区县界浮在上面
        const overlayGroup = new THREE.Group();
        overlayGroup.add(createBoundaryOverlay(boundaryFeatures?.district, projection, 'district'));
        overlayGroup.add(createBoundaryOverlay(boundaryFeatures?.city, projection, 'city'));
        overlayGroup.add(createBoundaryOverlay(boundaryFeatures?.province, projection, 'province'));
        group.add(overlayGroup);

        return { group, points: allPoints };
    }, []);

    const renderRoutes = useCallback((tasks: TownTransportTask[], projection: ReturnType<typeof createLocalProjection>) => {
        const mapPosition = mapPositionFactory(projection);
        const group = new THREE.Group();
        const allPoints: THREE.Vector3[] = [];
        const endpointMarkers = new Map<string, THREE.Mesh>();
        const interactiveObjects: THREE.Object3D[] = [];
        const activeTasks = tasks.filter(t => !t.deleted);

        // ---- 1. 按物理路线分组（相同 from→to 坐标） ----
        const routeMap = new Map<string, { tasks: TownTransportTask[]; from: LonLat; to: LonLat }>();
        activeTasks.forEach(task => {
            const key = routeKey(task.from.coords, task.to.coords);
            if (!key) return;
            let entry = routeMap.get(key);
            if (!entry) {
                entry = { tasks: [], from: task.from.coords!, to: task.to.coords! };
                routeMap.set(key, entry);
            }
            entry.tasks.push(task);
        });

        const TUBE_SEGMENTS = 128;
        const RADIAL_SEGS = 8;
        const GRAY_TUBE_RADIUS = 0.065;
        const LANE_TUBE_RADIUS = 0.05;
        const BAR_WIDTH = 0.26;
        const BAR_HEIGHT = 0.06;
        const BAR_DEPTH = 0.09;

        routeMap.forEach(({ tasks: routeTasks, from, to }, routeId) => {
            const start = mapPosition(from, ROUTE_LIFT);
            const end = mapPosition(to, ROUTE_LIFT);
            if (!start || !end) return;

            // 曲线
            const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
            const dist = start.distanceTo(end);
            mid.y += TOWN_ROUTE_CURVE_HEIGHT + Math.min(dist * 0.08, 3.5);
            const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
            const samples = curve.getSpacedPoints(TUBE_SEGMENTS);
            const totalLength = curve.getLength();

            // 灰底管
            const grayTube = new THREE.Mesh(
                new THREE.TubeGeometry(curve, TUBE_SEGMENTS, GRAY_TUBE_RADIUS, RADIAL_SEGS, false),
                new THREE.MeshBasicMaterial({ color: 0x5a6a80, transparent: true, opacity: 0.4, depthWrite: false })
            );
            grayTube.renderOrder = 2;
            grayTube.userData = { routeId, objectType: '短途路线' };
            group.add(grayTube);

            const routeState: TownRouteState = {
                pathKey: routeId,
                routeGroup: group,
                pathCurve: curve,
                grayTube,
                orders: new Map(),
                samples,
                totalLength,
            };

            // ---- 2. 按订单分组（orderId → lane） ----
            const orderMap = new Map<string, TownTransportTask[]>();
            routeTasks.forEach(task => {
                const oid = task.orderId ?? task.lineId;
                if (!orderMap.has(oid)) orderMap.set(oid, []);
                orderMap.get(oid)!.push(task);
            });

            let laneIdx = 0;
            orderMap.forEach((orderTasks, orderId) => {
                const color = orderColor(orderId, laneIdx);
                const laneCount = orderMap.size;

                // 进度管（车道偏移）
                const laneOffset = (laneIdx - (laneCount - 1) / 2) * 0.12;
                const progressTubeCurve = new THREE.QuadraticBezierCurve3(
                    start.clone().add(new THREE.Vector3(0, laneOffset * 0.3, 0)),
                    mid.clone().add(new THREE.Vector3(0, laneOffset * 0.5, 0)),
                    end.clone().add(new THREE.Vector3(0, laneOffset * 0.3, 0))
                );
                const progressTube = new THREE.Mesh(
                    new THREE.TubeGeometry(progressTubeCurve, TUBE_SEGMENTS, LANE_TUBE_RADIUS, RADIAL_SEGS, false),
                    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false })
                );
                progressTube.renderOrder = 10 + laneIdx;
                progressTube.geometry.setDrawRange(0, 0);
                progressTube.userData = { routeId, orderId, objectType: '订单进度' };
                group.add(progressTube);

                const vehicles: TownVehicleBar[] = [];
                let maxProgress = 0;

                orderTasks.forEach((task, vi) => {
                    // 进度：模拟沿路径的运输进度
                    const progress = task.status.includes('完成') ? 1
                        : task.status.includes('装载') ? 0.05
                        : clamp01(0.15 + vi * 0.12 + (hashText(task.lineId) % 20) * 0.03);
                    if (progress > maxProgress) maxProgress = progress;

                    const isLead = vi === 0 && orderTasks.length > 1;
                    const barColor = isLead ? color : ORDER_LANE_COLORS[(laneIdx + vi + 5) % ORDER_LANE_COLORS.length];
                    const barScale = isLead ? { x: 1.1, y: 1.3, z: 1.1 } : { x: 0.65, y: 0.8, z: 0.65 };

                    const bar = new THREE.Mesh(
                        new THREE.BoxGeometry(BAR_WIDTH, BAR_HEIGHT, BAR_DEPTH),
                        new THREE.MeshBasicMaterial({ color: barColor, transparent: true, opacity: isLead ? 1 : 0.8, depthWrite: false })
                    );
                    bar.renderOrder = isLead ? 36 : 18 + (vi % 8);

                    // 定位车辆到曲线上的 progress 位置
                    const pt = curve.getPoint(progress);
                    const laneNormal = (laneCount > 1) ? laneOffset * 0.15 : 0;
                    bar.position.copy(pt).add(new THREE.Vector3(0, BAR_LIFT + laneIdx * 0.004, laneNormal));
                    bar.userData = {
                        objectType: '车辆进度条',
                        title: task.vehicle.plate || task.lineId,
                        subtitle: `${task.from.name} → ${task.to.name}`,
                        rows: [
                            ['任务ID', task.lineId],
                            ['订单ID', task.orderId ?? '--'],
                            ['车辆ID', task.vehicle.carId],
                            ['货重', `${task.vehicle.cargoWeight ?? '--'} ${task.vehicle.cargoUnit ?? ''}`.trim()],
                            ['状态', task.status],
                        ],
                    };
                    group.add(bar);
                    interactiveObjects.push(bar);

                    vehicles.push({ lineId: task.lineId, orderId, bar, progress, info: task });
                    allPoints.push(pt);
                });

                drawTubeProgress(progressTube, maxProgress, TUBE_SEGMENTS, RADIAL_SEGS);

                const lane: TownOrderLane = { orderId, color, progressTube, vehicles, maxProgress, laneIndex: laneIdx };
                routeState.orders.set(orderId, lane);
                laneIdx++;
            });

            // 端点标记
            if (isLonLat(from)) {
                const mk = createEndpointMarker(from, routeTasks[0]?.from.name ?? '起点', 0x38bdf8, 0.88);
                if (mk) allPoints.push(mk.position);
            }
            if (isLonLat(to)) {
                const mk = createEndpointMarker(to, routeTasks[0]?.to.name ?? '终点', 0xf59e0b, 1.08);
                if (mk) allPoints.push(mk.position);
            }
        });

        function createEndpointMarker(coords: LonLat, label: string, color: number, scale = 1) {
            const key = `${coords[0].toFixed(6)},${coords[1].toFixed(6)}:${label}`;
            const cached = endpointMarkers.get(key);
            if (cached) return cached;
            const position = mapPosition(coords, MARKER_LIFT);
            if (!position) return null;
            const marker = new THREE.Mesh(
                new THREE.SphereGeometry(0.34 * scale, 18, 18),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 })
            );
            marker.position.copy(position);
            marker.userData = { title: label, objectType: '站点' };
            endpointMarkers.set(key, marker);
            group.add(marker);
            return marker;
        }

        interactiveObjectsRef.current = interactiveObjects;
        return { group, points: allPoints };
    }, [mapPositionFactory]);

    const renderCommand = useCallback((command: TownRoadRenderCommand) => {
        const scene = sceneRef.current;
        const nextMapKey = commandMapKey(command);

        if (!scene) {
            pendingCommandBeforeSceneRef.current = command;
            console.info('[TownRoadMap3D] defer render command until scene ready', {
                nextMapKey,
                commandId: command.commandId,
            });
            return;
        }

        if (inFlightMapKeyRef.current === nextMapKey) {
            pendingCommandForMapKeyRef.current = command;
            console.info('[TownRoadMap3D] skip duplicate render while map loading', {
                nextMapKey,
                commandId: command.commandId,
            });
            return;
        }

        const runId = renderRunRef.current + 1;
        renderRunRef.current = runId;
        const isStale = () => renderRunRef.current !== runId;

        void (async () => {
            const validTasks = commandOrders(command).filter((task) => !task.deleted);
            const taskCoords = collectTaskCoords(validTasks);
            const targetProvinces = commandRenderProvinces(command);

            let projection = projectionRef.current;
            let renderedMapPoints = renderedMapPointsRef.current;
            const shouldReloadMap = renderedMapKeyRef.current !== nextMapKey || !projection;

            if (shouldReloadMap) {
                inFlightMapKeyRef.current = nextMapKey;

                try {
                    const geoJson = targetProvinces.length > 0
                        ? await loadGeoJsonByRenderCommand(command)
                        : { type: 'FeatureCollection', features: [], boundaryFeatures: {} };
                    if (isStale()) return;

                    const boundaryFeatures: TownBoundaryLayers = geoJson.boundaryFeatures ?? {};
                    const boundaryFeatureList = Object.values(boundaryFeatures).flat();
                    const featurePoints = [...(geoJson.features ?? []), ...boundaryFeatureList].flatMap(featureCoords);
                    projection = createLocalProjection([...taskCoords, ...featurePoints]);
                    if (isStale()) return;
                    clearRenderedData();
                    if (isStale()) return;

                    renderedMapPoints = [];
                    if (geoJson.features?.length) {
                        const renderedMap = renderMapFeatures(geoJson.features, projection, boundaryFeatures);
                        if (isStale()) return;
                        mapGroupRef.current = renderedMap.group;
                        renderedMapPoints = renderedMap.points;
                        scene.add(renderedMap.group);
                    }

                    if (isStale()) return;
                    projectionRef.current = projection;
                    renderedMapKeyRef.current = nextMapKey;
                    renderedMapPointsRef.current = renderedMapPoints;
                    console.info('[TownRoadMap3D] map features rendered', {
                        nextMapKey,
                        featureCount: geoJson.features?.length ?? 0,
                        boundaryProvinceCount: boundaryFeatures.province?.length ?? 0,
                        boundaryCityCount: boundaryFeatures.city?.length ?? 0,
                        mapChildren: mapGroupRef.current?.children.length ?? 0,
                    });
                } finally {
                    if (inFlightMapKeyRef.current === nextMapKey) {
                        inFlightMapKeyRef.current = null;
                    }
                }
            } else {
                // 省份范围没变时，只重画路线/车辆，不重新请求 GeoJSON，也不重建省市县 3D 区块。
                if (isStale()) return;
                clearRouteData();
                if (isStale()) return;
            }

            if (isStale()) return;
            if (!projection) return;

            const renderedRoutes = renderRoutes(validTasks, projection);
            if (isStale()) return;
            routesGroupRef.current = renderedRoutes.group;
            scene.add(renderedRoutes.group);
            console.info('[TownRoadMap3D] route features rendered', {
                nextMapKey,
                taskCount: validTasks.length,
                routeChildren: renderedRoutes.group.children.length,
            });

            const taskFocusPoints = taskCoords
                .map((coord) => mapPositionFactory(projection)(coord, 0))
                .filter((point): point is THREE.Vector3 => Boolean(point));
            const focusSource = renderedRoutes.points.length > 0
                ? renderedRoutes.points
                : taskFocusPoints.length > 0
                    ? taskFocusPoints
                    : renderedMapPoints;
            if (isStale()) return;
            focusPoints(focusSource);

            const pending = pendingCommandForMapKeyRef.current;
            if (pending && commandMapKey(pending) === nextMapKey && pending !== command) {
                pendingCommandForMapKeyRef.current = null;
                console.info('[TownRoadMap3D] apply pending command after map ready', {
                    nextMapKey,
                    pendingCommandId: pending.commandId,
                });
                renderCommandRef.current?.(pending);
            }
        })();
    }, [clearRenderedData, clearRouteData, focusPoints, mapPositionFactory, renderMapFeatures, renderRoutes]);

    useEffect(() => {
        renderCommandRef.current = renderCommand;
    }, [renderCommand]);

    const setTransportTasks = useCallback((tasks: TownTransportTask[]) => {
        const validTasks = tasks.filter((task) => !task.deleted);
        renderCommand({
            type: 'town_road_render',
            commandId: `local-${Date.now()}`,
            title: validTasks[0]?.groupName ?? '区镇短途配送',
            renderLevel: 'province-district',
            renderProvinces: collectRenderProvinceAdcodes(validTasks),
            orders: validTasks,
            issuedAt: new Date().toISOString(),
        });
    }, [renderCommand]);

    const setRoute = useCallback((fromCoords: LonLat, toCoords: LonLat) => {
        setTransportTasks([
            {
                orderId: 'preview-order',
                lineId: 'preview-line',
                from: { name: '起点', coords: fromCoords },
                to: { name: '目的地', coords: toCoords },
                vehicle: { plate: '短途预览车', carId: 'preview-car' },
                status: '运输中',
                updatedAt: new Date().toISOString(),
            },
        ]);
    }, [setTransportTasks]);

    const startAnimationStage = useCallback((stage: TownAnimationStage) => {
        // 预留入口：后面具体动画可以在这里根据 stage.kind 调 camera、路线高亮、边高亮。
        // 当前阶段先只暴露入口，不改变地图状态，避免影响已调好的渲染链路。
        console.debug('[TownRoadMap3D] animation stage ready', stage.kind, stage.id, stage.payload);
    }, []);

    const playAnimationStage = useCallback((stage: TownAnimationStage) => {
        console.info('[TownRoadMap3D] playAnimationStage placeholder', {
            stageId: stage.id,
            stageKind: stage.kind,
            groupId: stage.payload.routeGroupId,
            pathId: stage.payload.candidatePathId,
            edgeKey: stage.payload.edgeKey,
            renderProvinces: stage.payload.renderProvinces,
        });
    }, []);

    useImperativeHandle(ref, () => ({
        setRoute,
        setTransportTasks,
        setRenderCommand: renderCommand,
        startAnimationStage,
        playAnimationStage,
        clearRoutes: clearRenderedData,
    }), [clearRenderedData, playAnimationStage, renderCommand, setRoute, setTransportTasks, startAnimationStage]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#07111f');
        scene.fog = new THREE.Fog('#07111f', 70, 210);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 10000);
        camera.position.set(0, 18, -14);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        rendererRef.current = renderer;
        container.appendChild(renderer.domElement);

        const onContextLost = (event: Event) => {
            event.preventDefault();
            console.error('[TownRoadMap3D] WebGL context lost', {
                renderedMapKey: renderedMapKeyRef.current,
                inFlightMapKey: inFlightMapKeyRef.current,
                renderRunId: renderRunRef.current,
                mapChildren: mapGroupRef.current?.children.length,
                routeChildren: routesGroupRef.current?.children.length,
            });
        };
        const onContextRestored = () => {
            console.warn('[TownRoadMap3D] WebGL context restored');
        };
        renderer.domElement.addEventListener('webglcontextlost', onContextLost);
        renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);
        controls.minPolarAngle = Math.PI / 10;
        controls.maxPolarAngle = Math.PI / 2 - 0.035;
        controls.minDistance = 4;
        controls.maxDistance = 80;
        controls.update();
        controlsRef.current = controls;

        scene.add(new THREE.AmbientLight(0xdbeafe, 0.82));
        const keyLight = new THREE.DirectionalLight(0xe0f2fe, 1.25);
        keyLight.position.set(-16, 28, 20);
        scene.add(keyLight);
        const cyanLight = new THREE.PointLight(0x22d3ee, 1.8, 100);
        cyanLight.position.set(0, 12, -8);
        scene.add(cyanLight);

        const onResize = () => {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
        };
        window.addEventListener('resize', onResize);

        const onPointerMove = (event: PointerEvent) => {
            const rect = renderer.domElement.getBoundingClientRect();
            pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycasterRef.current.setFromCamera(pointerRef.current, camera);
            const hit = raycasterRef.current.intersectObjects(interactiveObjectsRef.current, false)[0];
            if (!hit) {
                setHoverInfo(null);
                return;
            }
            const data = hit.object.userData;
            const point = screenPosition(hit.point, camera, container);
            setHoverInfo({
                x: point.x,
                y: point.y,
                title: data.title ?? '短途任务',
                subtitle: data.subtitle ?? data.objectType ?? '',
                rows: data.rows ?? [],
            });
        };
        const onPointerLeave = () => setHoverInfo(null);
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerleave', onPointerLeave);

        const animate = () => {
            renderFrameRef.current = requestAnimationFrame(animate);
            controls.update();
            renderer.render(scene, camera);
        };
        animate();
        requestAnimationFrame(() => {
            onVisualReadyRef.current?.();

            const pending = pendingCommandBeforeSceneRef.current;
            if (pending) {
                pendingCommandBeforeSceneRef.current = null;
                console.info('[TownRoadMap3D] apply deferred render command after scene ready', {
                    commandId: pending.commandId,
                    mapKey: commandMapKey(pending),
                });
                renderCommandRef.current?.(pending);
            }
        });

        return () => {
            window.removeEventListener('resize', onResize);
            renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
            renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
            renderer.domElement.removeEventListener('pointermove', onPointerMove);
            renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
            cancelAnimationFrame(renderFrameRef.current);
            clearRenderedData();
            controls.dispose();
            renderer.dispose();
            if (renderer.domElement.parentElement === container) {
                container.removeChild(renderer.domElement);
            }
            sceneRef.current = null;
            cameraRef.current = null;
            rendererRef.current = null;
            controlsRef.current = null;
        };
    }, [clearRenderedData]);

    return (
        <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
            <div className="pointer-events-none absolute left-5 top-5 z-40 rounded-lg border border-cyan-300/20 bg-slate-950/72 px-4 py-3 text-xs text-slate-300 shadow-2xl shadow-cyan-950/25 backdrop-blur-md">
                <div className="text-sm font-semibold text-cyan-100">区镇短途运输</div>
                <div className="mt-1 text-slate-400">按后端命令动态渲染省市县区块</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-slate-300">
                    <span className="inline-flex items-center gap-1"><i className="h-0.5 w-5 rounded bg-amber-300" />省界</span>
                    <span className="inline-flex items-center gap-1"><i className="h-0.5 w-5 rounded bg-cyan-300" />市界</span>
                    <span className="inline-flex items-center gap-1"><i className="h-px w-5 rounded bg-blue-200/60" />县界</span>
                </div>
            </div>
            {hoverInfo && (
                <div
                    className="pointer-events-none absolute z-50 w-64 -translate-x-1/2 -translate-y-full rounded-md border border-cyan-300/35 bg-slate-950/92 px-3 py-2.5 text-xs text-slate-100 shadow-2xl shadow-cyan-950/40 backdrop-blur-md"
                    style={{
                        left: Math.min(Math.max(132, hoverInfo.x), Math.max(132, (containerRef.current?.clientWidth ?? 264) - 132)),
                        top: Math.min(Math.max(116, hoverInfo.y - 18), Math.max(116, (containerRef.current?.clientHeight ?? 180) - 12)),
                    }}
                >
                    <div className="mb-2 border-b border-white/10 pb-2">
                        <div className="truncate text-sm font-medium text-cyan-100">{hoverInfo.title}</div>
                        <div className="mt-0.5 truncate text-[11px] text-slate-400" title={hoverInfo.subtitle}>{hoverInfo.subtitle}</div>
                    </div>
                    <div className="space-y-1.5">
                        {hoverInfo.rows.map(([label, value]) => (
                            <div key={label} className="grid grid-cols-[4.5rem_1fr] gap-2">
                                <span className="text-slate-400">{label}</span>
                                <span className="truncate text-right text-slate-100" title={value}>{value}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
});

export default TownRoadMap3D;
