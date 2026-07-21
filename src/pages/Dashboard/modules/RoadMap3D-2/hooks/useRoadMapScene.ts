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
    regionLabels: MapRegionLabel[];
};

type MapRegionLabel = {
    key: string;
    level: 'city' | 'district';
    sprite: THREE.Sprite;
    aspect: number;
};

type MapLayerSlot = 'province' | 'direction';

type MapLayerState = {
    activeLayer: MapLayer | null;
    activeSignature: string;
    stagedLayer: MapLayer | null;
    stagedSignature: string;
    generation: number;
    request: AbortController | null;
    pendingSignature: string;
    pendingPromise: Promise<void> | null;
};

function disposeMapLayer(layer: MapLayer) {
    layer.group.removeFromParent();
    layer.group.traverse((child) => {
        if (child instanceof THREE.Sprite) {
            child.material.map?.dispose();
            child.material.dispose();
            return;
        }
        if (!(child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Line)) return;
        child.geometry?.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
    });
}

function polygonArea(ring: [number, number][]) {
    let area = 0;
    for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];
        area += current[0] * next[1] - next[0] * current[1];
    }
    return area / 2;
}

function polygonCentroid(ring: [number, number][]): [number, number] | null {
    const area = polygonArea(ring);
    if (Math.abs(area) < 1e-6) return null;
    let x = 0;
    let y = 0;
    for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];
        const cross = current[0] * next[1] - next[0] * current[1];
        x += (current[0] + next[0]) * cross;
        y += (current[1] + next[1]) * cross;
    }
    return [x / (6 * area), y / (6 * area)];
}

function resolveRegionLabelPosition(properties: any, projectedRings: [number, number][][]) {
    const sourceCenter = properties?.centroid ?? properties?.center;
    if (Array.isArray(sourceCenter) && sourceCenter.length >= 2) {
        const projected = projection([Number(sourceCenter[0]), Number(sourceCenter[1])]);
        if (projected) return projected;
    }

    const largestRing = [...projectedRings]
        .filter((ring) => ring.length >= 3)
        .sort((left, right) => Math.abs(polygonArea(right)) - Math.abs(polygonArea(left)))[0];
    return largestRing ? polygonCentroid(largestRing) : null;
}

