import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DragControls } from 'three/examples/jsm/controls/DragControls.js';
import { geoMercator } from 'd3-geo';

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

const BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const DIRECT_CITY_ADCODES = [110000, 120000, 310000, 500000, 710000, 810000, 820000];
const ROAD_LIFT = 0.08;
const TRUCK_LIFT = 0.36;
const PATH_SAMPLE_COUNT = 160;
const CAMERA_TILT_RATIO = 0.48;

/* ---------- 工具函数 ---------- */
async function loadCityGeoJson(): Promise<any> {
    const provResp = await fetch(`${BASE_URL}100000_full.json`);
    const provData = await provResp.json();
    const municipalityFeatures: any[] = [];
    const provinceAdcodes: number[] = [];

    provData.features.forEach((feature: any) => {
        const adcode = feature.properties.adcode;
        if (DIRECT_CITY_ADCODES.includes(adcode)) {
            municipalityFeatures.push(feature);
        } else if (/^\d+$/.test(String(adcode))) {
            provinceAdcodes.push(adcode);
        }
    });

    const cityFeatures: any[] = [];
    await Promise.all(
        provinceAdcodes.map(async (adcode) => {
            try {
                const resp = await fetch(`${BASE_URL}${adcode}_full.json`);
                const data = await resp.json();
                if (data.features) cityFeatures.push(...data.features);
            } catch {
                // Keep the map usable if one province fails to load.
            }
        })
    );

    return { type: 'FeatureCollection', features: [...municipalityFeatures, ...cityFeatures] };
}

const projection = geoMercator()
    .center([104.5, 35])
    .scale(80)
    .translate([0, 0]);

function mapPosition(coords: [number, number], lift = 0) {
    const p = projection(coords);
    if (!p) return null;
    return new THREE.Vector3(-p[0], lift, -p[1]);
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

function clamp01(value: number) {
    return Math.min(Math.max(value, 0), 1);
}

function makeLinearCurve(points: THREE.Vector3[]) {
    const path = new THREE.CurvePath<THREE.Vector3>();
    path.add(new THREE.LineCurve3(points[0], points[points.length - 1]));
    return path;
}

function makePathCurve(points: THREE.Vector3[]) {
    if (points.length === 2) {
        return makeLinearCurve(points);
    }

    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < points.length - 1; i++) {
        path.add(new THREE.LineCurve3(points[i], points[i + 1]));
    }
    return path;
}

function indexCount(geometry: THREE.BufferGeometry) {
    return geometry.index?.count ?? geometry.attributes.position.count;
}

function ringAccentPoints(ring: number[][], count: number) {
    if (ring.length < 3) return [];
    const step = Math.max(8, Math.floor(ring.length / count));
    const points: Array<[number, number]> = [];
    for (let i = 0; i < ring.length; i += step) {
        const coord = ring[i];
        if (coord && typeof coord[0] === 'number' && typeof coord[1] === 'number') {
            points.push([coord[0], coord[1]]);
        }
    }
    return points.slice(0, count);
}

