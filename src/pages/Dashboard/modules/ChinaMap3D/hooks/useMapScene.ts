import { useEffect } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { loadCityGeoJson, projection, mapPosition } from '../geo';
import { normalizeCityName, disposeObject3D, easeInOutCubic } from '../utils';
import {
    FOSHAN, FOSHAN_COORDS, MAP_ROTATION_Z,
    CITY_BASE_COLOR, CITY_BASE_EMISSIVE, CITY_ACTIVE_COLOR, CITY_ACTIVE_EMISSIVE,
    FOSHAN_COLOR, FOSHAN_EMISSIVE, CITY_EDGE_LINE_FLAG, RISE_HEIGHT,
} from '../constants';
import { octagonStartOffset } from '../utils';
import { useChinaMapRefs } from './useChinaMapRefs';

export function useMapScene(
    refs: ReturnType<typeof useChinaMapRefs>,
    services: {
        cities: {
            findCityKey: (cityName: string) => string | undefined;
            riseCity: (cityName: string) => void;
            updateCityData: (cityName: string, data: Record<string, any> | null) => void;
        };
        labels: { refreshWarehouseLabels: () => void; applyLabelVisibility: () => void };
        camera: { focusOnCities: (cityNames: string[], mode: 'overview' | 'focus') => void };
        flyLines: { addFlyLine: (lineId: string, fromCoords: [number, number], toCoords: [number, number]) => void; removeFlyLine: (lineId: string) => void };
        panels: { showCityPanels: (cityName: string, panels: any[]) => void };
        hover: { onMouseMove: (event: MouseEvent) => void; checkHover: () => void };
    }
) {
    useEffect(() => {
        const container = refs.containerRef.current;
        if (!container) return;

        let disposed = false;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#081320');
        scene.fog = new THREE.Fog('#081320', 58, 170);
        refs.sceneRef.current = scene;

        const initialFocus = mapPosition(FOSHAN_COORDS, 0) ?? new THREE.Vector3(0, 0, 0);
        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 10000);
        camera.up.set(0, 1, 0);
        camera.position.set(initialFocus.x + 10, 30, initialFocus.z - 18);
        camera.lookAt(initialFocus);
        refs.cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        refs.rendererRef.current = renderer;
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.enableRotate = true;
        controls.target.copy(initialFocus);
        controls.minAzimuthAngle = Number.NEGATIVE_INFINITY;
        controls.maxAzimuthAngle = Number.POSITIVE_INFINITY;
        controls.minPolarAngle = Math.PI / 10;
        controls.maxPolarAngle = Math.PI / 2 - 0.035;
        controls.minDistance = 8;
        controls.maxDistance = 220;
        controls.update();
        refs.controlsRef.current = controls;
        refs.initialCameraPoseRef.current = {
            position: camera.position.clone(),
            target: controls.target.clone(),
        };

        scene.add(new THREE.AmbientLight(0xdbeafe, 0.78));
        const keyLight = new THREE.DirectionalLight(0xe0f2fe, 1.45);
        keyLight.position.set(-12, 28, 18);
        scene.add(keyLight);
        const rimLight = new THREE.PointLight(0x22d3ee, 2.15, 145);
        rimLight.position.set(6, 12, -8);
        scene.add(rimLight);
        const warmLight = new THREE.PointLight(0xf59e0b, 0.75, 85);
        warmLight.position.set(-10, 10, 12);
        scene.add(warmLight);

        const labelRenderer = new CSS2DRenderer();
        labelRenderer.setSize(container.clientWidth, container.clientHeight);
        labelRenderer.domElement.style.position = 'absolute';
        labelRenderer.domElement.style.top = '0';
        labelRenderer.domElement.style.pointerEvents = 'none';
        labelRenderer.domElement.style.opacity = '0';
        labelRenderer.domElement.style.transition = 'opacity 180ms ease';
        container.appendChild(labelRenderer.domElement);
        refs.labelRendererRef.current = labelRenderer;

        const tooltipDiv = document.createElement('div');
        tooltipDiv.style.position = 'absolute';
        tooltipDiv.style.background = 'rgba(2,6,23,0.9)';
        tooltipDiv.style.color = '#e2e8f0';
        tooltipDiv.style.padding = '10px 12px';
        tooltipDiv.style.borderRadius = '8px';
        tooltipDiv.style.border = '1px solid rgba(103,232,249,0.22)';
        tooltipDiv.style.boxShadow = '0 18px 42px rgba(2,8,23,0.5)';
        tooltipDiv.style.backdropFilter = 'blur(10px)';
        tooltipDiv.style.fontSize = '12px';
        tooltipDiv.style.display = 'none';
        tooltipDiv.style.pointerEvents = 'none';
        tooltipDiv.style.zIndex = '200';
        container.appendChild(tooltipDiv);
        refs.tooltipRef.current = tooltipDiv;

        container.addEventListener('mousemove', services.hover.onMouseMove);

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
                const shouldRise = isFoShan;
                const depth = isFoShan ? 1.5 : 1;
                const color = isFoShan ? FOSHAN_COLOR : shouldRise ? CITY_ACTIVE_COLOR : CITY_BASE_COLOR;
                const emissive = isFoShan ? FOSHAN_EMISSIVE : shouldRise ? CITY_ACTIVE_EMISSIVE : CITY_BASE_EMISSIVE;

                let rings: number[][][] = [];
                if (geometry.type === 'Polygon') rings = [geometry.coordinates[0]];
                else if (geometry.type === 'MultiPolygon') rings = geometry.coordinates.map((poly: any) => poly[0]);

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
                    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
                        color,
                        emissive,
                        emissiveIntensity: isFoShan ? 0.44 : shouldRise ? 0.34 : 0.13,
                        roughness: 0.52,
                        metalness: shouldRise ? 0.34 : 0.24,
                        side: THREE.DoubleSide,
                    }));
                    cityGroup.add(mesh);

                    const edgeLine = new THREE.LineSegments(
                        new THREE.EdgesGeometry(geom, 32),
                        new THREE.LineBasicMaterial({
                            color: shouldRise ? 0x8beafe : 0x7dd3fc,
                            transparent: true,
                            opacity: shouldRise ? 0.38 : 0.16,
                            depthWrite: false,
                        })
                    );
                    edgeLine.position.z -= 0.018;
                    edgeLine.visible = !shouldRise;
                    edgeLine.userData.kind = CITY_EDGE_LINE_FLAG;
                    cityGroup.add(edgeLine);
                });

                const cityBox = new THREE.Box3().setFromObject(cityGroup);
                const cityCenter = cityBox.getCenter(new THREE.Vector3());
                const citySize = cityBox.getSize(new THREE.Vector3());
                const hash = Array.from(String(name)).reduce((sum, char) => sum + char.charCodeAt(0), 0);
                const labelAnchor = cityCenter.clone();
                labelAnchor.z += depth + 0.2;
                const labelSlots: Array<[number, number]> = [
                    [104, -70],
                    [-112, -70],
                    [114, 34],
                    [-120, 34],
                    [54, -106],
                    [-64, -106],
                    [126, -18],
                    [-132, -18],
                ];
                const baseSlot = labelSlots[hash % labelSlots.length];
                const sizeBoost = Math.min(Math.max(Math.max(citySize.x, citySize.y) * 1.25, 0), 16);
                const x = baseSlot[0] + Math.sign(baseSlot[0]) * sizeBoost;
                const y = baseSlot[1] + Math.sign(baseSlot[1]) * sizeBoost * 0.45;
                cityGroup.userData.labelAnchor = labelAnchor;
                cityGroup.userData.labelLayout = { x, y, align: x < 0 ? 'right' : 'left', startOffset: octagonStartOffset(0) };

                if (shouldRise) {
                    const marker = new THREE.Mesh(
                        new THREE.SphereGeometry(isFoShan ? 0.22 : 0.16, 18, 18),
                        new THREE.MeshBasicMaterial({
                            color: isFoShan ? 0xfbbf24 : 0x67e8f9,
                            transparent: true,
                            opacity: 0.88,
                            depthWrite: false,
                        })
                    );
                    marker.position.copy(labelAnchor);
                    cityGroup.add(marker);
                }

                group.add(cityGroup);
                refs.meshMapRef.current[name] = cityGroup;
                refs.cityStatusRef.current.set(name, shouldRise ? 1 : 0);
            });

            if (!refs.meshMapRef.current[foShanName]) {
                refs.pendingRaisedCitiesRef.current.add(FOSHAN);
            }

            group.rotation.set(Math.PI / 2, 0, MAP_ROTATION_Z);
            scene.add(group);
            refs.mapGroupRef.current = group;

            refs.pendingRaisedCitiesRef.current.forEach((cityName) => {
                if (normalizeCityName(cityName).includes(FOSHAN)) return;
                window.setTimeout(() => services.cities.riseCity(cityName), 120);
            });

            refs.pendingCityDataRef.current.forEach((data, cityName) => {
                services.cities.updateCityData(cityName, data);
            });
            refs.pendingCityDataRef.current.clear();

            refs.pendingCityPanelsRef.current.forEach((panels, cityName) => {
                const matchedKey = services.cities.findCityKey(cityName);
                if (!matchedKey) return;
                const pendingStyle =
                    refs.pendingCityPanelStylesRef.current.get(cityName) ??
                    refs.pendingCityPanelStylesRef.current.get(normalizeCityName(cityName)) ??
                    refs.pendingCityPanelStylesRef.current.get(matchedKey) ??
                    refs.pendingCityPanelStylesRef.current.get(normalizeCityName(matchedKey));

                refs.pendingCityPanelsRef.current.delete(cityName);
                refs.pendingCityPanelsRef.current.delete(normalizeCityName(cityName));
                refs.pendingCityPanelsRef.current.delete(matchedKey);
                refs.pendingCityPanelsRef.current.delete(normalizeCityName(matchedKey));
                refs.pendingCityPanelStylesRef.current.delete(cityName);
                refs.pendingCityPanelStylesRef.current.delete(normalizeCityName(cityName));
                refs.pendingCityPanelStylesRef.current.delete(matchedKey);
                refs.pendingCityPanelStylesRef.current.delete(normalizeCityName(matchedKey));
                window.setTimeout(() => {
                    refs.showCityPanelsRef.current(matchedKey, panels, pendingStyle);
                }, 0);
            });

            const pendingCameraControl = refs.pendingCameraControlRef.current;
            if (pendingCameraControl) {
                refs.pendingCameraControlRef.current = null;
                window.setTimeout(() => {
                    services.camera.focusOnCities(pendingCameraControl.cityNames, pendingCameraControl.mode);
                }, 160);
            }
        });

        const render = () => {
            controls.update();
            renderer.render(scene, camera);
            if (refs.labelRendererRef.current) {
                refs.labelRendererRef.current.render(scene, camera);
            }
            const cameraState = [
                camera.position.x.toFixed(2), camera.position.y.toFixed(2), camera.position.z.toFixed(2),
                controls.target.x.toFixed(2), controls.target.y.toFixed(2), controls.target.z.toFixed(2),
            ].join(',');
            if (cameraState !== refs.lastCameraStateRef.current) {
                refs.lastCameraStateRef.current = cameraState;
                if (!refs.isCameraMovingRef.current) {
                    refs.isCameraMovingRef.current = true;
                    services.labels.applyLabelVisibility();
                }
                if (refs.labelRevealTimeoutRef.current !== null) window.clearTimeout(refs.labelRevealTimeoutRef.current);
                refs.labelRevealTimeoutRef.current = window.setTimeout(() => {
                    refs.isCameraMovingRef.current = false;
                    if (refs.labelVisibilityRef.current.mode !== 'focus') {
                        services.labels.refreshWarehouseLabels();
                    } else {
                        services.labels.applyLabelVisibility();
                    }
                    refs.labelRevealTimeoutRef.current = null;
                }, 260);
            }
            const now = performance.now();
            if (refs.labelVisibilityRef.current.mode !== 'focus' && now - refs.lastLabelRefreshRef.current > 360) {
                refs.lastLabelRefreshRef.current = now;
                services.labels.refreshWarehouseLabels();
            }
            services.hover.checkHover();
            refs.renderFrameRef.current = requestAnimationFrame(render);
        };
        render();

        const handleResize = () => {
            const width = container.clientWidth;
            const height = container.clientHeight;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
            refs.labelRendererRef.current?.setSize(width, height);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            disposed = true;
            cancelAnimationFrame(refs.renderFrameRef.current);
            cancelAnimationFrame(refs.cameraMoveFrameRef.current);
            if (refs.cameraFocusTimeoutRef.current !== null) window.clearTimeout(refs.cameraFocusTimeoutRef.current);
            if (refs.labelRevealTimeoutRef.current !== null) window.clearTimeout(refs.labelRevealTimeoutRef.current);
            if (refs.warehouseTourTimeoutRef.current !== null) window.clearTimeout(refs.warehouseTourTimeoutRef.current);
            refs.warehouseTourRunRef.current += 1;
            refs.cityAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            refs.flyAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            refs.flyTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
            refs.flyRemovalTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
            refs.cityPanelChartsRef.current.forEach((charts) => charts.forEach((chart) => chart.dispose()));
            refs.cityPanelChartsRef.current.clear();
            refs.cityPanelDataRef.current.clear();
            refs.cityPanelMapRef.current.forEach((panel) => panel.remove());
            refs.cityPanelMapRef.current.clear();
            refs.flyLinesRef.current.forEach((line) => disposeObject3D(line));
            if (refs.mapGroupRef.current) disposeObject3D(refs.mapGroupRef.current);
            window.removeEventListener('resize', handleResize);
            container.removeEventListener('mousemove', services.hover.onMouseMove);
            controls.dispose();
            renderer.dispose();
            refs.labelRendererRef.current?.domElement.remove();
            refs.tooltipRef.current?.remove();
            renderer.domElement.remove();
            refs.sceneRef.current = null;
            refs.rendererRef.current = null;
            refs.cameraRef.current = null;
            refs.controlsRef.current = null;
            refs.initialCameraPoseRef.current = null;
            refs.pendingCameraControlRef.current = null;
            refs.meshMapRef.current = {};
            refs.cityStatusRef.current.clear();
            refs.cityAnimFramesRef.current.clear();
            refs.flyAnimFramesRef.current.clear();
            refs.flyTimeoutsRef.current.clear();
            refs.flyRemovalTimeoutsRef.current.clear();
            refs.flyLinesRef.current.clear();
            refs.flyStartTimesRef.current.clear();
            refs.pendingFlyRemovalRef.current.clear();
            refs.activeRouteCoordsRef.current.clear();
        };
    }, [refs, services]);
}
