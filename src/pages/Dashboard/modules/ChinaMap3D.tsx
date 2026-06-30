import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { geoMercator } from 'd3-geo';

export type ChinaMap3DHandle = {
    riseCity: (cityName: string) => void;
    fallCity: (cityName: string) => void;
    flyToCity: (cityName: string) => void;
    addFlyLine: (lineId: string, fromCoords: [number, number], toCoords: [number, number]) => void;
    removeFlyLine: (lineId: string) => void;
    updateCityData: (cityName: string, data: Record<string, any> | null) => void;
    focusOnCities: (cityNames: string[], mode: CameraFocusMode) => void;
};
type CameraFocusMode = 'overview' | 'focus';

const BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const DIRECT_CITY_ADCODES = [
    110000, 120000, 310000, 500000, 710000, 810000, 820000
];
const RISE_HEIGHT = -1;
const FOSHAN = '佛山';
const FOSHAN_COORDS: [number, number] = [113.121416, 23.021548];
const CITY_RISE_DELAY = 500;
const CITY_RISE_DURATION = 1200;
const FLY_LINE_DELAY = CITY_RISE_DELAY + CITY_RISE_DURATION + 120;
const MAP_ROTATION_Z = 0;
const FLY_GROW_DURATION = 1300;
const FLY_TRAVEL_DURATION = 2400;
const FLY_MIN_LIFETIME = FLY_GROW_DURATION + FLY_TRAVEL_DURATION * 2;
const CITY_BASE_COLOR = '#2f465e';
const CITY_BASE_EMISSIVE = '#0b2234';
const CITY_ACTIVE_COLOR = '#22d3ee';
const CITY_ACTIVE_EMISSIVE = '#0e7490';
const FOSHAN_COLOR = '#f59e0b';
const FOSHAN_EMISSIVE = '#7c2d12';
const CAMERA_TILT_RATIO = 0.5;

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
                // ignore
            }
        })
    );

    return { type: 'FeatureCollection', features: [...municipalityFeatures, ...cityFeatures] };
}

