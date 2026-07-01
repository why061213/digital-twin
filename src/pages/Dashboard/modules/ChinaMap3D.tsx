import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { geoMercator } from 'd3-geo';
import {LABEL_CONFIG} from '@/config/labelLayout'
import * as echarts from 'echarts';

export type ChinaMap3DHandle = {
    riseCity: (cityName: string) => void;
    fallCity: (cityName: string) => void;
    flyToCity: (cityName: string) => void;
    addFlyLine: (lineId: string, fromCoords: [number, number], toCoords: [number, number]) => void;
    removeFlyLine: (lineId: string) => void;
    updateCityData: (cityName: string, data: Record<string, any> | null) => void;
    focusOnCities: (cityNames: string[], mode: CameraFocusMode) => void;
    startWarehouseTour: () => void;
    showCityPanels: (cityName: string, panels: PanelData[]) => void;
    clearCityPanels: (cityName: string) => void;
};
type CameraFocusMode = 'overview' | 'focus';
type CameraPose = {
    position: THREE.Vector3;
    target: THREE.Vector3;
};
type PendingCameraControl = {
    cityNames: string[];
    mode: CameraFocusMode;
};
type LabelVisibilityMode = {
    mode: 'all' | 'focus';
    focusedKey?: string;
};
export type PanelData = {
    id: string;
    title: string;
    chartType: 'table' | 'bar' | 'line' | 'pie' | 'ring';
    height?: number;
    columns?: Array<{ key: string; label: string }>;
    rows?: Array<Record<string, any>>;
    option?: any;
};

const BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const DIRECT_CITY_ADCODES = [
    110000, 120000, 310000, 500000, 710000, 810000, 820000
];
const RISE_HEIGHT = -0.55;
const FOSHAN = '佛山';
const FOSHAN_COORDS: [number, number] = [113.121416, 23.021548];
const CITY_RISE_DELAY = 500;
const CITY_RISE_DURATION = 1200;
const FLY_LINE_DELAY = CITY_RISE_DELAY + CITY_RISE_DURATION + 120;
const MAP_ROTATION_Z = 0;
const FLY_GROW_DURATION = 1300;
const FLY_TRAVEL_DURATION = 2400;
const FLY_MIN_LIFETIME = FLY_GROW_DURATION + FLY_TRAVEL_DURATION * 2;
const CAMERA_CONTROL_DEDUPE_MS = 2400;
const CITY_BASE_COLOR = '#2f465e';
const CITY_BASE_EMISSIVE = '#0b2234';
const CITY_ACTIVE_COLOR = '#22d3ee';
const CITY_ACTIVE_EMISSIVE = '#0e7490';
const FOSHAN_COLOR = '#f59e0b';
const FOSHAN_EMISSIVE = '#7c2d12';
const CAMERA_TILT_RATIO = 0.5;
const CITY_EDGE_LINE_FLAG = 'cityEdgeLine';
const WAREHOUSE_TOUR_START_DELAY = LABEL_CONFIG.warehouseTour.startDelay;
const WAREHOUSE_TOUR_FOCUS_HOLD = LABEL_CONFIG.warehouseTour.focusHold;
const WAREHOUSE_TOUR_OVERVIEW_HOLD = LABEL_CONFIG.warehouseTour.overviewHold;
const WAREHOUSE_TOUR_LOOP_HOLD = LABEL_CONFIG.warehouseTour.loopHold;

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

