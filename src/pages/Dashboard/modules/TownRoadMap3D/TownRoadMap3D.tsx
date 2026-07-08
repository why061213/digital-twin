import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createLocalProjection, collectRenderProvinceAdcodes, collectTaskCoords, commandOrders, commandRenderProvinces, featureCoords, isLonLat, loadGeoJsonByRenderCommand } from './geo';
import { MAP_LIFT, MARKER_LIFT, ROUTE_LIFT, TOWN_ROUTE_CURVE_HEIGHT } from './constants';
import type { LonLat, TownBoundaryLayers, TownRoadMap3DHandle, TownRoadRenderCommand, TownTransportTask } from './types';

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

const BOUNDARY_STYLES: Record<BoundaryLevel, BoundaryStyle> = {
    // 省界：最高、最亮，用暖色，负责告诉用户“这是一整个省的外边界”。
    province: { color: 0xfbbf24, opacity: 0.88, lift: MAP_LIFT + 0.88, lineWidth: 3, renderOrder: 30 },
    // 市界：次高、偏 cyan，负责在省内分出地市层级。
    city: { color: 0x22d3ee, opacity: 0.54, lift: MAP_LIFT + 0.76, lineWidth: 2, renderOrder: 24 },
    // 县界：最细、最暗，主要由每个区县块自己的 EdgesGeometry 表达。
    district: { color: 0x93c5fd, opacity: 0.14, lift: MAP_LIFT + 0.58, lineWidth: 1, renderOrder: 12 },
};

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
                linewidth: style.lineWidth,
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
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const mapGroupRef = useRef<THREE.Group | null>(null);
    const routesGroupRef = useRef<THREE.Group | null>(null);
    const renderFrameRef = useRef(0);
    const renderRunRef = useRef(0);
    const raycasterRef = useRef(new THREE.Raycaster());
    const pointerRef = useRef(new THREE.Vector2());
    const interactiveObjectsRef = useRef<THREE.Object3D[]>([]);
    const [hoverInfo, setHoverInfo] = useState<TownHoverInfo | null>(null);

    const clearRenderedData = useCallback(() => {
        const scene = sceneRef.current;
        if (mapGroupRef.current) {
            scene?.remove(mapGroupRef.current);
            disposeObject3D(mapGroupRef.current);
            mapGroupRef.current = null;
        }
        if (routesGroupRef.current) {
            scene?.remove(routesGroupRef.current);
            disposeObject3D(routesGroupRef.current);
            routesGroupRef.current = null;
        }
        interactiveObjectsRef.current = [];
        setHoverInfo(null);
    }, []);

    const focusPoints = useCallback((points: THREE.Vector3[]) => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        if (!camera || !controls || points.length === 0) return;

        const box = new THREE.Box3().setFromPoints(points);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.z, 4);
        const height = THREE.MathUtils.clamp(span * 1.22 + 22, 24, 126);
        const tilt = THREE.MathUtils.clamp(span * 0.55 + 12, 18, 70);

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

                const geom = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
                const mesh = new THREE.Mesh(
                    geom,
                    new THREE.MeshStandardMaterial({
                        color: 0x20384f,
                        emissive: 0x061a27,
                        emissiveIntensity: 0.18,
                        roughness: 0.68,
                        metalness: 0.18,
                        side: THREE.DoubleSide,
                    })
                );
                cityGroup.add(mesh);

                const edge = new THREE.LineSegments(
                    new THREE.EdgesGeometry(geom, 28),
                    new THREE.LineBasicMaterial({
                        color: BOUNDARY_STYLES.district.color,
                        transparent: true,
                        opacity: BOUNDARY_STYLES.district.opacity,
                    })
                );
                edge.position.z -= 0.018;
                edge.renderOrder = BOUNDARY_STYLES.district.renderOrder;
                cityGroup.add(edge);
            });

            cityGroup.rotation.x = Math.PI / 2;
            group.add(cityGroup);
        });

        // 行政边界分级覆盖层：实体区县块仍然在下面，省/市边界浮在上面，避免所有线混成一层。
        const overlayGroup = new THREE.Group();
        overlayGroup.add(createBoundaryOverlay(boundaryFeatures?.city, projection, 'city'));
        overlayGroup.add(createBoundaryOverlay(boundaryFeatures?.province, projection, 'province'));
        group.add(overlayGroup);

        return { group, points: allPoints };
    }, []);

    const renderRoutes = useCallback((tasks: TownTransportTask[], projection: ReturnType<typeof createLocalProjection>) => {
        const mapPosition = mapPositionFactory(projection);
        const group = new THREE.Group();
        const points: THREE.Vector3[] = [];
        const endpointMarkers = new Map<string, THREE.Mesh>();
        const interactiveObjects: THREE.Object3D[] = [];

        const createEndpointMarker = (coords: LonLat, label: string, color: number, scale = 1) => {
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
            points.push(position);
            return marker;
        };

        tasks.forEach((task, index) => {
            if (task.deleted) return;
            const fallbackCoords = isLonLat(task.from.coords) && isLonLat(task.to.coords)
                ? [task.from.coords, task.to.coords]
                : [];
            const coords = task.coordinates && task.coordinates.length >= 2
                ? task.coordinates
                : fallbackCoords;
            const routePoints = coords
                .filter(isLonLat)
                .map((coord) => mapPosition(coord, ROUTE_LIFT))
                .filter((point): point is THREE.Vector3 => Boolean(point));
            if (routePoints.length < 2) return;

            const start = routePoints[0];
            const end = routePoints[routePoints.length - 1];
            const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
            const distance = start.distanceTo(end);
            const sideOffset = ((hashText(task.lineId) % 9) - 4) * 0.18;
            mid.y += TOWN_ROUTE_CURVE_HEIGHT + Math.min(distance * 0.08, 3.5);
            mid.x += sideOffset;
            mid.z -= sideOffset;

            const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
            const tube = new THREE.Mesh(
                new THREE.TubeGeometry(curve, 96, 0.055, 7, false),
                new THREE.MeshBasicMaterial({
                    color: statusTone(task.status),
                    transparent: true,
                    opacity: task.status.includes('完成') ? 0.44 : 0.82,
                    depthWrite: false,
                })
            );
            tube.userData = {
                objectType: '短途路线',
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
            group.add(tube);
            interactiveObjects.push(tube);

            const vehiclePosition = curve.getPoint(task.status.includes('完成') ? 1 : Math.min(0.18 + index * 0.08, 0.82));
            const vehicle = new THREE.Mesh(
                new THREE.SphereGeometry(0.22, 16, 16),
                new THREE.MeshBasicMaterial({ color: 0xfbbf24 })
            );
            vehicle.position.copy(vehiclePosition);
            vehicle.userData = tube.userData;
            group.add(vehicle);
            interactiveObjects.push(vehicle);

            if (isLonLat(task.from.coords)) {
                createEndpointMarker(task.from.coords, task.from.name, 0x38bdf8, 0.88);
            }
            if (isLonLat(task.to.coords)) {
                createEndpointMarker(task.to.coords, task.to.name, 0xf59e0b, 1.08);
            }
            points.push(...routePoints);
        });

        interactiveObjectsRef.current = interactiveObjects;
        return { group, points };
    }, [mapPositionFactory]);

    const renderCommand = useCallback((command: TownRoadRenderCommand) => {
        const scene = sceneRef.current;
        if (!scene) return;
        const runId = renderRunRef.current + 1;
        renderRunRef.current = runId;

        void (async () => {
            const validTasks = commandOrders(command).filter((task) => !task.deleted);
            const taskCoords = collectTaskCoords(validTasks);
            const targetProvinces = commandRenderProvinces(command);
            const geoJson = targetProvinces.length > 0
                ? await loadGeoJsonByRenderCommand(command)
                : { type: 'FeatureCollection', features: [], boundaryFeatures: {} };
            if (renderRunRef.current !== runId) return;

            const boundaryFeatureList = Object.values(geoJson.boundaryFeatures ?? {}).flat();
            const featurePoints = [...(geoJson.features ?? []), ...boundaryFeatureList].flatMap(featureCoords);
            const projection = createLocalProjection([...taskCoords, ...featurePoints]);
            clearRenderedData();

            let renderedMapPoints: THREE.Vector3[] = [];
            if (geoJson.features?.length) {
                const renderedMap = renderMapFeatures(geoJson.features, projection, geoJson.boundaryFeatures);
                mapGroupRef.current = renderedMap.group;
                renderedMapPoints = renderedMap.points;
                scene.add(renderedMap.group);
            }

            const renderedRoutes = renderRoutes(validTasks, projection);
            routesGroupRef.current = renderedRoutes.group;
            scene.add(renderedRoutes.group);

            const taskFocusPoints = taskCoords
                .map((coord) => mapPositionFactory(projection)(coord, 0))
                .filter((point): point is THREE.Vector3 => Boolean(point));
            const focusSource = renderedRoutes.points.length > 0
                ? renderedRoutes.points
                : taskFocusPoints.length > 0
                    ? taskFocusPoints
                    : renderedMapPoints;
            focusPoints(focusSource);
        })();
    }, [clearRenderedData, focusPoints, mapPositionFactory, renderMapFeatures, renderRoutes]);

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

    useImperativeHandle(ref, () => ({
        setRoute,
        setTransportTasks,
        setRenderCommand: renderCommand,
        clearRoutes: clearRenderedData,
    }), [clearRenderedData, renderCommand, setRoute, setTransportTasks]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#07111f');
        scene.fog = new THREE.Fog('#07111f', 70, 210);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 10000);
        camera.position.set(0, 54, -42);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        rendererRef.current = renderer;
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);
        controls.minPolarAngle = Math.PI / 10;
        controls.maxPolarAngle = Math.PI / 2 - 0.035;
        controls.minDistance = 8;
        controls.maxDistance = 180;
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
        requestAnimationFrame(() => onVisualReady?.());

        return () => {
            window.removeEventListener('resize', onResize);
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
    }, [clearRenderedData, onVisualReady]);

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
