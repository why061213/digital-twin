import { useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { loadProvinceGeoJson, MAP_HORIZONTAL_SCALE, projection } from '../geo';
import { useRoadMapRefs } from './useRoadMapRefs';
import { useRoadControls } from './useRoadControls';
import { useRoadSelection } from './useRoadSelection';

type MapLayer = {
    group: THREE.Group;
    boundaryMaterials: LineMaterial[];
};

type MapLayerSlot = 'province' | 'direction';

type MapLayerState = {
    layer: MapLayer | null;
    signature: string;
    generation: number;
    request: AbortController | null;
};

function disposeMapLayer(layer: MapLayer) {
    layer.group.removeFromParent();
    layer.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Line)) return;
        child.geometry?.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
    });
}

function buildMapLayer(geoJson: any, container: HTMLDivElement): MapLayer {
    const group = new THREE.Group();
    const boundaryMaterials: LineMaterial[] = [];
    const districtParentAdcodes = new Set<number>(
        geoJson.features
            .filter((feature: any) => feature.properties?._boundaryLevel === 'district')
            .map((feature: any) => Number(feature.properties?.parent?.adcode))
            .filter((adcode: number) => Number.isFinite(adcode))
    );

    geoJson.features.forEach((feature: any) => {
        const { geometry, properties } = feature;
        const boundaryLevel = properties?._boundaryLevel as 'province' | 'city' | 'district' | undefined;
        const isProvinceBoundary = boundaryLevel === 'province';
        const isDistrict = boundaryLevel === 'district';
        const hasDistrictFill = boundaryLevel === 'city'
            && districtParentAdcodes.has(Number(properties?.adcode));
        const usesDistrictSurface = isDistrict
            || (boundaryLevel === 'city' && !hasDistrictFill);
        let rings: number[][][] = [];
        if (geometry.type === 'Polygon') rings = [geometry.coordinates[0]];
        else if (geometry.type === 'MultiPolygon') rings = geometry.coordinates.map((polygon: any) => polygon[0]);
        else if (geometry.type === 'LineString') rings = [geometry.coordinates];
        else if (geometry.type === 'MultiLineString') rings = geometry.coordinates;

        const cityGroup = new THREE.Group();
        rings.forEach((ring) => {
            const projectedRing = ring
                .map(([lng, lat]) => projection([lng, lat]))
                .filter((point): point is [number, number] => point !== null);
            if (projectedRing.length < 2) return;

            const boundaryStyle = boundaryLevel === 'province'
                ? { color: 0xfbbf24, width: 1.8, opacity: 0.9, z: -0.18, order: 6 }
                : boundaryLevel === 'city'
                    ? { color: 0x38bdf8, width: 1.35, opacity: 0.68, z: -0.12, order: 5 }
                    : { color: 0x94a3b8, width: 0.75, opacity: 0.42, z: -0.07, order: 4 };

            const positions: number[] = [];
            projectedRing.forEach(([x, y]) => positions.push(-x, -y, boundaryStyle.z));
            const [firstX, firstY] = projectedRing[0];
            const [lastX, lastY] = projectedRing[projectedRing.length - 1];
            if (firstX !== lastX || firstY !== lastY) positions.push(-firstX, -firstY, boundaryStyle.z);

            if (isProvinceBoundary) {
                const provinceGeometry = new THREE.BufferGeometry();
                provinceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                const provinceBoundary = new THREE.Line(
                    provinceGeometry,
                    new THREE.LineBasicMaterial({
                        color: boundaryStyle.color,
                        transparent: true,
                        opacity: boundaryStyle.opacity,
                        depthWrite: false,
                        depthTest: false,
                    })
                );
                provinceBoundary.renderOrder = boundaryStyle.order;
                cityGroup.add(provinceBoundary);
                return;
            }

            const boundaryGeometry = new LineGeometry();
            boundaryGeometry.setPositions(positions);
            const boundaryMaterial = new LineMaterial({
                color: boundaryStyle.color,
                linewidth: boundaryStyle.width,
                transparent: true,
                opacity: boundaryStyle.opacity,
                depthWrite: false,
                depthTest: false,
            });
            boundaryMaterial.resolution.set(container.clientWidth, container.clientHeight);
            boundaryMaterials.push(boundaryMaterial);
            const boundary = new Line2(boundaryGeometry, boundaryMaterial);
            boundary.computeLineDistances();
            boundary.renderOrder = boundaryStyle.order;
            cityGroup.add(boundary);

            if (hasDistrictFill) return;

            const shape = new THREE.Shape();
            projectedRing.forEach(([x, y], index) => {
                if (index === 0) shape.moveTo(-x, -y);
                else shape.lineTo(-x, -y);
            });
            const geom = new THREE.ExtrudeGeometry(shape, {
                depth: usesDistrictSurface ? 0.1 : 0.16,
                bevelEnabled: false,
            });
            const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
                color: usesDistrictSurface ? '#1b3042' : '#29465f',
                emissive: usesDistrictSurface ? '#07131c' : '#0b2234',
                emissiveIntensity: usesDistrictSurface ? 0.05 : 0.1,
                roughness: 0.82,
                metalness: 0.05,
                side: THREE.DoubleSide,
            }));
            mesh.position.z = usesDistrictSurface ? -0.012 : 0;
            mesh.renderOrder = usesDistrictSurface ? 2 : 1;
            cityGroup.add(mesh);
        });
        group.add(cityGroup);
    });

    group.scale.set(MAP_HORIZONTAL_SCALE, MAP_HORIZONTAL_SCALE, 1);
    group.rotation.x = Math.PI / 2;
    return { group, boundaryMaterials };
}

