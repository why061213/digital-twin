import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DragControls } from 'three/examples/jsm/controls/DragControls.js';
import { geoMercator } from 'd3-geo';

export type RoadMap3DHandle = {
    setRoadPath: (coords: [number, number][]) => void;
};

const BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const DIRECT_CITY_ADCODES = [110000, 120000, 310000, 500000, 710000, 810000, 820000];
const ROAD_LIFT = 0.08;
const TRUCK_LIFT = 0.36;
const PATH_SAMPLE_COUNT = 160;

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

const RoadMap3D = forwardRef<RoadMap3DHandle>((_props, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const roadGroupRef = useRef<THREE.Group | null>(null);
    const greenTubeRef = useRef<THREE.Mesh | null>(null);
    const truckRef = useRef<THREE.Mesh | null>(null);
    const truckGlowRef = useRef<THREE.Mesh | null>(null);
    const dragRef = useRef<DragControls | null>(null);
    const renderFrameRef = useRef<number>(0);
    const pathSamplesRef = useRef<THREE.Vector3[]>([]);
    const cumulativeLengthsRef = useRef<number[]>([]);
    const totalLengthRef = useRef<number>(0);
    const tubularSegmentsRef = useRef<number>(0);
    const radialSegmentsRef = useRef<number>(6);
    const progressRef = useRef<number>(0);

    const paintGreenRoad = useCallback((nextProgress: number) => {
        const tube = greenTubeRef.current;
        if (!tube) return;

        const progress = clamp01(nextProgress);
        const segments = tubularSegmentsRef.current;
        const radialSegments = radialSegmentsRef.current;
        const totalIndexCount = indexCount(tube.geometry);

        if (progress <= 0 || segments <= 0 || totalIndexCount <= 0) {
            tube.geometry.setDrawRange(0, 0);
            return;
        }

        const completedSegments = Math.max(1, Math.ceil(progress * segments));
        const drawCount = Math.min(totalIndexCount, completedSegments * radialSegments * 6);
        tube.geometry.setDrawRange(0, drawCount);
    }, []);

    const updateProgressFromTruck = useCallback(() => {
        const truck = truckRef.current;
        const samples = pathSamplesRef.current;
        const cumulative = cumulativeLengthsRef.current;
        const totalLength = totalLengthRef.current;
        if (!truck || samples.length < 2 || cumulative.length !== samples.length || totalLength <= 0) return;

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
                distanceAlongPath = cumulative[i] + Math.sqrt(segmentLengthSq) * segmentProgress;
            }
        }

        const nextProgress = clamp01(distanceAlongPath / totalLength);
        progressRef.current = nextProgress;
        paintGreenRoad(nextProgress);
    }, [paintGreenRoad]);

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
        const height = THREE.MathUtils.clamp(Math.max(neededHeightByDepth, neededHeightByWidth) * 1.6 + 8, 20, 130);

        camera.position.set(center.x, height, center.z + 0.001);
        controls.target.set(center.x, 0, center.z);
        camera.lookAt(controls.target);
        controls.update();
    }, []);

    const clearRoad = useCallback(() => {
        if (dragRef.current) {
            dragRef.current.dispose();
            dragRef.current = null;
        }

        if (roadGroupRef.current) {
            sceneRef.current?.remove(roadGroupRef.current);
            disposeObject3D(roadGroupRef.current);
            roadGroupRef.current = null;
        }

        greenTubeRef.current = null;
        truckRef.current = null;
        truckGlowRef.current = null;
        pathSamplesRef.current = [];
        cumulativeLengthsRef.current = [];
        totalLengthRef.current = 0;
        progressRef.current = 0;
    }, []);

    const setRoadPath = useCallback(
        (coords: [number, number][]) => {
            const scene = sceneRef.current;
            if (!scene || coords.length < 2) return;

            clearRoad();

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
                const current = samples[i];
                const dx = current.x - prev.x;
                const dz = current.z - prev.z;
                cumulativeLengths[i] = cumulativeLengths[i - 1] + Math.sqrt(dx * dx + dz * dz);
            }

            pathSamplesRef.current = samples;
            cumulativeLengthsRef.current = cumulativeLengths;
            totalLengthRef.current = cumulativeLengths[cumulativeLengths.length - 1] ?? 0;
            tubularSegmentsRef.current = tubularSegments;
            radialSegmentsRef.current = radialSegments;

            const grayTubeGeo = new THREE.TubeGeometry(pathCurve, tubularSegments, 0.08, radialSegments, false);
            const grayTube = new THREE.Mesh(
                grayTubeGeo,
                new THREE.MeshBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.76 })
            );

            const greenTubeGeo = new THREE.TubeGeometry(pathCurve, tubularSegments, 0.105, radialSegments, false);
            greenTubeGeo.setDrawRange(0, 0);
            const greenTube = new THREE.Mesh(
                greenTubeGeo,
                new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.92 })
            );
            greenTubeRef.current = greenTube;

            const startPoint = samples[0].clone();
            startPoint.y = TRUCK_LIFT;
            const truck = new THREE.Mesh(
                new THREE.SphereGeometry(0.25, 16, 16),
                new THREE.MeshBasicMaterial({ color: 0xffb020 })
            );
            const truckGlow = new THREE.Mesh(
                new THREE.SphereGeometry(0.48, 16, 16),
                new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.24, depthWrite: false })
            );
            truck.position.copy(startPoint);
            truckGlow.position.copy(startPoint);
            truckRef.current = truck;
            truckGlowRef.current = truckGlow;

            const group = new THREE.Group();
            group.add(grayTube);
            group.add(greenTube);
            group.add(truck);
            group.add(truckGlow);
            scene.add(group);
            roadGroupRef.current = group;

            paintGreenRoad(0);
            focusPath(points);

            const renderer = rendererRef.current;
            const camera = cameraRef.current;
            if (renderer && camera) {
                const dragControls = new DragControls([truck], camera, renderer.domElement);
                dragControls.addEventListener('dragstart', () => {
                    if (controlsRef.current) controlsRef.current.enabled = false;
                });
                dragControls.addEventListener('drag', () => {
                    truck.position.y = TRUCK_LIFT;
                    truckGlow.position.copy(truck.position);
                    updateProgressFromTruck();
                });
                dragControls.addEventListener('dragend', () => {
                    truck.position.y = TRUCK_LIFT;
                    truckGlow.position.copy(truck.position);
                    updateProgressFromTruck();
                    if (controlsRef.current) controlsRef.current.enabled = true;
                });
                dragRef.current = dragControls;
            }
        },
        [clearRoad, focusPath, paintGreenRoad, updateProgressFromTruck]
    );

    useImperativeHandle(ref, () => ({ setRoadPath }), [setRoadPath]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#0a0e17');
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 10000);
        camera.up.set(0, 0, 1);
        camera.position.set(0, 56, 0.001);
        camera.lookAt(0, 0, 0);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = Math.PI / 2.2;
        controls.maxDistance = 220;
        controls.update();
        controlsRef.current = controls;

        scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
        dirLight.position.set(0, 1, 0);
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
                                color: '#334155',
                                roughness: 0.65,
                                metalness: 0.18,
                                side: THREE.DoubleSide,
                            })
                        );
                        cityGroup.add(mesh);
                    });
                    group.add(cityGroup);
                });
                group.rotation.x = Math.PI / 2;
                scene.add(group);
            })
            .catch((err) => console.error('Map data failed to load', err));

        const animate = () => {
            renderFrameRef.current = requestAnimationFrame(animate);
            controls.update();
            renderer.render(scene, camera);
        };
        animate();

        const onResize = () => {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
            paintGreenRoad(progressRef.current);
        };
        window.addEventListener('resize', onResize);

        return () => {
            window.removeEventListener('resize', onResize);
            cancelAnimationFrame(renderFrameRef.current);
            clearRoad();
            renderer.dispose();
            if (renderer.domElement.parentElement === container) {
                container.removeChild(renderer.domElement);
            }
        };
    }, [clearRoad, paintGreenRoad]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
});

export default RoadMap3D;
