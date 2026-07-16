import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { loadCityGeoJson, MAP_HORIZONTAL_SCALE, projection } from '../geo';
import { useRoadMapRefs } from './useRoadMapRefs';
import { useRoadControls } from './useRoadControls';
import { useRoadSelection } from './useRoadSelection';

export function useRoadMapScene(
    refs: ReturnType<typeof useRoadMapRefs>,
    controls: ReturnType<typeof useRoadControls>,
    selection: ReturnType<typeof useRoadSelection>,
    onVisualReady?: () => void,
) {
    const controlsRef = useRef(controls);
    const selectionRef = useRef(selection);
    const onVisualReadyRef = useRef(onVisualReady);
    controlsRef.current = controls;
    selectionRef.current = selection;
    onVisualReadyRef.current = onVisualReady;

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
        const boundaryMaterials: LineMaterial[] = [];

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

        loadCityGeoJson()
            .then((geoJson) => {
                if (disposed) return;
                const group = new THREE.Group();
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
                    let rings: number[][][] = [];
                    if (geometry.type === 'Polygon') rings = [geometry.coordinates[0]];
                    else if (geometry.type === 'MultiPolygon') rings = geometry.coordinates.map((p: any) => p[0]);
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
                        if (firstX !== lastX || firstY !== lastY) {
                            positions.push(-firstX, -firstY, boundaryStyle.z);
                        }

                        if (isProvinceBoundary) {
                            const provinceGeometry = new THREE.BufferGeometry();
                            provinceGeometry.setAttribute(
                                'position',
                                new THREE.Float32BufferAttribute(positions, 3)
                            );
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

                        // 区县面已经覆盖城市时，城市只承担市界线，避免两层共面闪烁。
                        if (hasDistrictFill) return;

                        const shape = new THREE.Shape();
                        projectedRing.forEach(([x, y], index) => {
                            if (index === 0) shape.moveTo(-x, -y);
                            else shape.lineTo(-x, -y);
                        });

                        const geom = new THREE.ExtrudeGeometry(shape, { depth: isDistrict ? 0.1 : 0.16, bevelEnabled: false });
                        const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
                            color: isDistrict ? '#1b3042' : '#29465f',
                            emissive: isDistrict ? '#07131c' : '#0b2234',
                            emissiveIntensity: isDistrict ? 0.05 : 0.1,
                            roughness: 0.82,
                            metalness: 0.05,
                            side: THREE.DoubleSide,
                        }));
                        mesh.position.z = isDistrict ? -0.012 : 0;
                        mesh.renderOrder = isDistrict ? 2 : 1;
                        cityGroup.add(mesh);
                    });
                    group.add(cityGroup);
                });
                // The source shapes live in local X/Y; after rotation those become scene X/Z.
                group.scale.set(MAP_HORIZONTAL_SCALE, MAP_HORIZONTAL_SCALE, 1);
                group.rotation.x = Math.PI / 2;
                scene.add(group);
                window.requestAnimationFrame(() => {
                    if (disposed) return;
                    renderer.render(scene, camera);
                    window.requestAnimationFrame(() => {
                        if (!disposed) onVisualReadyRef.current?.();
                    });
                });
            })
            .catch((err) => console.error('Map data failed to load', err));

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
            boundaryMaterials.forEach((material) => {
                material.resolution.set(container.clientWidth, container.clientHeight);
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
}
