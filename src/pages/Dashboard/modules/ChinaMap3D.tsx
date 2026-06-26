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
const DIRECT_CITY_ADCODES = [110000, 120000, 310000, 500000];
const RISE_HEIGHT = -1.5;
const FOSHAN = '\u4f5b\u5c71';

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
                // Ignore one failed province file and keep the map usable.
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

const projection = geoMercator()
    .center([104.5, 35])
    .scale(80)
    .translate([0, 0]);

function mapPosition(coords: [number, number], lift = 1.8) {
    const projected = projection(coords);
    if (!projected) return null;
    return new THREE.Vector3(-projected[0], lift, -projected[1]);
}

const ChinaMap3D = forwardRef<ChinaMap3DHandle>((_props, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const mapGroupRef = useRef<THREE.Group | null>(null);
    const meshMapRef = useRef<Record<string, THREE.Group>>({});
    const cityStatusRef = useRef<Map<string, number>>(new Map());
    const cityAnimFramesRef = useRef<Map<string, number>>(new Map());
    const flyAnimFramesRef = useRef<Map<string, number>>(new Map());
    const flyLinesRef = useRef<Map<string, THREE.Group>>(new Map());
    const foShanNameRef = useRef<string>(FOSHAN);
    const renderFrameRef = useRef<number>(0);
    const pendingRaisedCitiesRef = useRef<Set<string>>(new Set([FOSHAN]));

    const findCityKey = useCallback((cityName: string) => {
        const normalized = normalizeCityName(cityName);
        return Object.keys(meshMapRef.current).find((name) => normalizeCityName(name).includes(normalized));
    }, []);

    const animateCity = useCallback((cityName: string, targetZ: number, duration = 1200) => {
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
            if (!matchedKey) {
                pendingRaisedCitiesRef.current.add(normalizeCityName(cityName));
                return;
            }

            const status = cityStatusRef.current.get(matchedKey) ?? 0;
            if (status === 1) return;

            cityStatusRef.current.set(matchedKey, 1);
            const group = meshMapRef.current[matchedKey];
            const isFoShan = normalizeCityName(matchedKey).includes(FOSHAN);

            group.children.forEach((child) => {
                if (child instanceof THREE.Mesh) {
                    (child.material as THREE.MeshStandardMaterial).color.set(isFoShan ? '#f59e0b' : '#22d3ee');
                    (child.material as THREE.MeshStandardMaterial).emissive.set(isFoShan ? '#7c2d12' : '#0e7490');
                }
            });

            animateCity(matchedKey, RISE_HEIGHT, 1200);
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
                    (child.material as THREE.MeshStandardMaterial).color.set('#334155');
                    (child.material as THREE.MeshStandardMaterial).emissive.set('#020617');
                }
            });

            animateCity(matchedKey, 0, 850);
        },
        [animateCity, findCityKey]
    );

    const removeFlyLine = useCallback((lineId: string) => {
        const group = flyLinesRef.current.get(lineId);
        if (!group) return;

        const frame = flyAnimFramesRef.current.get(lineId);
        if (frame !== undefined) {
            cancelAnimationFrame(frame);
            flyAnimFramesRef.current.delete(lineId);
        }

        sceneRef.current?.remove(group);
        flyLinesRef.current.delete(lineId);
        disposeObject3D(group);
    }, []);

    const addFlyLine = useCallback(
        (lineId: string, fromCoords: [number, number], toCoords: [number, number]) => {
            const scene = sceneRef.current;
            if (!scene) return;

            removeFlyLine(lineId);

            const from = mapPosition(fromCoords);
            const to = mapPosition(toCoords);
            if (!from || !to) return;

            const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
            const distance = from.distanceTo(to);
            mid.y += Math.max(3.2, distance * 0.42);

            const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
            const points = curve.getPoints(128);
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const glowGeometry = geometry.clone();
            geometry.setDrawRange(0, 0);
            glowGeometry.setDrawRange(0, 0);

            const baseLine = new THREE.Line(
                geometry,
                new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.88 })
            );
            const glowLine = new THREE.Line(
                glowGeometry,
                new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.28 })
            );

            const head = new THREE.Mesh(
                new THREE.SphereGeometry(0.24, 16, 16),
                new THREE.MeshBasicMaterial({ color: 0xbae6fd })
            );
            const halo = new THREE.Mesh(
                new THREE.SphereGeometry(0.58, 16, 16),
                new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.24, depthWrite: false })
            );
            const startPulse = new THREE.Mesh(
                new THREE.SphereGeometry(0.3, 14, 14),
                new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.8, depthWrite: false })
            );
            const endPulse = new THREE.Mesh(
                new THREE.SphereGeometry(0.3, 14, 14),
                new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.8, depthWrite: false })
            );

            head.position.copy(from);
            halo.position.copy(from);
            startPulse.position.copy(from);
            endPulse.position.copy(to);

            const group = new THREE.Group();
            group.add(glowLine, baseLine, startPulse, endPulse, head, halo);
            scene.add(group);
            flyLinesRef.current.set(lineId, group);

            const startTime = performance.now();
            const growDuration = 1300;

            const step = () => {
                const elapsed = performance.now() - startTime;
                const grow = Math.min(elapsed / growDuration, 1);
                const drawCount = Math.max(2, Math.floor(easeInOutCubic(grow) * points.length));
                geometry.setDrawRange(0, drawCount);
                glowGeometry.setDrawRange(0, drawCount);

                const travel = grow < 1 ? grow : (elapsed % 2200) / 2200;
                const point = curve.getPoint(travel);
                head.position.copy(point);
                halo.position.copy(point);

                halo.scale.setScalar(1 + Math.sin(elapsed / 180) * 0.22);
                startPulse.scale.setScalar(1 + Math.sin(elapsed / 230) * 0.16);
                endPulse.scale.setScalar(1 + Math.sin(elapsed / 250 + 1.2) * 0.16);

                flyAnimFramesRef.current.set(lineId, requestAnimationFrame(step));
            };

            flyAnimFramesRef.current.set(lineId, requestAnimationFrame(step));
        },
        [removeFlyLine]
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

        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 10000);
        camera.position.set(0, 26, 0);
        camera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        rendererRef.current = renderer;
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = Math.PI / 2.15;
        controls.minDistance = 8;
        controls.maxDistance = 220;
        controls.update();

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
            foShanNameRef.current = foShanName;

            geoJson.features.forEach((feature: any) => {
                const { geometry, properties } = feature;
                const name = properties.name;
                const normalizedName = normalizeCityName(name);
                const isFoShan = normalizedName.includes(FOSHAN);
                const shouldRise = isFoShan || pendingRaisedCitiesRef.current.has(normalizedName);
                const depth = isFoShan ? 2 : 1;
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

            group.rotation.x = Math.PI / 2;
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
            cityAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            flyAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            flyLinesRef.current.forEach((line) => disposeObject3D(line));
            if (mapGroupRef.current) disposeObject3D(mapGroupRef.current);
            window.removeEventListener('resize', handleResize);
            controls.dispose();
            renderer.dispose();
            renderer.domElement.remove();
            sceneRef.current = null;
            rendererRef.current = null;
            meshMapRef.current = {};
            cityStatusRef.current.clear();
            cityAnimFramesRef.current.clear();
            flyAnimFramesRef.current.clear();
            flyLinesRef.current.clear();
        };
    }, []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />;
});

export default ChinaMap3D;
