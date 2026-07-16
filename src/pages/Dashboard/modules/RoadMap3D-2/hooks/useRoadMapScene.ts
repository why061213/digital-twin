import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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
                geoJson.features.forEach((feature: any) => {
                    const { geometry, properties } = feature;
                    const isProvinceBoundary = properties?._boundaryOnly === true;
                    const isDistrict = properties?.level === 'district';
                    let rings: number[][][] = [];
                    if (geometry.type === 'Polygon') rings = [geometry.coordinates[0]];
                    else if (geometry.type === 'MultiPolygon') rings = geometry.coordinates.map((p: any) => p[0]);

                    const cityGroup = new THREE.Group();
                    rings.forEach((ring) => {
                        // 省份只画边界线，不填充
                        if (isProvinceBoundary) {
                            const points: THREE.Vector3[] = [];
                            ring.forEach(([lng, lat]) => {
                                const projected = projection([lng, lat]);
                                if (!projected) return;
                                const [x, y] = projected;
                                points.push(new THREE.Vector3(-x, -y, 0.62));
                            });
                            if (points.length < 2) return;
                            if (!points[0].equals(points[points.length - 1])) points.push(points[0].clone());
                            const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
                            const provinceLine = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({
                                color: 0xf59e0b, transparent: true, opacity: 0.5, linewidth: 1, depthWrite: false,
                            }));
                            cityGroup.add(provinceLine);
                            return;
                        }

                        const shape = new THREE.Shape();
                        ring.forEach(([lng, lat], index) => {
                            const projected = projection([lng, lat]);
                            if (!projected) return;
                            const [x, y] = projected;
                            if (index === 0) shape.moveTo(-x, -y);
                            else shape.lineTo(-x, -y);
                        });

                        const geom = new THREE.ExtrudeGeometry(shape, { depth: isDistrict ? 0.15 : 0.5, bevelEnabled: false });
                        const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
                            color: isDistrict ? '#1a2a3a' : '#2f465e',
                            emissive: isDistrict ? '#061018' : '#0b2234',
                            emissiveIntensity: isDistrict ? 0.04 : 0.12,
                            roughness: isDistrict ? 0.85 : 0.65,
                            metalness: isDistrict ? 0.05 : 0.18,
                            side: THREE.DoubleSide,
                        }));
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
                        edgeLine.position.z -= 0.018;
                        cityGroup.add(edgeLine);
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