interface RoadState {
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

type HoverInfo = {
    x: number;
    y: number;
    title: string;
    subtitle: string;
    status: string;
    rows: Array<[string, string]>;
};

function formatNumber(value: number | null | undefined, digits = 2) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function screenPosition(point: THREE.Vector3, camera: THREE.Camera, container: HTMLDivElement) {
    const projected = point.clone().project(camera);
    return {
        x: (projected.x * 0.5 + 0.5) * container.clientWidth,
        y: (-projected.y * 0.5 + 0.5) * container.clientHeight,
    };
}

const RoadMap3D = forwardRef<RoadMap3DHandle>((_props, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const roadsMapRef = useRef<Map<string, RoadState>>(new Map());
    const renderFrameRef = useRef<number>(0);
    const raycasterRef = useRef(new THREE.Raycaster());
    const pointerRef = useRef(new THREE.Vector2());
    const selectedRoadIdRef = useRef<string | null>(null);
    const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);




    // 通用绿色进度绘制
    const paintGreenRoad = useCallback((tube: THREE.Mesh, progress: number, tubularSegments: number, radialSegments: number) => {
        if (!tube) return;
        const p = clamp01(progress);
        const totalIndexCount = indexCount(tube.geometry);
        if (p <= 0 || tubularSegments <= 0 || totalIndexCount <= 0) {
            tube.geometry.setDrawRange(0, 0);
            return;
        }
        const completedSegments = Math.max(1, Math.ceil(p * tubularSegments));
        const drawCount = Math.min(totalIndexCount, completedSegments * radialSegments * 6);
        tube.geometry.setDrawRange(0, drawCount);
    }, []);

    // 根据货车位置更新指定道路的进度
    const updateProgressFromTruck = useCallback((roadId: string) => {
        const road = roadsMapRef.current.get(roadId);
        if (!road) return;
        const { truck, samples, cumulativeLengths, totalLength, greenTube, tubularSegments, radialSegments, progressRef } = road;
        if (!truck || samples.length < 2 || cumulativeLengths.length !== samples.length || totalLength <= 0) return;

        const truckPos = truck.position;
        let nearestDistanceSq = Number.POSITIVE_INFINITY;
        let distanceAlongPath = 0;

        for (let i = 0; i < samples.length - 1; i++) {
            const start = samples[i];
            const end = samples[i + 1];
            const abX = end.x - start.x;
            const abZ = end.z - start.z;
            const segmentLengthSq = abX * abX + abZ * abZ;
            if (segmentLengthSq <= 0.000001) continue;

            const apX = truckPos.x - start.x;
            const apZ = truckPos.z - start.z;
            const segmentProgress = clamp01((apX * abX + apZ * abZ) / segmentLengthSq);
            const projectedX = start.x + abX * segmentProgress;
            const projectedZ = start.z + abZ * segmentProgress;
            const dx = truckPos.x - projectedX;
            const dz = truckPos.z - projectedZ;
            const distanceSq = dx * dx + dz * dz;

            if (distanceSq < nearestDistanceSq) {
                nearestDistanceSq = distanceSq;
                distanceAlongPath = cumulativeLengths[i] + Math.sqrt(segmentLengthSq) * segmentProgress;
            }
        }

        const nextProgress = clamp01(distanceAlongPath / totalLength);
        progressRef.current = nextProgress;
        paintGreenRoad(greenTube, nextProgress, tubularSegments, radialSegments);
    }, [paintGreenRoad]);

    const setSelectedRoad = useCallback((selectedId: string | null) => {
        selectedRoadIdRef.current = selectedId;
        roadsMapRef.current.forEach((road, id) => {
            const selected = id === selectedId;
            if (road.isSelected === selected) return;
            road.isSelected = selected;

            const grayMat = road.grayTube.material as THREE.MeshBasicMaterial;
            const selectionMat = road.selectionTube.material as THREE.MeshBasicMaterial;
            const greenMat = road.greenTube.material as THREE.MeshBasicMaterial;
            const glowMat = road.truckGlow.material as THREE.MeshBasicMaterial;
            const ringMat = road.selectionRing.material as THREE.MeshBasicMaterial;

            grayMat.opacity = selected ? 0.9 : 0.76;
            selectionMat.opacity = selected ? 0.22 : 0;
            greenMat.opacity = selected ? 1 : 0.92;
            glowMat.opacity = selected ? 0.42 : 0.24;
            ringMat.opacity = selected ? 0.34 : 0;
            road.truck.scale.setScalar(selected ? 1.12 : 1);
            road.truckGlow.scale.setScalar(selected ? 1.12 : 1);
        });
    }, []);

    // 镜头聚焦到一组点
    const focusPath = useCallback((points: THREE.Vector3[]) => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        const container = containerRef.current;
        if (!camera || !controls || !container || points.length === 0) return;

        const box = new THREE.Box3().setFromPoints(points);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
        const neededHeightByDepth = size.z / (2 * Math.tan(verticalFov / 2));
        const neededHeightByWidth = size.x / (2 * Math.tan(horizontalFov / 2));
        const span = Math.max(size.x, size.z, 1);
        const height = THREE.MathUtils.clamp(Math.max(neededHeightByDepth, neededHeightByWidth) * 1.55 + 10, 24, 132);
        const tilt = THREE.MathUtils.clamp(span * CAMERA_TILT_RATIO + 10, 16, 48);
        const viewDirection = new THREE.Vector3(
            camera.position.x - controls.target.x,
            0,
            camera.position.z - controls.target.z
        );
        if (viewDirection.lengthSq() < 0.001) {
            viewDirection.set(-0.34, 0, 1);
        }
        viewDirection.normalize();

        camera.position.set(center.x + viewDirection.x * tilt, height, center.z + viewDirection.z * tilt);
        controls.target.set(center.x, 0, center.z);
        controls.update();
    }, []);

