import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { geoMercator } from 'd3-geo';

export type ChinaMap3DHandle = {
    riseCity: (cityName: string) => void;
    fallCity: (cityName: string) => void;
    flyToCity: (cityName: string) => void;
    addFlyLine: (lineId: string, fromCoords: [number, number], toCoords: [number, number]) => void;
    removeFlyLine: (lineId: string) => void;
};

const BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const DIRECT_CITY_ADCODES = [
    110000, 120000, 310000, 500000,  // 直辖市
    710000,  // 台湾
    810000,  // 香港
    820000   // 澳门
];
const RISE_HEIGHT = -1;
const FOSHAN = '\u4f5b\u5c71';
const FOSHAN_COORDS: [number, number] = [113.121416, 23.021548];
const CITY_RISE_DELAY = 500;
const CITY_RISE_DURATION = 1200;
const FLY_LINE_DELAY = CITY_RISE_DELAY + CITY_RISE_DURATION + 120;
const MAP_ROTATION_Z = 0;
const FLY_GROW_DURATION = 1300;
const FLY_TRAVEL_DURATION = 2400;
const FLY_MIN_LIFETIME = FLY_GROW_DURATION + FLY_TRAVEL_DURATION * 2;

const projection = geoMercator()
    .center([104.5, 35])
    .scale(80)
    .translate([0, 0]);

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
                // Keep the rest of the map usable if a province file fails.
            }
        })
    );

    return { type: 'FeatureCollection', features: [...municipalityFeatures, ...cityFeatures] };
}

function normalizeCityName(cityName: string) {
    return cityName.endsWith('\u5e02') ? cityName.slice(0, -1) : cityName;
}

function easeInOutCubic(t: number) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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

function mapPosition(coords: [number, number], lift = 1.8) {
    const projected = projection(coords);
    if (!projected) return null;
    const x = -projected[0];
    const z = -projected[1];
    const cos = Math.cos(MAP_ROTATION_Z);
    const sin = Math.sin(MAP_ROTATION_Z);
    return new THREE.Vector3(x * cos - z * sin, lift, x * sin + z * cos);
}

function indexCount(geometry: THREE.BufferGeometry) {
    return geometry.index?.count ?? geometry.attributes.position.count;
}