function normalizeCityName(cityName: string) {
    return cityName.endsWith('市') ? cityName.slice(0, -1) : cityName;
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

type LabelLayout = {
    x: number;
    y: number;
    align: 'left' | 'right';
};

type MarkedWarehouse = {
    name: string;
    group: THREE.Group;
    anchor: THREE.Vector3;
    screen: THREE.Vector2;
    data: Record<string, any>;
};

const LABEL_NEIGHBOR_RADIUS = 128;
const LABEL_MIN_DISTANCE = 78;
const LABEL_MAX_DISTANCE = 140;
const LABEL_CARD_WIDTH = 132;
const LABEL_CARD_HEIGHT = 56;
const LABEL_CITY_SAFE_MARGIN = 22;

function equalCircleOverlapRatio(distance: number, radius: number) {
    if (distance >= radius * 2) return 0;
    if (distance <= 0) return 1;
    const clamped = Math.min(Math.max(distance, 0), radius * 2);
    const area = 2 * radius * radius * Math.acos(clamped / (2 * radius))
        - 0.5 * clamped * Math.sqrt(Math.max(0, 4 * radius * radius - clamped * clamped));
    return area / (Math.PI * radius * radius);
}

function warehouseLabelHtml(cityName: string, data: Record<string, any>, layout: LabelLayout) {
    const label = data.label || cityName;
    const cardTransform = layout.align === 'right' ? 'translateX(-100%)' : 'none';
    const sign = layout.x < 0 ? -1 : 1;
    const cardEdgeX = layout.x;
    const cardEdgeY = layout.y + 24;
    const lineEndX = cardEdgeX - sign * 8;
    const absX = Math.abs(lineEndX);
    const absY = Math.abs(cardEdgeY);
    let pathPoints: Array<[number, number]>;
    if (absX < 18 || absY < 18) {
        pathPoints = [[0, 0], [lineEndX, cardEdgeY]];
    } else if (absX < 42) {
        pathPoints = [[0, 0], [0, cardEdgeY], [lineEndX, cardEdgeY]];
    } else if (absY < 42) {
        pathPoints = [[0, 0], [lineEndX, 0], [lineEndX, cardEdgeY]];
    } else {
        const elbowX = sign * Math.min(42, Math.max(24, absX * 0.38));
        pathPoints = [[0, 0], [elbowX, 0], [elbowX, cardEdgeY], [lineEndX, cardEdgeY]];
    }
    const minX = Math.min(...pathPoints.map(([x]) => x)) - 8;
    const minY = Math.min(...pathPoints.map(([, y]) => y)) - 8;
    const maxX = Math.max(...pathPoints.map(([x]) => x)) + 8;
    const maxY = Math.max(...pathPoints.map(([, y]) => y)) + 8;
    const points = pathPoints.map(([x, y]) => `${x - minX},${y - minY}`).join(' ');
    const endDot = pathPoints[pathPoints.length - 1];
    return `
        <span style="position:absolute;left:-4px;top:-4px;width:8px;height:8px;border-radius:999px;background:#67e8f9;box-shadow:0 0 16px rgba(103,232,249,0.95)"></span>
        <svg style="position:absolute;left:${minX}px;top:${minY}px;width:${maxX - minX}px;height:${maxY - minY}px;overflow:visible;pointer-events:none;z-index:1">
            <polyline points="${points}" fill="none" stroke="rgba(103,232,249,0.58)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
        </svg>
        <span style="position:absolute;left:${endDot[0] - 3}px;top:${endDot[1] - 3}px;width:6px;height:6px;border-radius:999px;background:rgba(103,232,249,0.92);box-shadow:0 0 10px rgba(103,232,249,0.76);z-index:2"></span>
        <span style="
            position:absolute;
            left:${layout.x}px;
            top:${layout.y}px;
            transform:${cardTransform};
            display:block;
            z-index:2;
            min-width:112px;
            border:1px solid rgba(103,232,249,0.32);
            border-radius:7px;
            background:linear-gradient(180deg, rgba(15,23,42,0.94), rgba(8,13,24,0.82));
            box-shadow:0 14px 34px rgba(8,47,73,0.46), inset 0 1px 0 rgba(255,255,255,0.08);
            padding:7px 10px 8px;
            text-shadow:0 1px 10px rgba(8,47,73,0.9);
            white-space:nowrap;
        ">
            <span style="display:block;color:#cffafe;font-size:12px;font-weight:700;line-height:16px">${label}</span>
            <span style="display:block;color:#94a3b8;font-size:10px;line-height:13px">库存 ${data.inventory ?? '--'} 吨</span>
        </span>
    `;
}

function projectToScreen(point: THREE.Vector3, camera: THREE.Camera, container: HTMLDivElement) {
    const projected = point.clone().project(camera);
    return new THREE.Vector2(
        (projected.x * 0.5 + 0.5) * container.clientWidth,
        (-projected.y * 0.5 + 0.5) * container.clientHeight
    );
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
    const lastLabelRefreshRef = useRef(0);
    const lastCameraStateRef = useRef('');
    const labelRevealTimeoutRef = useRef<number | null>(null);
    const cameraMoveFrameRef = useRef<number>(0);
    const cameraFocusTimeoutRef = useRef<number | null>(null);
    const pendingRaisedCitiesRef = useRef<Set<string>>(new Set([FOSHAN]));


    // 标签相关
    const labelRendererRef = useRef<CSS2DRenderer | null>(null);
    const cityLabelMapRef = useRef<Map<string, CSS2DObject>>(new Map());
    const pendingCityDataRef = useRef<Map<string, Record<string, any> | null>>(new Map());
    const tooltipRef = useRef<HTMLDivElement | null>(null);
    const mouseRef = useRef(new THREE.Vector2());
    const raycasterRef = useRef(new THREE.Raycaster());
    const hoveredCityRef = useRef<THREE.Group | null>(null);

    const findCityKey = useCallback((cityName: string) => {
        const normalized = normalizeCityName(cityName);
        return Object.keys(meshMapRef.current).find((name) => normalizeCityName(name).includes(normalized));
    }, []);

    const refreshWarehouseLabels = useCallback(() => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        const container = containerRef.current;
        if (!camera || !controls || !container) return;
        const cameraDistance = camera.position.distanceTo(controls.target);
        const zoomScale = THREE.MathUtils.clamp(36 / Math.max(cameraDistance, 1), 0.5, 1.08);

        const entries = Object.entries(meshMapRef.current)
            .map(([name, group]) => {
                const anchor = group.userData.labelAnchor as THREE.Vector3 | undefined;
                const data = group.userData.displayData as Record<string, any> | undefined;
                return {
                    name,
                    group,
                    anchor,
                    screen: anchor ? projectToScreen(anchor, camera, container) : undefined,
                    data,
                };
            })
            .filter((item): item is MarkedWarehouse => Boolean(item.anchor && item.screen && item.data));

        if (entries.length === 0) return;

        const screenCenter = new THREE.Vector2(container.clientWidth / 2, container.clientHeight / 2);
        const clusters = new Map<string, Set<string>>();
        const findCluster = (name: string) => {
            const existing = clusters.get(name);
            if (existing) return existing;
            const next = new Set<string>([name]);
            clusters.set(name, next);
            return next;
        };

        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const a = entries[i];
                const b = entries[j];
                const distance = a.screen.distanceTo(b.screen);
                if (distance > LABEL_NEIGHBOR_RADIUS) continue;

                const clusterA = findCluster(a.name);
                const clusterB = findCluster(b.name);
                if (clusterA !== clusterB) {
                    clusterB.forEach((name) => {
                        clusterA.add(name);
                        clusters.set(name, clusterA);
                    });
                }
            }
        }

        entries.forEach((item) => {
            let density = 0;
            let nearestDistance = Number.POSITIVE_INFINITY;
            const current = item.screen.clone();
            const cluster = findCluster(item.name);
            const clusterItems = entries.filter((entry) => cluster.has(entry.name));
            const clusterCenter = clusterItems.reduce(
                (acc, entry) => acc.add(entry.screen.clone()),
                new THREE.Vector2()
            ).multiplyScalar(1 / clusterItems.length);
            const localRepulsion = new THREE.Vector2();
            const overlapRepulsion = new THREE.Vector2();
            const globalRepulsion = new THREE.Vector2();

            entries.forEach((other) => {
                if (other.name === item.name) return;
                const otherPoint = other.screen;
                const delta = current.clone().sub(otherPoint);
                const distance = Math.max(delta.length(), 0.001);
                const direction = delta.clone().normalize();
                const localWeight = cluster.has(other.name)
                    ? Math.pow(Math.max(0, LABEL_NEIGHBOR_RADIUS - distance) / LABEL_NEIGHBOR_RADIUS, 2)
                    : 0;
                const overlapWeight = equalCircleOverlapRatio(distance, LABEL_NEIGHBOR_RADIUS) * 1.5;
                const globalWeight = Math.exp(-distance / 260) * 0.08;
                density += Math.exp(-distance / LABEL_NEIGHBOR_RADIUS) + overlapWeight * 0.55;
                localRepulsion.add(direction.clone().multiplyScalar(localWeight * 4));
                overlapRepulsion.add(direction.clone().multiplyScalar(overlapWeight));
                globalRepulsion.add(direction.multiplyScalar(globalWeight));
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                }
            });

            const clusterOutward = current.clone().sub(clusterCenter);
            if (clusterOutward.lengthSq() < 0.001) {
                clusterOutward.copy(current.clone().sub(screenCenter));
            }
            if (clusterOutward.lengthSq() < 0.001) {
                clusterOutward.set(1, -0.35);
            }
            clusterOutward.normalize();

            const outward = current.clone().sub(screenCenter);
            if (outward.lengthSq() < 0.001) {
                outward.set(1, -0.35);
            }
            outward.normalize();
            const direction = clusterOutward
                .multiplyScalar(clusterItems.length > 1 ? 1.6 : 0.45)
                .add(localRepulsion)
                .add(overlapRepulsion.multiplyScalar(1.15))
                .add(globalRepulsion)
                .add(outward.multiplyScalar(-1.5));
            if (direction.lengthSq() < 0.001) {
                direction.copy(outward);
            }
            direction.normalize();

            const hash = Array.from(item.name).reduce((sum, char) => sum + char.charCodeAt(0), 0);
            const rawLabelDistance = THREE.MathUtils.clamp(
                LABEL_MIN_DISTANCE + density * 18 + Math.max(0, LABEL_NEIGHBOR_RADIUS - nearestDistance) * 0.22,
                LABEL_MIN_DISTANCE,
                LABEL_MAX_DISTANCE
            );
            const labelDistance = THREE.MathUtils.clamp(rawLabelDistance * zoomScale, 46, LABEL_MAX_DISTANCE);
            let x = direction.x * labelDistance;
            const verticalBias = Math.abs(direction.y) < 0.22 ? ((hash % 3) - 1) * 14 : 0;
            let y = direction.y * labelDistance * 0.78 + verticalBias;
            let align: 'left' | 'right' = x < 0 ? 'right' : 'left';

            for (let pass = 0; pass < 3; pass++) {
                const cardLeft = current.x + x + (align === 'right' ? -LABEL_CARD_WIDTH : 0);
                const cardRight = cardLeft + LABEL_CARD_WIDTH;
                const cardTop = current.y + y;
                const cardBottom = cardTop + LABEL_CARD_HEIGHT;
                const cardCenter = new THREE.Vector2((cardLeft + cardRight) / 2, (cardTop + cardBottom) / 2);

                entries.forEach((other) => {
                    if (other.name === item.name) return;
                    const insideX = other.screen.x > cardLeft - LABEL_CITY_SAFE_MARGIN && other.screen.x < cardRight + LABEL_CITY_SAFE_MARGIN;
                    const insideY = other.screen.y > cardTop - LABEL_CITY_SAFE_MARGIN && other.screen.y < cardBottom + LABEL_CITY_SAFE_MARGIN;
                    if (!insideX || !insideY) return;

                    const away = cardCenter.clone().sub(other.screen);
                    if (away.lengthSq() < 0.001) {
                        away.set(x || 1, y || -1);
                    }
                    away.normalize();
                    const horizontalPush = (LABEL_CARD_WIDTH / 2 + LABEL_CITY_SAFE_MARGIN) - Math.abs(other.screen.x - cardCenter.x);
                    const verticalPush = (LABEL_CARD_HEIGHT / 2 + LABEL_CITY_SAFE_MARGIN) - Math.abs(other.screen.y - cardCenter.y);
                    if (verticalPush > 0) {
                        y += Math.sign(away.y || -1) * Math.min(34, verticalPush * 0.8);
                    }
                    if (horizontalPush > 0) {
                        x += Math.sign(away.x || (x >= 0 ? 1 : -1)) * Math.min(30, horizontalPush * 0.45);
                    }
                    align = x < 0 ? 'right' : 'left';
                });
            }

            item.group.userData.labelLayout = { x, y, align } satisfies LabelLayout;
            const labelObj = cityLabelMapRef.current.get(item.name);
            if (labelObj) {
                (labelObj.element as HTMLDivElement).innerHTML = warehouseLabelHtml(item.name, item.data, item.group.userData.labelLayout);
                labelObj.position.copy(item.anchor);
            }
        });
    }, []);

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
            const span = Math.max(size.x, size.z, 1);
            const targetHeight = THREE.MathUtils.clamp(
                Math.max(neededHeightByDepth, neededHeightByWidth) * 1.42 + 10,
                22,
                98
            );
            const tilt = THREE.MathUtils.clamp(span * CAMERA_TILT_RATIO + 8, 14, 42);

            const startPosition = camera.position.clone();
            const startTarget = controls.target.clone();
            const viewDirection = new THREE.Vector3(
                camera.position.x - controls.target.x,
                0,
                camera.position.z - controls.target.z
            );
            if (viewDirection.lengthSq() < 0.001) {
                viewDirection.set(-0.38, 0, 1);
            }
            viewDirection.normalize();
            const targetPosition = new THREE.Vector3(
                center.x + viewDirection.x * tilt,
                targetHeight,
                center.z + viewDirection.z * tilt
            );
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
                    material.color.set(isFoShan ? FOSHAN_COLOR : CITY_ACTIVE_COLOR);
                    material.emissive.set(isFoShan ? FOSHAN_EMISSIVE : CITY_ACTIVE_EMISSIVE);
                    material.emissiveIntensity = isFoShan ? 0.42 : 0.34;
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
                    material.color.set(CITY_BASE_COLOR);
                    material.emissive.set(CITY_BASE_EMISSIVE);
                    material.emissiveIntensity = 0.08;
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

    const updateCityData = useCallback((cityName: string, data: Record<string, any> | null) => {
        const matchedKey = findCityKey(cityName);
        if (!matchedKey) {
            pendingCityDataRef.current.set(normalizeCityName(cityName), data);
            return;
        }
        const group = meshMapRef.current[matchedKey];
        if (!group) return;

        if (data) {
            group.userData.displayData = data;
            if (!cityLabelMapRef.current.has(matchedKey)) {
                const div = document.createElement('div');
                const layout = group.userData.labelLayout as LabelLayout | undefined;
                div.innerHTML = warehouseLabelHtml(cityName, data, layout ?? {
                    x: 96,
                    y: -58,
                    align: 'left',
                });
                div.style.color = '#dffafe';
                div.style.letterSpacing = '0';
                div.style.whiteSpace = 'nowrap';
                div.style.position = 'relative';
                div.style.width = '0';
                div.style.height = '0';
                div.style.pointerEvents = 'none';
                const labelObj = new CSS2DObject(div);
                labelObj.position.copy(group.userData.labelAnchor ?? new THREE.Vector3(0, 1.2, 0));
                group.add(labelObj);
                cityLabelMapRef.current.set(matchedKey, labelObj);
            } else {
                const existingLabel = cityLabelMapRef.current.get(matchedKey);
                if (existingLabel) {
                    const layout = group.userData.labelLayout as LabelLayout | undefined;
                    (existingLabel.element as HTMLDivElement).innerHTML = warehouseLabelHtml(cityName, data, layout ?? {
                        x: 96,
                        y: -58,
                        align: 'left',
                    });
                    existingLabel.position.copy(group.userData.labelAnchor ?? new THREE.Vector3(0, 1.2, 0));
                }
            }
            refreshWarehouseLabels();
        } else {
            if (cityLabelMapRef.current.has(matchedKey)) {
                const labelObj = cityLabelMapRef.current.get(matchedKey);
                if (labelObj) {
                    group.remove(labelObj);
                    labelObj.element.remove();
                }
                cityLabelMapRef.current.delete(matchedKey);
            }
            delete group.userData.displayData;
            refreshWarehouseLabels();
        }
    }, [findCityKey, refreshWarehouseLabels]);

    const checkHover = useCallback(() => {
        const camera = cameraRef.current;
        const scene = sceneRef.current;
        if (!camera || !scene) return;

        raycasterRef.current.setFromCamera(mouseRef.current, camera);
        const targets = Object.values(meshMapRef.current);
        const intersects = raycasterRef.current.intersectObjects(targets, true);

        let newHoveredCity: THREE.Group | null = null;
        if (intersects.length > 0) {
            let obj: THREE.Object3D | null = intersects[0].object;
            while (obj && !(obj instanceof THREE.Group && targets.includes(obj))) {
                obj = obj.parent;
            }
            if (obj && obj instanceof THREE.Group && targets.includes(obj)) {
                newHoveredCity = obj;
            }
        }

        if (tooltipRef.current) {
            if (newHoveredCity !== hoveredCityRef.current) {
                hoveredCityRef.current = newHoveredCity;
                if (newHoveredCity && newHoveredCity.userData.displayData) {
                    const data = newHoveredCity.userData.displayData;
                    tooltipRef.current.innerHTML = `
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:7px">
                            <strong style="color:#cffafe;font-size:13px">${data.label || newHoveredCity.name}</strong>
                            <span style="border:1px solid rgba(52,211,153,0.28);background:rgba(16,185,129,0.12);color:#bbf7d0;border-radius:4px;padding:1px 6px;font-size:11px">${data.status}</span>
                        </div>
                        <div style="display:grid;grid-template-columns:70px 1fr;gap:5px 12px">
                            <span style="color:#94a3b8">库存</span><span style="text-align:right;color:#f8fafc">${data.inventory} 吨</span>
                            <span style="color:#94a3b8">今日入库</span><span style="text-align:right;color:#67e8f9">${data.todayIn} 吨</span>
                            <span style="color:#94a3b8">今日出库</span><span style="text-align:right;color:#fbbf24">${data.todayOut} 吨</span>
                        </div>
                    `;
                    tooltipRef.current.style.display = 'block';
                } else {
                    tooltipRef.current.style.display = 'none';
                }
            }
        }
    }, []);

    const onMouseMove = useCallback((event: MouseEvent) => {
        const container = containerRef.current;
        if (!container) return;

        const rect = container.getBoundingClientRect();
        mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        if (tooltipRef.current) {
            tooltipRef.current.style.left = event.clientX + 12 + 'px';
            tooltipRef.current.style.top = event.clientY + 12 + 'px';
        }
    }, []);