    // 移除单条道路
    const clearRoad = useCallback((id: string) => {
        const road = roadsMapRef.current.get(id);
        if (!road) return;
        road.dragControls.dispose();
        sceneRef.current?.remove(road.group);
        disposeObject3D(road.group);
        roadsMapRef.current.delete(id);
    }, []);

    const clearRoads = useCallback(() => {
        Array.from(roadsMapRef.current.keys()).forEach((id) => clearRoad(id));
        roadsMapRef.current.clear();
        selectedRoadIdRef.current = null;
        setHoverInfo(null);
    }, [clearRoad]);

    // 添加一条道路
    const addRoadPath = useCallback(
        (id: string, coords: [number, number][], info: RoadObjectInfo = {}) => {
            const scene = sceneRef.current;
            if (!scene || coords.length < 2) return;

            // 如果已存在同 ID 的道路，先移除
            clearRoad(id);

            const points = coords
                .map((coord) => mapPosition(coord, ROAD_LIFT))
                .filter((point): point is THREE.Vector3 => Boolean(point));

            if (points.length < 2) return;

            const pathCurve = makePathCurve(points);
            const tubularSegments = Math.max(PATH_SAMPLE_COUNT, points.length * 32);
            const radialSegments = 6;
            const samples = pathCurve.getSpacedPoints(tubularSegments);
            const cumulativeLengths: number[] = [0];
            for (let i = 1; i < samples.length; i++) {
                const prev = samples[i - 1];
                const curr = samples[i];
                cumulativeLengths[i] = cumulativeLengths[i - 1] + prev.distanceTo(curr);
            }

            // 灰色底路
            const grayTubeGeo = new THREE.TubeGeometry(pathCurve, tubularSegments, 0.08, radialSegments, false);
            const grayTube = new THREE.Mesh(grayTubeGeo, new THREE.MeshBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.76 }));
            grayTube.userData = { roadId: id, objectType: '路线' };

            const selectionTubeGeo = new THREE.TubeGeometry(pathCurve, tubularSegments, 0.16, radialSegments, false);
            const selectionTube = new THREE.Mesh(
                selectionTubeGeo,
                new THREE.MeshBasicMaterial({
                    color: 0x38bdf8,
                    transparent: true,
                    opacity: 0,
                    depthWrite: false,
                })
            );
            selectionTube.userData = { roadId: id, objectType: '路线' };