function createRegionLabel(name: string, level: 'city' | 'district') {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    const fontSize = level === 'city' ? 34 : 30;
    const fontWeight = level === 'city' ? 700 : 600;
    const font = `${fontWeight} ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    context.font = font;
    const textWidth = Math.ceil(context.measureText(name).width);
    canvas.width = Math.max(96, textWidth + 32);
    canvas.height = 64;

    context.font = font;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.strokeStyle = 'rgba(4, 15, 27, 0.94)';
    context.lineWidth = level === 'city' ? 8 : 7;
    context.strokeText(name, canvas.width / 2, canvas.height / 2);
    context.fillStyle = level === 'city' ? '#7dd3fc' : '#dbe7f3';
    context.fillText(name, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
        toneMapped: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.center.set(0.5, 0.5);
    sprite.renderOrder = 20;
    return { sprite, aspect: canvas.width / canvas.height };
}

function buildMapLayer(geoJson: any, container: HTMLDivElement): MapLayer {
    const group = new THREE.Group();
    const geometryGroup = new THREE.Group();
    const boundaryMaterials: LineMaterial[] = [];
    const regionLabels: MapRegionLabel[] = [];
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
        const projectedRings: [number, number][][] = [];
        rings.forEach((ring) => {
            const projectedRing = ring
                .map(([lng, lat]) => projection([lng, lat]))
                .filter((point): point is [number, number] => point !== null);
            if (projectedRing.length < 2) return;
            projectedRings.push(projectedRing);

            const boundaryStyle = boundaryLevel === 'province'
                ? { color: 0xfbbf24, width: 1.8, opacity: 0.9, z: -0.18, order: 6 }
                : boundaryLevel === 'city'
                    ? { color: 0x38bdf8, width: 1.35, opacity: 0.2, z: -0.12, order: 5 }
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
        geometryGroup.add(cityGroup);

        const labelLevel = isDistrict
            ? 'district'
            : (boundaryLevel === 'city' && !hasDistrictFill ? 'city' : null);
        const labelPosition = labelLevel && properties?.name
            ? resolveRegionLabelPosition(properties, projectedRings)
            : null;
        if (labelLevel && labelPosition) {
            const label = createRegionLabel(String(properties.name), labelLevel);
            if (label) {
                label.sprite.position.set(
                    -labelPosition[0] * MAP_HORIZONTAL_SCALE,
                    0.72,
                    -labelPosition[1] * MAP_HORIZONTAL_SCALE,
                );
                group.add(label.sprite);
                regionLabels.push({
                    key: `${labelLevel}:${properties?.adcode ?? properties.name}`,
                    level: labelLevel,
                    sprite: label.sprite,
                    aspect: label.aspect,
                });
            }
        }
    });

    geometryGroup.scale.set(MAP_HORIZONTAL_SCALE, MAP_HORIZONTAL_SCALE, 1);
    geometryGroup.rotation.x = Math.PI / 2;
    group.add(geometryGroup);
    return { group, boundaryMaterials, regionLabels };
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
    const preloadMapRef = useRef<(
        slot: MapLayerSlot,
        scopeKey: string,
        mapKeys: string[],
    ) => Promise<void>>(async () => {});
    const activateMapRef = useRef<(
        slot: MapLayerSlot,
        scopeKey: string,
        mapKeys: string[],
    ) => Promise<void>>(async () => {});
    const clearMapRef = useRef<(slot: MapLayerSlot) => void>(() => {});
    controlsRef.current = controls;
    selectionRef.current = selection;
    onVisualReadyRef.current = onVisualReady;

    const preloadProvinceRegion = useCallback((provinceKey: string) => (
        preloadMapRef.current('province', provinceKey, [provinceKey])
    ), []);
    const setProvinceRegion = useCallback((provinceKey: string) => (
        activateMapRef.current('province', provinceKey, [provinceKey])
    ), []);
    const clearProvinceRegion = useCallback(() => clearMapRef.current('province'), []);
    const preloadDirectionRegions = useCallback((directionKey: string, mapKeys: string[]) => (
        preloadMapRef.current('direction', directionKey, mapKeys)
    ), []);
    const setDirectionRegions = useCallback((directionKey: string, mapKeys: string[]) => (
        activateMapRef.current('direction', directionKey, mapKeys)
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
            province: {
                activeLayer: null, activeSignature: '', stagedLayer: null, stagedSignature: '',
                generation: 0, request: null, pendingSignature: '', pendingPromise: null,
            },
            direction: {
                activeLayer: null, activeSignature: '', stagedLayer: null, stagedSignature: '',
                generation: 0, request: null, pendingSignature: '', pendingPromise: null,
            },
        };

        const updateRegionLabels = () => {
            const cameraHeight = Math.abs(camera.position.y);
            const seenLabelKeys = new Set<string>();
            (['province', 'direction'] as const).forEach((slot) => {
                mapLayers[slot].activeLayer?.regionLabels.forEach((label) => {
                    const duplicate = seenLabelKeys.has(label.key);
                    seenLabelKeys.add(label.key);
                    const fadeStart = label.level === 'city' ? 2200 : 1100;
                    const fadeEnd = label.level === 'city' ? 4800 : 2400;
                    const opacity = duplicate
                        ? 0
                        : 1 - THREE.MathUtils.smoothstep(cameraHeight, fadeStart, fadeEnd);
                    label.sprite.visible = opacity > 0.03;
                    label.sprite.material.opacity = opacity * (label.level === 'city' ? 0.95 : 0.82);

                    const screenStableHeight = THREE.MathUtils.clamp(cameraHeight * 0.025, 13, 42)
                        * (label.level === 'city' ? 1.12 : 1);
                    label.sprite.scale.set(
                        screenStableHeight * label.aspect,
                        screenStableHeight,
                        1,
                    );
                });
            });
        };

        const orbitControls = new OrbitControls(camera, renderer.domElement);
        orbitControls.enableDamping = true;
        orbitControls.enableRotate = true;
        orbitControls.target.set(0, 0, 0);
        orbitControls.minAzimuthAngle = Number.NEGATIVE_INFINITY;
        orbitControls.maxAzimuthAngle = Number.POSITIVE_INFINITY;
        orbitControls.minPolarAngle = Math.PI / 10;
        orbitControls.maxPolarAngle = Math.PI / 2 - 0.035;
        orbitControls.maxDistance = 8000;
        orbitControls.minDistance = 100;
        orbitControls.update();
        refs.controlsRef.current = orbitControls;

        scene.add(new THREE.AmbientLight(0xdbeafe, 0.82));
        const dirLight = new THREE.DirectionalLight(0xe0f2fe, 1.2);
        dirLight.position.set(-12, 24, 18);
        scene.add(dirLight);

        const releaseActiveMapLayer = (slot: MapLayerSlot) => {
            const state = mapLayers[slot];
            if (state.activeLayer) disposeMapLayer(state.activeLayer);
            state.activeLayer = null;
            state.activeSignature = '';
        };
        const releaseStagedMapLayer = (slot: MapLayerSlot) => {
            const state = mapLayers[slot];
            if (state.stagedLayer) disposeMapLayer(state.stagedLayer);
            state.stagedLayer = null;
            state.stagedSignature = '';
        };
        clearMapRef.current = (slot) => {
            const state = mapLayers[slot];
            state.generation += 1;
            state.request?.abort();
            state.request = null;
            state.pendingSignature = '';
            state.pendingPromise = null;
            releaseStagedMapLayer(slot);
            releaseActiveMapLayer(slot);
        };
        preloadMapRef.current = async (slot, scopeKey, requestedMapKeys) => {
            const state = mapLayers[slot];
            const mapKeys = [...new Set(requestedMapKeys)]
                .filter((key) => /^\d{6}$/.test(key))
                .sort();
            const signature = `${scopeKey}:${mapKeys.join(',')}`;
            if (mapKeys.length === 0 || signature === state.activeSignature || signature === state.stagedSignature) return;
            if (signature === state.pendingSignature && state.pendingPromise) return state.pendingPromise;

            const generation = ++state.generation;
            state.request?.abort();
            releaseStagedMapLayer(slot);
            const request = new AbortController();
            state.request = request;
            state.pendingSignature = signature;
            const pendingPromise = (async () => {
                const geoJson = await loadProvinceGeoJson(mapKeys, request.signal);
                if (disposed || generation !== state.generation) return;
                const nextLayer = buildMapLayer(geoJson, container);
                if (disposed || generation !== state.generation) {
                    disposeMapLayer(nextLayer);
                    return;
                }
                state.stagedLayer = nextLayer;
                state.stagedSignature = signature;
                console.info('[RM2 map preload]', {
                    slot,
                    scopeKey,
                    mapKeys,
                    objectCount: nextLayer.group.children.length,
                });
            })().finally(() => {
                if (generation !== state.generation) return;
                state.request = null;
                state.pendingSignature = '';
                state.pendingPromise = null;
            });
            state.pendingPromise = pendingPromise;
            return pendingPromise;
        };
        activateMapRef.current = async (slot, scopeKey, requestedMapKeys) => {
            const state = mapLayers[slot];
            const mapKeys = [...new Set(requestedMapKeys)]
                .filter((key) => /^\d{6}$/.test(key))
                .sort();
            const signature = `${scopeKey}:${mapKeys.join(',')}`;
            if (signature === state.activeSignature) return;
            if (mapKeys.length === 0) {
                clearMapRef.current(slot);
                return;
            }
            if (signature !== state.stagedSignature) {
                await preloadMapRef.current(slot, scopeKey, mapKeys);
            }
            if (disposed || signature !== state.stagedSignature || !state.stagedLayer) return;

            const previousLayer = state.activeLayer;
            const nextLayer = state.stagedLayer;
            scene.add(nextLayer.group);
            state.activeLayer = nextLayer;
            state.activeSignature = signature;
            state.stagedLayer = null;
            state.stagedSignature = '';
            if (previousLayer) disposeMapLayer(previousLayer);
            renderer.render(scene, camera);
            console.info('[RM2 map activate]', { slot, scopeKey, mapKeys });
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
            controlsRef.current.updateVehicleScaleForCamera(camera.position.y);
            updateRegionLabels();
            renderer.render(scene, camera);
        };
        animate();

        const onResize = () => {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
            (['province', 'direction'] as const).forEach((slot) => {
                [mapLayers[slot].activeLayer, mapLayers[slot].stagedLayer].forEach((layer) => {
                    layer?.boundaryMaterials.forEach((material) => {
                        material.resolution.set(container.clientWidth, container.clientHeight);
                    });
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
            preloadMapRef.current = async () => {};
            activateMapRef.current = async () => {};
            clearMapRef.current = () => {};
            (['province', 'direction'] as const).forEach((slot) => {
                const state = mapLayers[slot];
                state.generation += 1;
                state.request?.abort();
                state.request = null;
                releaseStagedMapLayer(slot);
                releaseActiveMapLayer(slot);
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
        preloadProvinceRegion,
        setProvinceRegion,
        clearProvinceRegion,
        preloadDirectionRegions,
        setDirectionRegions,
        clearDirectionRegions,
    };
}