// const LABEL_NEIGHBOR_RADIUS = 128;
// const LABEL_MIN_DISTANCE = 78;
// const LABEL_MAX_DISTANCE = 140;
// const LABEL_CARD_WIDTH = 132;
// const LABEL_CARD_HEIGHT = 56;
// const LABEL_CITY_SAFE_MARGIN = 22;

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
    const initialCameraPoseRef = useRef<CameraPose | null>(null);
    const firstCameraControlRef = useRef(true);
    const pendingCameraControlRef = useRef<PendingCameraControl | null>(null);
    const lastCameraControlRef = useRef<{ key: string; time: number }>({ key: '', time: 0 });
    const labelVisibilityRef = useRef<LabelVisibilityMode>({ mode: 'all' });
    const warehouseTourTimeoutRef = useRef<number | null>(null);
    const warehouseTourRunRef = useRef(0);
    const cityPanelMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
    const cityPanelChartsRef = useRef<Map<string, echarts.ECharts[]>>(new Map());

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

    const applyLabelVisibility = useCallback(() => {
        const visibility = labelVisibilityRef.current;
        cityLabelMapRef.current.forEach((labelObj, key) => {
            const element = labelObj.element as HTMLDivElement;
            const shouldShow = visibility.mode !== 'focus' || key === visibility.focusedKey;
            element.style.display = shouldShow ? 'block' : 'none';
            element.style.visibility = shouldShow ? 'visible' : 'hidden';
            element.style.opacity = shouldShow ? '1' : '0';
        });
        cityPanelMapRef.current.forEach((panel, key) => {
            const shouldShow = visibility.mode === 'focus' && key === visibility.focusedKey;
            panel.style.display = shouldShow ? 'block' : 'none';
        });
        if (labelRendererRef.current) {
            labelRendererRef.current.domElement.style.opacity = '1';
        }
    }, []);

    const setLabelVisibility = useCallback((visibility: LabelVisibilityMode) => {
        labelVisibilityRef.current = visibility;
        applyLabelVisibility();
    }, [applyLabelVisibility]);

    const refreshWarehouseLabels = useCallback(() => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        const container = containerRef.current;
        if (!camera || !controls || !container) return;
        const cameraDistance = camera.position.distanceTo(controls.target);
        const zoomScale = THREE.MathUtils.clamp(LABEL_CONFIG.zoomScaleFactor / Math.max(cameraDistance, 1), 0.5, 1.08);

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
            .filter((item): item is MarkedWarehouse => {
                const isMarked = Boolean(item.anchor && item.screen && item.data);
                const visibility = labelVisibilityRef.current;
                if (!isMarked) return false;
                return visibility.mode !== 'focus' || item.name === visibility.focusedKey;
            });

        if (entries.length === 0) {
            applyLabelVisibility();
            return;
        }

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
                if (distance > LABEL_CONFIG.neighborRadius) continue;

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
                    ? Math.pow(Math.max(0, LABEL_CONFIG.neighborRadius - distance) / LABEL_CONFIG.neighborRadius, 2)
                    : 0;
                const overlapWeight = equalCircleOverlapRatio(distance, LABEL_CONFIG.neighborRadius) * LABEL_CONFIG.overlapWeightMultiplier;
                const globalWeight = Math.exp(-distance / 260) * LABEL_CONFIG.globalWeightMultiplier;
                density += Math.exp(-distance / LABEL_CONFIG.neighborRadius) + overlapWeight * 0.55;
                localRepulsion.add(direction.clone().multiplyScalar(localWeight * LABEL_CONFIG.localWeightMultiplier));
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
                .multiplyScalar(clusterItems.length > 1 ? LABEL_CONFIG.clusterOutwardStrong : LABEL_CONFIG.clusterOutwardWeak)
                .add(localRepulsion)
                .add(overlapRepulsion.multiplyScalar(LABEL_CONFIG.overlapDirectionScale))
                .add(globalRepulsion)
                .add(outward.multiplyScalar(LABEL_CONFIG.outwardWeight));
            if (direction.lengthSq() < 0.001) {
                direction.copy(outward);
            }
            direction.normalize();

            const hash = Array.from(item.name).reduce((sum, char) => sum + char.charCodeAt(0), 0);
            const rawLabelDistance = THREE.MathUtils.clamp(
                LABEL_CONFIG.minDistance + density * LABEL_CONFIG.densityFactor + Math.max(0, LABEL_CONFIG.neighborRadius - nearestDistance) * LABEL_CONFIG.nearestDistanceFactor,
                LABEL_CONFIG.minDistance,
                LABEL_CONFIG.maxDistance
            );
            const labelDistance = THREE.MathUtils.clamp(rawLabelDistance * zoomScale, LABEL_CONFIG.zoomClampMin, LABEL_CONFIG.maxDistance);
            let x = direction.x * labelDistance;
            const verticalBias = Math.abs(direction.y) < 0.22 ? ((hash % 3) - 1) * LABEL_CONFIG.verticalBiasRange : 0;
            let y = direction.y * labelDistance * LABEL_CONFIG.verticalCompression + verticalBias;
            let align: 'left' | 'right' = x < 0 ? 'right' : 'left';

            for (let pass = 0; pass < LABEL_CONFIG.safeMarginPasses; pass++) {
                const cardLeft = current.x + x + (align === 'right' ? -LABEL_CONFIG.cardWidth : 0);
                const cardRight = cardLeft + LABEL_CONFIG.cardWidth;
                const cardTop = current.y + y;
                const cardBottom = cardTop + LABEL_CONFIG.cardHeight;
                const cardCenter = new THREE.Vector2((cardLeft + cardRight) / 2, (cardTop + cardBottom) / 2);

                entries.forEach((other) => {
                    if (other.name === item.name) return;
                    const insideX = other.screen.x > cardLeft - LABEL_CONFIG.citySafeMargin && other.screen.x < cardRight + LABEL_CONFIG.citySafeMargin;
                    const insideY = other.screen.y > cardTop - LABEL_CONFIG.citySafeMargin && other.screen.y < cardBottom + LABEL_CONFIG.citySafeMargin;
                    if (!insideX || !insideY) return;

                    const away = cardCenter.clone().sub(other.screen);
                    if (away.lengthSq() < 0.001) {
                        away.set(x || 1, y || -1);
                    }
                    away.normalize();
                    const horizontalPush = (LABEL_CONFIG.cardWidth / 2 + LABEL_CONFIG.citySafeMargin) - Math.abs(other.screen.x - cardCenter.x);
                    const verticalPush = (LABEL_CONFIG.cardHeight / 2 + LABEL_CONFIG.citySafeMargin) - Math.abs(other.screen.y - cardCenter.y);
                    if (verticalPush > 0) {
                        y += Math.sign(away.y || -1) * Math.min(LABEL_CONFIG.maxVerticalPush, verticalPush * LABEL_CONFIG.verticalPushFactor);
                    }
                    if (horizontalPush > 0) {
                        x += Math.sign(away.x || (x >= 0 ? 1 : -1)) * Math.min(LABEL_CONFIG.maxHorizontalPush, horizontalPush * LABEL_CONFIG.horizontalPushFactor);
                    }
                    align = x < 0 ? 'right' : 'left';
                });
            }

            item.group.userData.labelLayout = { x, y, align } satisfies LabelLayout;
            const labelObj = cityLabelMapRef.current.get(item.name);
            if (labelObj) {
                const element = labelObj.element as HTMLDivElement;
                const nextHtml = warehouseLabelHtml(item.name, item.data, item.group.userData.labelLayout);
                if (element.dataset.labelHtml !== nextHtml) {
                    element.innerHTML = nextHtml;
                    element.dataset.labelHtml = nextHtml;
                }
                labelObj.position.copy(item.anchor);
            }
        });
        applyLabelVisibility();
    }, [applyLabelVisibility]);

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
                    const material = child.material;
                    if (!(material instanceof THREE.MeshStandardMaterial)) return;
                    material.color.set(isFoShan ? FOSHAN_COLOR : CITY_ACTIVE_COLOR);
                    material.emissive.set(isFoShan ? FOSHAN_EMISSIVE : CITY_ACTIVE_EMISSIVE);
                    material.emissiveIntensity = isFoShan ? 0.42 : 0.34;
                } else if (child instanceof THREE.LineSegments && child.userData.kind === CITY_EDGE_LINE_FLAG) {
                    child.visible = false;
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
                    const material = child.material;
                    if (!(material instanceof THREE.MeshStandardMaterial)) return;
                    material.color.set(CITY_BASE_COLOR);
                    material.emissive.set(CITY_BASE_EMISSIVE);
                    material.emissiveIntensity = 0.08;
                } else if (child instanceof THREE.LineSegments && child.userData.kind === CITY_EDGE_LINE_FLAG) {
                    child.visible = true;
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
            riseCity(cityName);
            group.userData.displayData = data;
            if (!cityLabelMapRef.current.has(matchedKey)) {
                const div = document.createElement('div');
                const layout = group.userData.labelLayout as LabelLayout | undefined;
                const initialHtml = warehouseLabelHtml(cityName, data, layout ?? {
                    x: 96,
                    y: -58,
                    align: 'left',
                });
                div.innerHTML = initialHtml;
                div.dataset.labelHtml = initialHtml;
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
                applyLabelVisibility();
            } else {
                const existingLabel = cityLabelMapRef.current.get(matchedKey);
                if (existingLabel) {
                    const layout = group.userData.labelLayout as LabelLayout | undefined;
                    const element = existingLabel.element as HTMLDivElement;
                    const nextHtml = warehouseLabelHtml(cityName, data, layout ?? {
                        x: 96,
                        y: -58,
                        align: 'left',
                    });
                    if (element.dataset.labelHtml !== nextHtml) {
                        element.innerHTML = nextHtml;
                        element.dataset.labelHtml = nextHtml;
                    }
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
    }, [applyLabelVisibility, findCityKey, refreshWarehouseLabels, riseCity]);

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

    // 通用聚焦函数：返回 Promise，方便仓库巡航按顺序执行镜头动画。
    const focusPoints = useCallback((points: THREE.Vector3[], startPose?: CameraPose, mode: CameraFocusMode = 'overview') => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        const container = containerRef.current;
        if (!camera || !controls || !container || points.length === 0) return Promise.resolve();

        const box = new THREE.Box3().setFromPoints(points);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
        const neededHeightByDepth = size.z / (2 * Math.tan(verticalFov / 2));
        const neededHeightByWidth = size.x / (2 * Math.tan(horizontalFov / 2));
        const baseDistance = Math.max(neededHeightByDepth, neededHeightByWidth);
        const targetHeight = THREE.MathUtils.clamp(
            mode === 'focus' ? baseDistance * 1.1 + 13 : baseDistance * 1.6 + 10,
            mode === 'focus' ? 16 : 22,
            mode === 'focus' ? 34 : 98
        );

        // 目标点（地面）
        const targetLookAt = new THREE.Vector3(center.x, 0, center.z);

        // 相机放在目标点南方（Z 轴负方向），高度为 targetHeight
        const southOffset = targetHeight * (mode === 'focus' ? 0.58 : 0.8);
        const targetPosition = new THREE.Vector3(
            center.x,
            targetHeight,
            center.z - southOffset
        );

        const startPosition = startPose?.position.clone() ?? camera.position.clone();
        const startTarget = startPose?.target.clone() ?? controls.target.clone();
        const duration = mode === 'focus' ? 950 : 1150;
        const startTime = performance.now();

        cancelAnimationFrame(cameraMoveFrameRef.current);
        return new Promise<void>((resolve) => {
            const step = () => {
                const progress = Math.min((performance.now() - startTime) / duration, 1);
                const eased = easeInOutCubic(progress);
                camera.position.lerpVectors(startPosition, targetPosition, eased);
                controls.target.lerpVectors(startTarget, targetLookAt, eased);
                camera.lookAt(controls.target);
                controls.update();
                if (progress < 1) {
                    cameraMoveFrameRef.current = requestAnimationFrame(step);
                } else {
                    cameraMoveFrameRef.current = 0;
                    resolve();
                }
            };
            cameraMoveFrameRef.current = requestAnimationFrame(step);
        });
    }, []);

    const focusOnCities = useCallback((cityNames: string[], mode: CameraFocusMode) => {
        const safeMode: CameraFocusMode = mode === 'focus' ? 'focus' : 'overview';
        const safeCityNames = Array.from(new Set(cityNames.filter(Boolean)));
        const requestKey = `${safeMode}:${safeCityNames.slice().sort().join('|')}`;
        const now = performance.now();

        // 地图 GeoJSON 还没装载完时，先记住最后一次控制；装载完成后再从初始镜头执行。
        if (!mapGroupRef.current || Object.keys(meshMapRef.current).length === 0) {
            pendingCameraControlRef.current = { cityNames: safeCityNames, mode: safeMode };
            return;
        }

        if (
            !firstCameraControlRef.current &&
            requestKey === lastCameraControlRef.current.key &&
            now - lastCameraControlRef.current.time < CAMERA_CONTROL_DEDUPE_MS
        ) {
            return;
        }
        lastCameraControlRef.current = { key: requestKey, time: now };

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

        if (safeMode === 'overview') {
            // 收集所有指定城市 + 佛山
            for (const name of safeCityNames) collectCityCenter(name);
            collectCityCenter(FOSHAN);
            setLabelVisibility({ mode: 'all' });
        } else if (safeMode === 'focus' && safeCityNames.length === 1) {
            collectCityCenter(safeCityNames[0]);
            const focusedKey = findCityKey(safeCityNames[0]);
            if (focusedKey) {
                setLabelVisibility({ mode: 'focus', focusedKey });
            }
        }

        if (points.length > 0) {
            const startPose = firstCameraControlRef.current ? initialCameraPoseRef.current ?? undefined : undefined;
            firstCameraControlRef.current = false;
            void focusPoints(points, startPose, safeMode);
        } else {
            pendingCameraControlRef.current = { cityNames: safeCityNames, mode: safeMode };
        }
    }, [findCityKey, focusPoints, setLabelVisibility]);

    const startWarehouseTour = useCallback(() => {
        const runId = warehouseTourRunRef.current + 1;
        warehouseTourRunRef.current = runId;
        firstCameraControlRef.current = false;

        if (warehouseTourTimeoutRef.current !== null) {
            window.clearTimeout(warehouseTourTimeoutRef.current);
            warehouseTourTimeoutRef.current = null;
        }

        const wait = (delay: number) => new Promise<void>((resolve) => {
            warehouseTourTimeoutRef.current = window.setTimeout(() => {
                warehouseTourTimeoutRef.current = null;
                resolve();
            }, delay);
        });

        const cityCenterByKey = (key: string) => {
            const group = meshMapRef.current[key];
            if (!group) return null;
            const box = new THREE.Box3().setFromObject(group);
            return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
        };

        const runTour = async () => {
            await wait(WAREHOUSE_TOUR_START_DELAY);
            if (warehouseTourRunRef.current !== runId) return;

            let isFirstLoop = true;
            while (warehouseTourRunRef.current === runId) {
                const warehouseKeys = Object.entries(meshMapRef.current)
                    .filter(([, group]) => Boolean(group.userData.displayData))
                    .map(([key]) => key)
                    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
                if (warehouseKeys.length === 0) {
                    await wait(WAREHOUSE_TOUR_LOOP_HOLD);
                    continue;
                }

                const overviewPoints: THREE.Vector3[] = [];
                const foShanKey = findCityKey(FOSHAN);
                if (foShanKey) {
                    const foShanCenter = cityCenterByKey(foShanKey);
                    if (foShanCenter) overviewPoints.push(foShanCenter);
                }
                warehouseKeys.forEach((key) => {
                    if (key === foShanKey) return;
                    const center = cityCenterByKey(key);
                    if (center) overviewPoints.push(center);
                });

                if (overviewPoints.length === 0) {
                    await wait(WAREHOUSE_TOUR_LOOP_HOLD);
                    continue;
                }

                // 1. 初始镜头已经落在佛山；2. 拉升到覆盖所有仓库城市的俯瞰镜头。
                setLabelVisibility({ mode: 'all' });
                await focusPoints(overviewPoints, isFirstLoop ? initialCameraPoseRef.current ?? undefined : undefined, 'overview');
                isFirstLoop = false;
                if (warehouseTourRunRef.current !== runId) return;
                await wait(WAREHOUSE_TOUR_OVERVIEW_HOLD);

                // 3. 依次聚焦每个仓储城市，聚焦时只显示当前目标标签。
                for (const key of warehouseKeys) {
                    if (warehouseTourRunRef.current !== runId) return;
                    const center = cityCenterByKey(key);
                    if (!center) continue;
                    setLabelVisibility({ mode: 'focus', focusedKey: key });
                    await focusPoints([center], undefined, 'focus');
                    if (warehouseTourRunRef.current !== runId) return;
                    refreshWarehouseLabels();
                    await wait(WAREHOUSE_TOUR_FOCUS_HOLD);
                }

                // 4. 巡航结束后回到俯瞰镜头，然后进入下一轮。
                if (warehouseTourRunRef.current !== runId) return;
                setLabelVisibility({ mode: 'all' });
                await focusPoints(overviewPoints, undefined, 'overview');
                if (warehouseTourRunRef.current !== runId) return;
                refreshWarehouseLabels();
                await wait(WAREHOUSE_TOUR_LOOP_HOLD);
            }
        };



        void runTour();
    }, [findCityKey, focusPoints, refreshWarehouseLabels, setLabelVisibility]);

    const showCityPanels = useCallback((cityName: string, panels: PanelData[]) => {
        const matchedKey = findCityKey(cityName);
        if (!matchedKey) return;
        const group = meshMapRef.current[matchedKey];
        if (!group) return;

        // 移除旧面板
        const oldPanel = cityPanelMapRef.current.get(matchedKey);
        if (oldPanel) {
            cityPanelChartsRef.current.get(matchedKey)?.forEach((chart) => chart.dispose());
            cityPanelChartsRef.current.delete(matchedKey);
            oldPanel.remove();
            cityPanelMapRef.current.delete(matchedKey);
        }

        // 创建面板容器
        const panelDiv = document.createElement('div');
        panelDiv.style.position = 'absolute';
        panelDiv.style.width = `${LABEL_CONFIG.panels.width}px`;
        panelDiv.style.maxHeight = `${LABEL_CONFIG.panels.maxHeight}px`;
        panelDiv.style.background = LABEL_CONFIG.panels.backgroundColor;
        panelDiv.style.border = LABEL_CONFIG.panels.border;
        panelDiv.style.borderRadius = `${LABEL_CONFIG.panels.borderRadius}px`;
        panelDiv.style.padding = `${LABEL_CONFIG.panels.padding}px`;
        panelDiv.style.overflowY = 'auto';
        panelDiv.style.zIndex = '100';
        panelDiv.style.backdropFilter = 'blur(10px)';
        panelDiv.style.boxShadow = '0 18px 42px rgba(2,8,23,0.5)';
        panelDiv.style.left = `${LABEL_CONFIG.panels.width + LABEL_CONFIG.panels.gapFromLabel}px`;
        panelDiv.style.top = '0';
        panelDiv.style.pointerEvents = 'auto';
        panelDiv.style.display = 'none';
        panelDiv.dataset.cityPanel = matchedKey;

        const charts: echarts.ECharts[] = [];

        const renderTable = (section: HTMLDivElement, panel: PanelData) => {
            const table = document.createElement('table');
            table.style.width = '100%';
            table.style.color = '#e2e8f0';
            table.style.fontSize = `${LABEL_CONFIG.panels.bodyFontSize}px`;
            table.style.borderCollapse = 'collapse';

            const rows = panel.rows ?? [];
            const columns = panel.columns?.length
                ? panel.columns
                : Object.keys(rows[0] ?? {}).map((key) => ({ key, label: key }));

            rows.forEach((row) => {
                const tr = document.createElement('tr');
                columns.forEach((column, index) => {
                    const cell = document.createElement('td');
                    cell.textContent = String(row[column.key] ?? '--');
                    cell.style.color = index === 0 ? '#94a3b8' : '#e2e8f0';
                    cell.style.padding = '3px 0';
                    cell.style.textAlign = index === 0 ? 'left' : 'right';
                    cell.style.fontWeight = index === 0 ? '400' : '600';
                    tr.appendChild(cell);
                });
                table.appendChild(tr);
            });
            section.appendChild(table);
        };

        const renderChart = (section: HTMLDivElement, panel: PanelData) => {
            const chartDiv = document.createElement('div');
            chartDiv.style.width = '100%';
            chartDiv.style.height = `${panel.height ?? 120}px`;
            section.appendChild(chartDiv);

            window.setTimeout(() => {
                if (!chartDiv.isConnected) return;
                const chart = echarts.init(chartDiv, undefined, { renderer: 'canvas' });
                chart.setOption({
                    textStyle: { color: '#cbd5e1', fontSize: 10 },
                    color: ['#22d3ee', '#fbbf24', '#38bdf8', '#34d399', '#a78bfa'],
                    tooltip: { trigger: 'item', backgroundColor: 'rgba(2,6,23,0.92)', borderColor: 'rgba(103,232,249,0.28)', textStyle: { color: '#e2e8f0' } },
                    ...panel.option,
                });
                charts.push(chart);
                cityPanelChartsRef.current.set(matchedKey, charts);
            }, 0);
        };

        // 构建面板内容
        panels.forEach(panel => {
            const section = document.createElement('div');
            section.style.marginBottom = '12px';

            const title = document.createElement('div');
            title.textContent = panel.title;
            title.style.color = '#cffafe';
            title.style.fontSize = `${LABEL_CONFIG.panels.titleFontSize}px`;
            title.style.fontWeight = 'bold';
            title.style.marginBottom = '6px';
            title.style.borderBottom = '1px solid rgba(103,232,249,0.2)';
            title.style.paddingBottom = '4px';
            section.appendChild(title);

            if (panel.chartType === 'table') {
                renderTable(section, panel);
            } else {
                renderChart(section, panel);
            }
            panelDiv.appendChild(section);
        });

        // 将面板添加到场景中的 CSS2DObject 容器
        const labelObj = cityLabelMapRef.current.get(matchedKey);
        const container = labelObj?.element as HTMLDivElement;
        if (container) {
            container.appendChild(panelDiv);
            cityPanelMapRef.current.set(matchedKey, panelDiv);
            applyLabelVisibility();
        }
    }, [applyLabelVisibility, findCityKey]);