// 通用聚焦函数（复用之前的逻辑）
    const focusPoints = useCallback((points: THREE.Vector3[]) => {
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
        const targetHeight = THREE.MathUtils.clamp(
            Math.max(neededHeightByDepth, neededHeightByWidth) * 1.6 + 10,
            22,
            98
        );

        // 目标点（地面）
        const targetLookAt = new THREE.Vector3(center.x, 0, center.z);

        // 相机放在目标点南方（Z 轴负方向），高度为 targetHeight
        const southOffset = targetHeight * 0.8;  // 可调节视角倾斜度，0.8 约为 38° 俯角
        const targetPosition = new THREE.Vector3(
            center.x,
            targetHeight,
            center.z - southOffset
        );

        const startPosition = camera.position.clone();
        const startTarget = controls.target.clone();
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
    }, []);

    const focusOnCities = useCallback((cityNames: string[], mode: CameraFocusMode) => {
        const points: THREE.Vector3[] = [];

        const collectCityCenter = (cityName: string) => {
            const key = findCityKey(cityName);
            const group = key ? meshMapRef.current[key] : undefined;
            if (group) {
                const box = new THREE.Box3().setFromObject(group);
                if (!box.isEmpty()) {
                    points.push(box.getCenter(new THREE.Vector3()));
                }
            }
        };

        if (mode === 'overview') {
            // 收集所有指定城市 + 佛山
            for (const name of cityNames) collectCityCenter(name);
            collectCityCenter(FOSHAN);
        } else if (mode === 'focus' && cityNames.length === 1) {
            collectCityCenter(cityNames[0]);
        }

        if (points.length > 0) {
            focusPoints(points);
        }
    }, [findCityKey, focusPoints]);

    useImperativeHandle(ref, () => ({
        riseCity,
        fallCity,
        flyToCity: riseCity,
        addFlyLine,
        removeFlyLine,
        updateCityData,
        focusOnCities,
    }), [riseCity, fallCity, addFlyLine, removeFlyLine, updateCityData, focusOnCities]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        let disposed = false;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#081320');
        scene.fog = new THREE.Fog('#081320', 58, 170);
        sceneRef.current = scene;

        const initialFocus = mapPosition(FOSHAN_COORDS, 0) ?? new THREE.Vector3(0, 0, 0);
        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 10000);
        camera.up.set(0, 1, 0);
        camera.position.set(initialFocus.x + 10, 30, initialFocus.z - 18);
        camera.lookAt(initialFocus);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        rendererRef.current = renderer;
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
        controlsRef.current = controls;

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

        // 标签渲染器
        const labelRenderer = new CSS2DRenderer();
        labelRenderer.setSize(container.clientWidth, container.clientHeight);
        labelRenderer.domElement.style.position = 'absolute';
        labelRenderer.domElement.style.top = '0';
        labelRenderer.domElement.style.pointerEvents = 'none';
        labelRenderer.domElement.style.opacity = '1';
        labelRenderer.domElement.style.transition = 'opacity 180ms ease';
        container.appendChild(labelRenderer.domElement);
        labelRendererRef.current = labelRenderer;

        // Tooltip
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
        tooltipRef.current = tooltipDiv;

        container.addEventListener('mousemove', onMouseMove);

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
                const color = isFoShan ? FOSHAN_COLOR : shouldRise ? CITY_ACTIVE_COLOR : CITY_BASE_COLOR;
                const emissive = isFoShan ? FOSHAN_EMISSIVE : shouldRise ? CITY_ACTIVE_EMISSIVE : CITY_BASE_EMISSIVE;

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
                            emissiveIntensity: isFoShan ? 0.44 : shouldRise ? 0.34 : 0.13,
                            roughness: 0.52,
                            metalness: shouldRise ? 0.34 : 0.24,
                            side: THREE.DoubleSide,
                        })
                    );
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
                    edgeLine.position.z += 0.015;
                    cityGroup.add(edgeLine);

                    const accentPoints = ringAccentPoints(ring, shouldRise ? 5 : 2);
                    accentPoints.forEach(([lng, lat], index) => {
                        const projected = projection([lng, lat]);
                        if (!projected) return;
                        const [x, y] = projected;
                        const accent = new THREE.Mesh(
                            new THREE.SphereGeometry(shouldRise ? 0.065 : 0.038, 10, 10),
                            new THREE.MeshBasicMaterial({
                                color: shouldRise ? 0xcffafe : 0x93c5fd,
                                transparent: true,
                                opacity: shouldRise ? 0.62 : 0.22,
                                depthWrite: false,
                            })
                        );
                        accent.position.set(-x, -y, depth + 0.08 + (index % 2) * 0.025);
                        cityGroup.add(accent);
                    });
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
                cityGroup.userData.labelLayout = {
                    x,
                    y,
                    align: x < 0 ? 'right' : 'left',
                } satisfies LabelLayout;

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
                meshMapRef.current[name] = cityGroup;
                cityStatusRef.current.set(name, shouldRise ? 1 : 0);
            });

            if (!meshMapRef.current[foShanName]) {
                pendingRaisedCitiesRef.current.add(FOSHAN);
            }

            group.rotation.set(Math.PI / 2, 0, MAP_ROTATION_Z);
            scene.add(group);
            mapGroupRef.current = group;

            pendingCityDataRef.current.forEach((data, cityName) => {
                updateCityData(cityName, data);
            });
            pendingCityDataRef.current.clear();
        });

        const render = () => {
            controls.update();
            renderer.render(scene, camera);
            if (labelRendererRef.current) {
                labelRendererRef.current.render(scene, camera);
            }
            const cameraState = [
                camera.position.x.toFixed(2),
                camera.position.y.toFixed(2),
                camera.position.z.toFixed(2),
                controls.target.x.toFixed(2),
                controls.target.y.toFixed(2),
                controls.target.z.toFixed(2),
            ].join(',');
            if (cameraState !== lastCameraStateRef.current) {
                lastCameraStateRef.current = cameraState;
                if (labelRendererRef.current) {
                    labelRendererRef.current.domElement.style.opacity = '0';
                }
                if (labelRevealTimeoutRef.current !== null) {
                    window.clearTimeout(labelRevealTimeoutRef.current);
                }
                labelRevealTimeoutRef.current = window.setTimeout(() => {
                    refreshWarehouseLabels();
                    if (labelRendererRef.current) {
                        labelRendererRef.current.domElement.style.opacity = '1';
                    }
                    labelRevealTimeoutRef.current = null;
                }, 500);
            }
            const now = performance.now();
            if (now - lastLabelRefreshRef.current > 160) {
                lastLabelRefreshRef.current = now;
                refreshWarehouseLabels();
            }
            checkHover();
            renderFrameRef.current = requestAnimationFrame(render);
        };
        render();

        const handleResize = () => {
            const width = container.clientWidth;
            const height = container.clientHeight;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
            labelRendererRef.current?.setSize(width, height);
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
            if (labelRevealTimeoutRef.current !== null) {
                window.clearTimeout(labelRevealTimeoutRef.current);
                labelRevealTimeoutRef.current = null;
            }
            cityAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            flyAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            flyTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
            flyRemovalTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
            flyLinesRef.current.forEach((line) => disposeObject3D(line));
            if (mapGroupRef.current) disposeObject3D(mapGroupRef.current);
            window.removeEventListener('resize', handleResize);
            container.removeEventListener('mousemove', onMouseMove);
            controls.dispose();
            renderer.dispose();
            labelRendererRef.current?.domElement.remove();
            tooltipRef.current?.remove();
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
    }, [onMouseMove, checkHover, updateCityData, refreshWarehouseLabels]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />;
});

export default ChinaMap3D;