            // 绿色覆盖路
            const greenTubeGeo = new THREE.TubeGeometry(pathCurve, tubularSegments, 0.105, radialSegments, false);
            greenTubeGeo.setDrawRange(0, 0);
            const greenTube = new THREE.Mesh(greenTubeGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.92 }));
            greenTube.userData = { roadId: id, objectType: '已行驶路线' };

            // 货车与光晕
            const startPoint = samples[0].clone();
            startPoint.y = TRUCK_LIFT;
            const labelAnchor = samples[Math.floor(samples.length * 0.58)]?.clone() ?? startPoint.clone();
            labelAnchor.x += 1.25;
            labelAnchor.y = TRUCK_LIFT + 3.25;
            labelAnchor.z += 0.95;
            const truck = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffb020 }));
            const truckGlow = new THREE.Mesh(new THREE.SphereGeometry(0.48, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.24, depthWrite: false }));
            const selectionRing = new THREE.Mesh(
                new THREE.RingGeometry(0.45, 0.62, 48),
                new THREE.MeshBasicMaterial({
                    color: 0x7dd3fc,
                    transparent: true,
                    opacity: 0,
                    side: THREE.DoubleSide,
                    depthWrite: false,
                })
            );
            truck.position.copy(startPoint);
            truckGlow.position.copy(startPoint);
            selectionRing.position.copy(startPoint);
            selectionRing.rotation.x = Math.PI / 2;
            truck.userData = { roadId: id, objectType: '车辆' };
            truckGlow.userData = { roadId: id, objectType: '车辆光晕' };

            const group = new THREE.Group();
            group.add(grayTube, selectionTube, greenTube, selectionRing, truck, truckGlow);
            scene.add(group);

            // 存储道路状态
            const progressRef = { current: 0 };
            const road: RoadState = {
                group,
                grayTube,
                selectionTube,
                greenTube,
                truck,
                truckGlow,
                selectionRing,
                dragControls: null as any, // 稍后赋值
                samples,
                cumulativeLengths,
                totalLength: cumulativeLengths[cumulativeLengths.length - 1] ?? 0,
                tubularSegments,
                radialSegments,
                progressRef,
                currentCoords: coords[0],
                labelAnchor,
                info,
                isSelected: false,
            };

            // 设置拖拽
            if (rendererRef.current && cameraRef.current) {
                const dragControls = new DragControls([truck], cameraRef.current, rendererRef.current.domElement);
                dragControls.addEventListener('dragstart', () => {
                    if (controlsRef.current) controlsRef.current.enabled = false;
                });
                dragControls.addEventListener('drag', () => {
                    const draggedId = truck.userData.roadId;
                    if (draggedId) {
                        truck.position.y = TRUCK_LIFT;
                        truckGlow.position.copy(truck.position);
                        updateProgressFromTruck(draggedId);
                    }
                });
                dragControls.addEventListener('dragend', () => {
                    const draggedId = truck.userData.roadId;
                    if (draggedId) {
                        truck.position.y = TRUCK_LIFT;
                        truckGlow.position.copy(truck.position);
                        updateProgressFromTruck(draggedId);
                    }
                    if (controlsRef.current) controlsRef.current.enabled = true;
                });
                road.dragControls = dragControls;
            }

            roadsMapRef.current.set(id, road);

            // 自动聚焦新路径
            focusPath(points);
        },
        [clearRoad, focusPath, paintGreenRoad, updateProgressFromTruck]
    );

    // 移除道路
    const removeRoadPath = useCallback((id: string) => {
        clearRoad(id);
    }, [clearRoad]);

    // 快捷方法（无 ID）
    const setRoadPath = useCallback(
        (coords: [number, number][]) => {
            const id = `road_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            addRoadPath(id, coords);
        },
        [addRoadPath]
    );

    const updateTruckPosition = useCallback((lineId: string, position: [number, number], info: RoadObjectInfo = {}) => {
        const road = roadsMapRef.current.get(lineId);
        if (!road) return;
        const worldPos = mapPosition(position, TRUCK_LIFT);
        if (!worldPos) return;
        road.truck.position.copy(worldPos);
        road.truckGlow.position.copy(worldPos);
        road.selectionRing.position.copy(worldPos);
        road.currentCoords = position;
        road.info = { ...road.info, ...info };
        // 同步更新绿色进度
        updateProgressFromTruck(lineId);
    }, [updateProgressFromTruck]);

    const buildHoverInfo = useCallback((roadId: string, objectType: string, x: number, y: number): HoverInfo | null => {
        const road = roadsMapRef.current.get(roadId);
        if (!road) return null;

        const info = road.info;
        const coords = road.currentCoords;
        const routeTitle = `${info.from ?? '--'} -> ${info.to ?? '--'}`;
        return {
            x,
            y,
            title: info.plate ?? (objectType === '车辆' || objectType === '车辆光晕' ? '车辆信息' : '路线信息'),
            subtitle: routeTitle,
            status: info.status ?? '--',
            rows: [
                ['货物', info.cargo ?? '--'],
                ['当前经度', formatNumber(coords[0], 6)],
                ['当前纬度', formatNumber(coords[1], 6)],
                ['时速', `${formatNumber(info.speedKmh, 1)} km/h`],
                ['路线长度', `${formatNumber(info.routeLengthKm, 1)} km`],
            ],
        };
    }, []);


    useImperativeHandle(ref, () => ({
        setRoadPath,
        addRoadPath,
        removeRoadPath,
        clearRoads,
        updateTruckPosition,
    }), [setRoadPath, addRoadPath, removeRoadPath, clearRoads, updateTruckPosition]);


    // 场景初始化
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#081320');
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 10000);
        camera.up.set(0, 1, 0);
        camera.position.set(14, 52, -24);
        camera.lookAt(0, 0, 0);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.enableRotate = true;
        controls.target.set(0, 0, 0);
        controls.minAzimuthAngle = Number.NEGATIVE_INFINITY;
        controls.maxAzimuthAngle = Number.POSITIVE_INFINITY;
        controls.minPolarAngle = Math.PI / 10;
        controls.maxPolarAngle = Math.PI / 2 - 0.035;
        controls.maxDistance = 220;
        controls.minDistance = 10;
        controls.update();
        controlsRef.current = controls;

        scene.add(new THREE.AmbientLight(0xdbeafe, 0.82));
        const dirLight = new THREE.DirectionalLight(0xe0f2fe, 1.2);
        dirLight.position.set(-12, 24, 18);
        scene.add(dirLight);

        loadCityGeoJson()
            .then((geoJson) => {
                const group = new THREE.Group();
                geoJson.features.forEach((feature: any) => {
                    const { geometry } = feature;
                    let rings: number[][][] = [];
                    if (geometry.type === 'Polygon') rings = [geometry.coordinates[0]];
                    else if (geometry.type === 'MultiPolygon') rings = geometry.coordinates.map((p: any) => p[0]);

                    const cityGroup = new THREE.Group();
                    rings.forEach((ring) => {
                        const shape = new THREE.Shape();
                        ring.forEach(([lng, lat], index) => {
                            const projected = projection([lng, lat]);
                            if (!projected) return;
                            const [x, y] = projected;
                            if (index === 0) shape.moveTo(-x, -y);
                            else shape.lineTo(-x, -y);
                        });

                        const geom = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
                        const mesh = new THREE.Mesh(
                            geom,
                            new THREE.MeshStandardMaterial({
                                color: '#2f465e',
                                emissive: '#0b2234',
                                emissiveIntensity: 0.12,
                                roughness: 0.65,
                                metalness: 0.18,
                                side: THREE.DoubleSide,
                            })
                        );
                        cityGroup.add(mesh);
                        const edgeLine = new THREE.LineSegments(
                            new THREE.EdgesGeometry(geom, 32),
                            new THREE.LineBasicMaterial({
                                color: 0x7dd3fc,
                                transparent: true,
                                opacity: 0.14,
                                depthWrite: false,
                            })
                        );
                        edgeLine.position.z += 0.015;
                        cityGroup.add(edgeLine);

                        ringAccentPoints(ring, 2).forEach(([lng, lat], index) => {
                            const projected = projection([lng, lat]);
                            if (!projected) return;
                            const [x, y] = projected;
                            const accent = new THREE.Mesh(
                                new THREE.SphereGeometry(0.035, 10, 10),
                                new THREE.MeshBasicMaterial({
                                    color: 0x93c5fd,
                                    transparent: true,
                                    opacity: 0.2,
                                    depthWrite: false,
                                })
                            );
                            accent.position.set(-x, -y, 0.58 + (index % 2) * 0.02);
                            cityGroup.add(accent);
                        });
                    });
                    group.add(cityGroup);
                });
                group.rotation.x = Math.PI / 2;
                scene.add(group);
            })
            .catch((err) => console.error('Map data failed to load', err));

        const animate = () => {
            renderFrameRef.current = requestAnimationFrame(animate);
            const now = performance.now();
            roadsMapRef.current.forEach((road) => {
                if (!road.isSelected) return;
                const pulse = 1 + Math.sin(now / 260) * 0.08;
                road.selectionRing.scale.setScalar(pulse);
                road.selectionRing.rotation.z += 0.018;
            });
            const selectedRoadId = selectedRoadIdRef.current;
            if (selectedRoadId) {
                const road = roadsMapRef.current.get(selectedRoadId);
                if (road) {
                    const label = screenPosition(road.labelAnchor, camera, container);
                    setHoverInfo((current) => {
                        if (!current) return current;
                        if (Math.abs(current.x - label.x) < 0.5 && Math.abs(current.y - label.y) < 0.5) {
                            return current;
                        }
                        return { ...current, x: label.x, y: label.y };
                    });
                }
            }
            controls.update();
            renderer.render(scene, camera);
        };
        animate();

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

            const objects = Array.from(roadsMapRef.current.values()).flatMap((road) => [
                road.truck,
                road.truckGlow,
                road.greenTube,
                road.grayTube,
                road.selectionTube,
            ]);
            const hit = raycasterRef.current.intersectObjects(objects, false)[0];
            const roadId = hit?.object.userData.roadId;
            if (typeof roadId !== 'string') {
                setSelectedRoad(null);
                setHoverInfo(null);
                return;
            }

            const objectType = String(hit.object.userData.objectType ?? '对象');
            setSelectedRoad(roadId);
            const road = roadsMapRef.current.get(roadId);
            const label = road
                ? screenPosition(road.labelAnchor, camera, container)
                : screenPosition(hit.point, camera, container);
            setHoverInfo(buildHoverInfo(roadId, objectType, label.x, label.y));
        };

        const onPointerLeave = () => {
            setSelectedRoad(null);
            setHoverInfo(null);
        };
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerleave', onPointerLeave);

        return () => {
            window.removeEventListener('resize', onResize);
            renderer.domElement.removeEventListener('pointermove', onPointerMove);
            renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
            cancelAnimationFrame(renderFrameRef.current);
            // 清理所有道路
            Array.from(roadsMapRef.current.keys()).forEach((id) => clearRoad(id));
            roadsMapRef.current.clear();
            renderer.dispose();
            if (renderer.domElement.parentElement === container) {
                container.removeChild(renderer.domElement);
            }
        };
    }, [buildHoverInfo, clearRoad]);

    return (
        <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
            {hoverInfo && (
                <div
                    className="pointer-events-none absolute z-50 w-64 -translate-x-1/2 -translate-y-full rounded-md border border-cyan-300/35 bg-slate-950/92 px-3 py-2.5 text-xs text-slate-100 shadow-2xl shadow-cyan-950/40 backdrop-blur-md"
                    style={{
                        left: Math.min(Math.max(132, hoverInfo.x), Math.max(132, (containerRef.current?.clientWidth ?? 264) - 132)),
                        top: Math.min(Math.max(116, hoverInfo.y - 18), Math.max(116, (containerRef.current?.clientHeight ?? 180) - 12)),
                    }}
                >
                    <div className="mb-2 flex items-start justify-between gap-3 border-b border-white/10 pb-2">
                        <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-cyan-100">{hoverInfo.title}</div>
                            <div className="mt-0.5 truncate text-[11px] text-slate-400" title={hoverInfo.subtitle}>
                                {hoverInfo.subtitle}
                            </div>
                        </div>
                        <span className="shrink-0 rounded border border-emerald-300/25 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-200">
                            {hoverInfo.status}
                        </span>
                    </div>
                    <div className="space-y-1.5">
                        {hoverInfo.rows.map(([label, value]) => (
                            <div key={label} className="grid grid-cols-[4.5rem_1fr] gap-2">
                                <span className="text-slate-400">{label}</span>
                                <span className="truncate text-right text-slate-100" title={value}>
                                    {value}
                                </span>
                            </div>
                        ))}
                    </div>
                    <div className="absolute left-1/2 top-full h-4 w-px -translate-x-1/2 bg-cyan-300/45" />
                    <div className="absolute left-1/2 top-[calc(100%+1rem)] h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-cyan-200 shadow-[0_0_12px_rgba(125,211,252,0.8)]" />
                </div>
            )}
        </div>
    );
});

export default RoadMap3D;