const ChinaMap3D = forwardRef<ChinaMap3DHandle>((_props, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const mapGroupRef = useRef<THREE.Group | null>(null);
    const meshMapRef = useRef<Record<string, THREE.Group>>({});
    const cityStatusRef = useRef<Map<string, number>>(new Map());
    const cityAnimFramesRef = useRef<Map<string, number>>(new Map());
    const flyAnimFramesRef = useRef<Map<string, number>>(new Map());
    const flyTimeoutsRef = useRef<Map<string, number>>(new Map());
    const flyRemovalTimeoutsRef = useRef<Map<string, number>>(new Map());
    const flyLinesRef = useRef<Map<string, THREE.Group>>(new Map());
    const flyStartTimesRef = useRef<Map<string, number>>(new Map());
    const pendingFlyRemovalRef = useRef<Set<string>>(new Set());
    const activeRouteCoordsRef = useRef<Map<string, [[number, number], [number, number]]>>(new Map());
    const renderFrameRef = useRef<number>(0);
    const cameraMoveFrameRef = useRef<number>(0);
    const cameraFocusTimeoutRef = useRef<number | null>(null);
    const pendingRaisedCitiesRef = useRef<Set<string>>(new Set([FOSHAN]));

    const focusFreightNodes = useCallback((delay = 0) => {
        const scheduleFocus = () => {
            cameraFocusTimeoutRef.current = null;
            const camera = cameraRef.current;
            const controls = controlsRef.current;
            const container = containerRef.current;
            if (!camera || !controls || !container) return;

            const points = [FOSHAN_COORDS, ...Array.from(activeRouteCoordsRef.current.values()).flat()].map((coords) =>
                mapPosition(coords, 0)
            ).filter((point): point is THREE.Vector3 => Boolean(point));

            if (points.length === 0) return;

            const box = new THREE.Box3().setFromPoints(points);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const verticalFov = THREE.MathUtils.degToRad(camera.fov);
            const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
            const neededHeightByDepth = size.z / (2 * Math.tan(verticalFov / 2));
            const neededHeightByWidth = size.x / (2 * Math.tan(horizontalFov / 2));
            const targetHeight = THREE.MathUtils.clamp(
                Math.max(neededHeightByDepth, neededHeightByWidth) * 1.45 + 8,
                18,
                95
            );

            const startPosition = camera.position.clone();
            const startTarget = controls.target.clone();
            const targetPosition = new THREE.Vector3(center.x, targetHeight, center.z);
            const targetLookAt = new THREE.Vector3(center.x, 0, center.z);
            const duration = 1100;
            const startTime = performance.now();

            cancelAnimationFrame(cameraMoveFrameRef.current);
            const step = () => {
                const progress = Math.min((performance.now() - startTime) / duration, 1);
                const eased = easeInOutCubic(progress);
                camera.position.lerpVectors(startPosition, targetPosition, eased);
                controls.target.lerpVectors(startTarget, targetLookAt, eased);
                camera.lookAt(controls.target);
                controls.update();

                if (progress < 1) {
                    cameraMoveFrameRef.current = requestAnimationFrame(step);
                }
            };

            cameraMoveFrameRef.current = requestAnimationFrame(step);
        };

        if (cameraFocusTimeoutRef.current !== null) {
            window.clearTimeout(cameraFocusTimeoutRef.current);
        }
        cameraFocusTimeoutRef.current = window.setTimeout(scheduleFocus, Math.max(80, delay));
    }, []);

    const findCityKey = useCallback((cityName: string) => {
        const normalized = normalizeCityName(cityName);
        return Object.keys(meshMapRef.current).find((name) => normalizeCityName(name).includes(normalized));
    }, []);

    const animateCity = useCallback((cityName: string, targetZ: number, duration = CITY_RISE_DURATION) => {
        const group = meshMapRef.current[cityName];
        if (!group) return;

        const oldFrame = cityAnimFramesRef.current.get(cityName);
        if (oldFrame !== undefined) {
            cancelAnimationFrame(oldFrame);
            cityAnimFramesRef.current.delete(cityName);
        }

        const startZ = group.position.z;
        const delta = targetZ - startZ;
        if (Math.abs(delta) < 0.001) return;

        const startTime = performance.now();
        const step = () => {
            const progress = Math.min((performance.now() - startTime) / duration, 1);
            group.position.z = startZ + delta * easeInOutCubic(progress);

            if (progress < 1) {
                cityAnimFramesRef.current.set(cityName, requestAnimationFrame(step));
            } else {
                group.position.z = targetZ;
                cityAnimFramesRef.current.delete(cityName);
            }
        };

        cityAnimFramesRef.current.set(cityName, requestAnimationFrame(step));
    }, []);

    const riseCity = useCallback(
        (cityName: string) => {
            const matchedKey = findCityKey(cityName);
            const normalized = normalizeCityName(cityName);

            if (!matchedKey) {
                pendingRaisedCitiesRef.current.add(normalized);
                return;
            }

            const status = cityStatusRef.current.get(matchedKey) ?? 0;
            if (status === 1) return;

            cityStatusRef.current.set(matchedKey, 1);
            const group = meshMapRef.current[matchedKey];
            const isFoShan = normalizeCityName(matchedKey).includes(FOSHAN);

            group.children.forEach((child) => {
                if (child instanceof THREE.Mesh) {
                    const material = child.material as THREE.MeshStandardMaterial;
                    material.color.set(isFoShan ? '#f59e0b' : '#22d3ee');
                    material.emissive.set(isFoShan ? '#7c2d12' : '#0e7490');
                    material.emissiveIntensity = 0.28;
                }
            });

            animateCity(matchedKey, RISE_HEIGHT, CITY_RISE_DURATION);
        },
        [animateCity, findCityKey]
    );

    const fallCity = useCallback(
        (cityName: string) => {
            const matchedKey = findCityKey(cityName);
            if (!matchedKey || normalizeCityName(matchedKey).includes(FOSHAN)) return;

            const status = cityStatusRef.current.get(matchedKey) ?? 0;
            if (status === 0) return;

            cityStatusRef.current.set(matchedKey, 0);
            const group = meshMapRef.current[matchedKey];
            group.children.forEach((child) => {
                if (child instanceof THREE.Mesh) {
                    const material = child.material as THREE.MeshStandardMaterial;
                    material.color.set('#334155');
                    material.emissive.set('#020617');
                    material.emissiveIntensity = 0.1;
                }
            });

            animateCity(matchedKey, 0, 850);
        },
        [animateCity, findCityKey]
    );

    const disposeFlyLineNow = useCallback((lineId: string, shouldFocus = true) => {
        const frame = flyAnimFramesRef.current.get(lineId);
        if (frame !== undefined) {
            cancelAnimationFrame(frame);
            flyAnimFramesRef.current.delete(lineId);
        }

        const timeout = flyTimeoutsRef.current.get(lineId);
        if (timeout !== undefined) {
            clearTimeout(timeout);
            flyTimeoutsRef.current.delete(lineId);
        }

        const removalTimeout = flyRemovalTimeoutsRef.current.get(lineId);
        if (removalTimeout !== undefined) {
            clearTimeout(removalTimeout);
            flyRemovalTimeoutsRef.current.delete(lineId);
        }

        pendingFlyRemovalRef.current.delete(lineId);
        flyStartTimesRef.current.delete(lineId);
        activeRouteCoordsRef.current.delete(lineId);

        const group = flyLinesRef.current.get(lineId);
        if (!group) {
            if (shouldFocus) focusFreightNodes(180);
            return;
        }

        sceneRef.current?.remove(group);
        flyLinesRef.current.delete(lineId);
        disposeObject3D(group);
        if (shouldFocus) focusFreightNodes(180);
    }, [focusFreightNodes]);

    const removeFlyLine = useCallback((lineId: string) => {
        pendingFlyRemovalRef.current.add(lineId);

        const startTime = flyStartTimesRef.current.get(lineId);
        if (startTime === undefined) {
            return;
        }

        const elapsed = performance.now() - startTime;
        const remaining = Math.max(0, FLY_MIN_LIFETIME - elapsed);
        const oldRemovalTimeout = flyRemovalTimeoutsRef.current.get(lineId);
        if (oldRemovalTimeout !== undefined) {
            clearTimeout(oldRemovalTimeout);
        }

        if (remaining === 0) {
            disposeFlyLineNow(lineId, false);
            return;
        }

        const removalTimeout = window.setTimeout(() => {
            flyRemovalTimeoutsRef.current.delete(lineId);
            disposeFlyLineNow(lineId);
        }, remaining);
        flyRemovalTimeoutsRef.current.set(lineId, removalTimeout);
    }, [disposeFlyLineNow, focusFreightNodes]);

    const addFlyLine = useCallback(
        (lineId: string, fromCoords: [number, number], toCoords: [number, number]) => {
            disposeFlyLineNow(lineId);
            activeRouteCoordsRef.current.set(lineId, [fromCoords, toCoords]);
            focusFreightNodes(FLY_LINE_DELAY);

            const timeoutId = window.setTimeout(() => {
                const scene = sceneRef.current;
                if (!scene) return;

                const from = mapPosition(fromCoords);
                const to = mapPosition(toCoords);
                if (!from || !to) return;

                const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
                const distance = from.distanceTo(to);
                mid.y += Math.max(3.2, distance * 0.42);

                const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
                const tubularSegments = 240;
                const radialSegments = 10;

                const baseGeo = new THREE.TubeGeometry(curve, tubularSegments, 0.045, radialSegments, false);
                const streamGeo = new THREE.TubeGeometry(curve, tubularSegments, 0.075, radialSegments, false);
                const glowGeo = new THREE.TubeGeometry(curve, tubularSegments, 0.13, radialSegments, false);
                const baseDrawCount = indexCount(baseGeo);
                const streamDrawCount = indexCount(streamGeo);
                const glowDrawCount = indexCount(glowGeo);

                baseGeo.setDrawRange(0, baseDrawCount);
                streamGeo.setDrawRange(0, 0);
                glowGeo.setDrawRange(0, 0);

                const baseTube = new THREE.Mesh(
                    baseGeo,
                    new THREE.MeshBasicMaterial({
                        color: 0x334155,
                        transparent: true,
                        opacity: 0.24,
                        depthWrite: false,
                    })
                );
                const streamMaterial = new THREE.MeshBasicMaterial({
                    color: 0x8b9bd8,
                    transparent: true,
                    opacity: 0.58,
                    depthWrite: false,
                });
                const glowMaterial = new THREE.MeshBasicMaterial({
                    color: 0xa5b4fc,
                    transparent: true,
                    opacity: 0.12,
                    depthWrite: false,
                });
                const streamTube = new THREE.Mesh(streamGeo, streamMaterial);
                const glowTube = new THREE.Mesh(glowGeo, glowMaterial);

                const head = new THREE.Mesh(
                    new THREE.SphereGeometry(0.24, 18, 18),
                    new THREE.MeshBasicMaterial({ color: 0xdbeafe })
                );
                const halo = new THREE.Mesh(
                    new THREE.SphereGeometry(0.58, 18, 18),
                    new THREE.MeshBasicMaterial({
                        color: 0x818cf8,
                        transparent: true,
                        opacity: 0.18,
                        depthWrite: false,
                    })
                );
                head.position.copy(from);
                halo.position.copy(from);

                const tailParticles = Array.from({ length: 4 }, (_, index) => {
                    const particle = new THREE.Mesh(
                        new THREE.SphereGeometry(0.12 - index * 0.018, 12, 12),
                        new THREE.MeshBasicMaterial({
                            color: 0xc7d2fe,
                            transparent: true,
                            opacity: 0.34 - index * 0.06,
                            depthWrite: false,
                        })
                    );
                    particle.position.copy(from);
                    particle.visible = false;
                    return particle;
                });

                const group = new THREE.Group();
                group.add(glowTube, baseTube, streamTube, ...tailParticles, head, halo);
                scene.add(group);
                flyLinesRef.current.set(lineId, group);
                flyTimeoutsRef.current.delete(lineId);
                flyStartTimesRef.current.set(lineId, performance.now());

                const startTime = performance.now();
                const growDuration = FLY_GROW_DURATION;
                const travelDuration = FLY_TRAVEL_DURATION;

                if (pendingFlyRemovalRef.current.has(lineId)) {
                    const removalTimeout = window.setTimeout(() => {
                        flyRemovalTimeoutsRef.current.delete(lineId);
                        disposeFlyLineNow(lineId);
                    }, FLY_MIN_LIFETIME);
                    flyRemovalTimeoutsRef.current.set(lineId, removalTimeout);
                }

                const step = () => {
                    const elapsed = performance.now() - startTime;
                    const grow = Math.min(elapsed / growDuration, 1);
                    const easedGrow = easeInOutCubic(grow);

                    streamGeo.setDrawRange(0, Math.max(3, Math.floor(easedGrow * streamDrawCount)));
                    glowGeo.setDrawRange(0, Math.max(3, Math.floor(easedGrow * glowDrawCount)));

                    const loopElapsed = Math.max(0, elapsed - growDuration);
                    const travelProgress = grow < 1 ? easedGrow : (loopElapsed % travelDuration) / travelDuration;
                    const point = curve.getPoint(travelProgress);
                    head.position.copy(point);
                    halo.position.copy(point);

                    tailParticles.forEach((particle, index) => {
                        const offset = (index + 1) * 0.025;
                        const offsetProgress = Math.max(0, travelProgress - offset);
                        particle.position.copy(curve.getPoint(offsetProgress));
                        particle.visible = grow > 0.08;
                    });

                    const wave = Math.sin(elapsed / 300) * 0.1 + 0.9;
                    streamMaterial.opacity = 0.5 + wave * 0.08;
                    glowMaterial.opacity = 0.1 + Math.sin(elapsed / 420) * 0.035;
                    halo.scale.setScalar(1 + Math.sin(elapsed / 180) * 0.22);

                    flyAnimFramesRef.current.set(lineId, requestAnimationFrame(step));
                };

                flyAnimFramesRef.current.set(lineId, requestAnimationFrame(step));
            }, FLY_LINE_DELAY);

            flyTimeoutsRef.current.set(lineId, timeoutId);
        },
        [disposeFlyLineNow, focusFreightNodes]
    );

    useImperativeHandle(
        ref,
        () => ({
            riseCity,
            fallCity,
            flyToCity: riseCity,
            addFlyLine,
            removeFlyLine,
        }),
        [addFlyLine, fallCity, removeFlyLine, riseCity]
    );

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        let disposed = false;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#07111f');
        sceneRef.current = scene;

        const initialFocus = mapPosition(FOSHAN_COORDS, 0) ?? new THREE.Vector3(0, 0, 0);
        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 10000);
        camera.up.set(0, 0, 1);
        camera.position.set(initialFocus.x, 26, initialFocus.z);
        camera.lookAt(initialFocus);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        rendererRef.current = renderer;
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.copy(initialFocus);
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = Math.PI / 2.15;
        controls.minDistance = 8;
        controls.maxDistance = 220;
        controls.update();
        controlsRef.current = controls;

        scene.add(new THREE.AmbientLight(0xffffff, 0.8));
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
        keyLight.position.set(0, 1, 0);
        scene.add(keyLight);
        const rimLight = new THREE.PointLight(0x22d3ee, 1.5, 90);
        rimLight.position.set(0, 8, 0);
        scene.add(rimLight);

        loadCityGeoJson().then((geoJson) => {
            if (disposed) return;

            const group = new THREE.Group();
            const allNames = geoJson.features.map((feature: any) => feature.properties.name);
            const foShanName = allNames.find((name: string) => normalizeCityName(name).includes(FOSHAN)) || FOSHAN;

            geoJson.features.forEach((feature: any) => {
                const { geometry, properties } = feature;
                const name = properties.name;
                const normalizedName = normalizeCityName(name);
                const isFoShan = normalizedName.includes(FOSHAN);
                const shouldRise = isFoShan || pendingRaisedCitiesRef.current.has(normalizedName);
                const depth = isFoShan ? 1.5 : 1;
                const color = isFoShan ? '#f59e0b' : shouldRise ? '#22d3ee' : '#334155';
                const emissive = isFoShan ? '#7c2d12' : shouldRise ? '#0e7490' : '#020617';

                let rings: number[][][] = [];
                if (geometry.type === 'Polygon') {
                    rings = [geometry.coordinates[0]];
                } else if (geometry.type === 'MultiPolygon') {
                    rings = geometry.coordinates.map((poly: any) => poly[0]);
                }

                const cityGroup = new THREE.Group();
                cityGroup.name = name;
                cityGroup.position.set(0, 0, shouldRise ? RISE_HEIGHT : 0);

                rings.forEach((ring) => {
                    const shape = new THREE.Shape();
                    ring.forEach(([lng, lat], index) => {
                        const projected = projection([lng, lat]);
                        if (!projected) return;
                        const [x, y] = projected;
                        if (index === 0) shape.moveTo(-x, -y);
                        else shape.lineTo(-x, -y);
                    });

                    const geom = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
                    const mesh = new THREE.Mesh(
                        geom,
                        new THREE.MeshStandardMaterial({
                            color,
                            emissive,
                            emissiveIntensity: shouldRise ? 0.26 : 0.1,
                            roughness: 0.58,
                            metalness: 0.22,
                            side: THREE.DoubleSide,
                        })
                    );
                    cityGroup.add(mesh);
                });

                group.add(cityGroup);
                meshMapRef.current[name] = cityGroup;
                cityStatusRef.current.set(name, shouldRise ? 1 : 0);
            });

            if (!meshMapRef.current[foShanName]) {
                pendingRaisedCitiesRef.current.add(FOSHAN);
            }

            group.rotation.set(Math.PI / 2, 0, MAP_ROTATION_Z);
            scene.add(group);
            mapGroupRef.current = group;
        });

        const render = () => {
            controls.update();
            renderer.render(scene, camera);
            renderFrameRef.current = requestAnimationFrame(render);
        };
        render();

        const handleResize = () => {
            const width = container.clientWidth;
            const height = container.clientHeight;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            disposed = true;
            cancelAnimationFrame(renderFrameRef.current);
            cancelAnimationFrame(cameraMoveFrameRef.current);
            if (cameraFocusTimeoutRef.current !== null) {
                window.clearTimeout(cameraFocusTimeoutRef.current);
                cameraFocusTimeoutRef.current = null;
            }
            cityAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            flyAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            flyTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
            flyRemovalTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
            flyLinesRef.current.forEach((line) => disposeObject3D(line));
            if (mapGroupRef.current) disposeObject3D(mapGroupRef.current);
            window.removeEventListener('resize', handleResize);
            controls.dispose();
            renderer.dispose();
            renderer.domElement.remove();
            sceneRef.current = null;
            rendererRef.current = null;
            cameraRef.current = null;
            controlsRef.current = null;
            meshMapRef.current = {};
            cityStatusRef.current.clear();
            cityAnimFramesRef.current.clear();
            flyAnimFramesRef.current.clear();
            flyTimeoutsRef.current.clear();
            flyRemovalTimeoutsRef.current.clear();
            flyLinesRef.current.clear();
            flyStartTimesRef.current.clear();
            pendingFlyRemovalRef.current.clear();
            activeRouteCoordsRef.current.clear();
        };
    }, []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />;
});

export default ChinaMap3D;