export function useRoadMapScene(
    refs: ReturnType<typeof useRoadMapRefs>,
    controls: ReturnType<typeof useRoadControls>,
    selection: ReturnType<typeof useRoadSelection>,
    onVisualReady?: () => void,
) {
    const controlsRef = useRef(controls);
    const selectionRef = useRef(selection);
    const onVisualReadyRef = useRef(onVisualReady);
    const replaceMapRef = useRef<(
        slot: MapLayerSlot,
        scopeKey: string,
        mapKeys: string[],
    ) => Promise<void>>(async () => {});
    const clearMapRef = useRef<(slot: MapLayerSlot) => void>(() => {});
    controlsRef.current = controls;
    selectionRef.current = selection;
    onVisualReadyRef.current = onVisualReady;

    const setProvinceRegion = useCallback((provinceKey: string) => (
        replaceMapRef.current('province', provinceKey, [provinceKey])
    ), []);
    const clearProvinceRegion = useCallback(() => clearMapRef.current('province'), []);
    const setDirectionRegions = useCallback((directionKey: string, mapKeys: string[]) => (
        replaceMapRef.current('direction', directionKey, mapKeys)
    ), []);
    const clearDirectionRegions = useCallback(() => clearMapRef.current('direction'), []);

    useEffect(() => {
        const container = refs.containerRef.current;
        if (!container) return;

        let disposed = false;
        const scene = new THREE.Scene();
        scene.background = null;
        refs.sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 10000);
        camera.up.set(0, 1, 0);
        camera.position.set(140, 520, -240);
        camera.lookAt(0, 0, 0);
        refs.cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.domElement.style.background = 'transparent';
        container.appendChild(renderer.domElement);
        refs.rendererRef.current = renderer;
        const mapLayers: Record<MapLayerSlot, MapLayerState> = {
            province: { layer: null, signature: '', generation: 0, request: null },
            direction: { layer: null, signature: '', generation: 0, request: null },
        };

        const orbitControls = new OrbitControls(camera, renderer.domElement);
        orbitControls.enableDamping = true;
        orbitControls.enableRotate = true;
        orbitControls.target.set(0, 0, 0);
        orbitControls.minAzimuthAngle = Number.NEGATIVE_INFINITY;
        orbitControls.maxAzimuthAngle = Number.POSITIVE_INFINITY;
        orbitControls.minPolarAngle = Math.PI / 10;
        orbitControls.maxPolarAngle = Math.PI / 2 - 0.035;
        orbitControls.maxDistance = 2200;
        orbitControls.minDistance = 100;
        orbitControls.update();
        refs.controlsRef.current = orbitControls;

        scene.add(new THREE.AmbientLight(0xdbeafe, 0.82));
        const dirLight = new THREE.DirectionalLight(0xe0f2fe, 1.2);
        dirLight.position.set(-12, 24, 18);
        scene.add(dirLight);

        const releaseMapLayer = (slot: MapLayerSlot) => {
            const state = mapLayers[slot];
            if (state.layer) disposeMapLayer(state.layer);
            state.layer = null;
            state.signature = '';
        };
        clearMapRef.current = (slot) => {
            const state = mapLayers[slot];
            state.generation += 1;
            state.request?.abort();
            state.request = null;
            releaseMapLayer(slot);
        };
        replaceMapRef.current = async (slot, scopeKey, requestedMapKeys) => {
            const state = mapLayers[slot];
            const mapKeys = [...new Set(requestedMapKeys)]
                .filter((key) => /^\d{6}$/.test(key))
                .sort();
            const signature = `${scopeKey}:${mapKeys.join(',')}`;
            if (state.layer && signature === state.signature) return;
            if (mapKeys.length === 0) {
                clearMapRef.current(slot);
                return;
            }

            const generation = ++state.generation;
            state.request?.abort();
            const request = new AbortController();
            state.request = request;
            const geoJson = await loadProvinceGeoJson(mapKeys, request.signal);
            if (disposed || generation !== state.generation) return;
            const nextLayer = buildMapLayer(geoJson, container);
            if (disposed || generation !== state.generation) {
                disposeMapLayer(nextLayer);
                return;
            }

            releaseMapLayer(slot);
            state.layer = nextLayer;
            state.signature = signature;
            state.request = null;
            scene.add(nextLayer.group);
            renderer.render(scene, camera);
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            console.info('[RM2 map layer]', {
                slot,
                scopeKey,
                mapKeys,
                objectCount: nextLayer.group.children.length,
            });
        };

        window.requestAnimationFrame(() => {
            if (disposed) return;
            renderer.render(scene, camera);
            window.requestAnimationFrame(() => {
                if (!disposed) onVisualReadyRef.current?.();
            });
        });

        const animate = () => {
            refs.renderFrameRef.current = requestAnimationFrame(animate);
            const now = performance.now();
            refs.roadsMapRef.current.forEach((road) => {
                if (!road.isSelected) return;
                const pulse = 1 + Math.sin(now / 260) * 0.08;
                road.orders.forEach((lane) => {
                    lane.vehicles.forEach((vehicle) => {
                        vehicle.bar.scale.copy(vehicle.baseScale).multiplyScalar(pulse);
                    });
                });
            });
            selectionRef.current.updateHoverPosition();
            orbitControls.update();
            renderer.render(scene, camera);
        };
        animate();

        const onResize = () => {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
            (['province', 'direction'] as const).forEach((slot) => {
                mapLayers[slot].layer?.boundaryMaterials.forEach((material) => {
                    material.resolution.set(container.clientWidth, container.clientHeight);
                });
            });
        };
        window.addEventListener('resize', onResize);

        const pointerMove = (event: PointerEvent) => selectionRef.current.handlePointerMove(event);
        const pointerLeave = () => selectionRef.current.handlePointerLeave();
        renderer.domElement.addEventListener('pointermove', pointerMove);
        renderer.domElement.addEventListener('pointerleave', pointerLeave);

        console.log('✅ RoadMap3D scene initialized');

        return () => {
            console.log('🧹 RoadMap3D scene cleanup');

            disposed = true;
            replaceMapRef.current = async () => {};
            clearMapRef.current = () => {};
            (['province', 'direction'] as const).forEach((slot) => {
                const state = mapLayers[slot];
                state.generation += 1;
                state.request?.abort();
                state.request = null;
                releaseMapLayer(slot);
            });

            window.removeEventListener('resize', onResize);
            renderer.domElement.removeEventListener('pointermove', pointerMove);
            renderer.domElement.removeEventListener('pointerleave', pointerLeave);

            cancelAnimationFrame(refs.renderFrameRef.current);
            cancelAnimationFrame(refs.cameraMoveFrameRef.current);
            if (refs.cameraFocusTimeoutRef.current !== null) {
                window.clearTimeout(refs.cameraFocusTimeoutRef.current);
                refs.cameraFocusTimeoutRef.current = null;
            }

            controlsRef.current.clearRoads();

            orbitControls.dispose();

            scene.traverse((child) => {
                if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Line) {
                    child.geometry?.dispose();

                    const material = child.material;
                    if (Array.isArray(material)) {
                        material.forEach((m) => m.dispose());
                    } else {
                        material?.dispose();
                    }
                }
            });

            renderer.dispose();

            if (renderer.domElement.parentElement === container) {
                container.removeChild(renderer.domElement);
            }

            refs.sceneRef.current = null;
            refs.cameraRef.current = null;
            refs.rendererRef.current = null;
            refs.controlsRef.current = null;
            refs.cameraMoveFrameRef.current = 0;
            refs.roadsMapRef.current.clear();
            refs.lineTrackMapRef.current.clear();
            refs.selectedRoadIdRef.current = null;
        };
    }, [refs]);

    return {
        setProvinceRegion,
        clearProvinceRegion,
        setDirectionRegions,
        clearDirectionRegions,
    };
}