// 清除指定城市的面板
    const clearCityPanels = useCallback((cityName: string) => {
        const matchedKey = findCityKey(cityName);
        if (!matchedKey) return;
        const panel = cityPanelMapRef.current.get(matchedKey);
        if (panel) {
            cityPanelChartsRef.current.get(matchedKey)?.forEach((chart) => chart.dispose());
            cityPanelChartsRef.current.delete(matchedKey);
            panel.remove();
            cityPanelMapRef.current.delete(matchedKey);
        }
    }, [findCityKey]);

    useImperativeHandle(ref, () => ({
        riseCity,
        fallCity,
        flyToCity: riseCity,
        addFlyLine,
        removeFlyLine,
        updateCityData,
        focusOnCities,
        startWarehouseTour,
        showCityPanels,
        clearCityPanels,
    }), [riseCity, fallCity, addFlyLine, removeFlyLine, updateCityData,
        focusOnCities, startWarehouseTour, showCityPanels,
        clearCityPanels,]);

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
        initialCameraPoseRef.current = {
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
                const shouldRise = isFoShan;
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
                    // 地图整体绕 X 轴旋转后，局部 z 负方向才是镜头可见的上表面外侧。
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

            pendingRaisedCitiesRef.current.forEach((cityName) => {
                if (normalizeCityName(cityName).includes(FOSHAN)) return;
                window.setTimeout(() => riseCity(cityName), 120);
            });

            pendingCityDataRef.current.forEach((data, cityName) => {
                updateCityData(cityName, data);
            });
            pendingCityDataRef.current.clear();

            const pendingCameraControl = pendingCameraControlRef.current;
            if (pendingCameraControl) {
                pendingCameraControlRef.current = null;
                window.setTimeout(() => {
                    focusOnCities(pendingCameraControl.cityNames, pendingCameraControl.mode);
                }, 160);
            }
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
            if (cameraState !== lastCameraStateRef.current && labelVisibilityRef.current.mode !== 'focus') {
                lastCameraStateRef.current = cameraState;
                if (labelRevealTimeoutRef.current !== null) {
                    window.clearTimeout(labelRevealTimeoutRef.current);
                }
                labelRevealTimeoutRef.current = window.setTimeout(() => {
                    refreshWarehouseLabels();
                    labelRevealTimeoutRef.current = null;
                }, 220);
            }
            const now = performance.now();
            if (labelVisibilityRef.current.mode !== 'focus' && now - lastLabelRefreshRef.current > 360) {
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
            if (warehouseTourTimeoutRef.current !== null) {
                window.clearTimeout(warehouseTourTimeoutRef.current);
                warehouseTourTimeoutRef.current = null;
            }
            warehouseTourRunRef.current += 1;
            cityAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            flyAnimFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            flyTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
            flyRemovalTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
            cityPanelChartsRef.current.forEach((charts) => charts.forEach((chart) => chart.dispose()));
            cityPanelChartsRef.current.clear();
            cityPanelMapRef.current.forEach((panel) => panel.remove());
            cityPanelMapRef.current.clear();
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
            initialCameraPoseRef.current = null;
            pendingCameraControlRef.current = null;
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
