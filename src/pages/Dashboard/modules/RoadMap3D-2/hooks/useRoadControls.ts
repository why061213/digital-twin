import { useCallback, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mapPosition } from '../geo';
import { disposeObject3D, clamp01, makePathCurve, indexCount } from '../utils';
import { ROAD_LIFT, TRUCK_LIFT, PATH_SAMPLE_COUNT } from '../constants';
import type { RoadState, RoadObjectInfo, OrderLaneState, VehicleBarState } from '../types';
import type { useRoadMapRefs } from './useRoadMapRefs';
import {
    createRouteEndpointLayer,
    createRouteStopLayer,
    createRouteVisualLayers,
    createSharedProgressMaterial,
    configureSharedProgressMaterial,
    updateSharedRouteColorRanges,
    updateSharedProgressMaterial,
} from '../../routeVisuals';
import { syncVehicleAlertRipple } from '../../vehicleAlertRipples';

// const ORDER_COLORS = [
//     0x22c55e,
//     0x38bdf8,
//     0xf59e0b,
//     0xa78bfa,
//     0xfb7185,
//     0x2dd4bf,
//     0xfacc15,
//     0x60a5fa,
// ];
// const FOLLOWER_BAR_COLORS = [
//     0xbae6fd,
//     0xfef08a,
//     0xfbcfe8,
//     0xc4b5fd,
//     0xa7f3d0,
//     0xfed7aa,
// ];
const ROUTE_COLORS = [0x3b82f6, 0xf59e0b, 0x22c55e, 0xa78bfa, 0xfb7185, 0x2dd4bf]; // 蓝/黄/绿/紫/粉/青
const VEHICLE_COLOR = 0xf8fafc;

const TRUCK_MODEL_URL = '/models/rm2-truck.glb';
const TRUCK_MODEL_SCALE = 1;
const TRUCK_MODEL_Y_OFFSET = -0.31;
const TRUCK_IDLE_VISUAL_SCALE = 0.14;
const TRUCK_HIGH_CAMERA_SCALE = 1.55;
const VEHICLE_UPGRADE_MS = 420;
const NORTH_UP_MAX_FIT_DISTANCE = 320;
const NORTH_UP_VIEW_DIRECTION = new THREE.Vector3(0, 0.82, -0.58).normalize();

let truckTemplatePromise: Promise<THREE.Object3D> | null = null;

function loadTruckTemplate(): Promise<THREE.Object3D> {
    if (!truckTemplatePromise) {
        truckTemplatePromise = new Promise<THREE.Object3D>((resolve, reject) => {
            new GLTFLoader().load(
                TRUCK_MODEL_URL,
                (gltf) => resolve(gltf.scene),
                undefined,
                reject,
            );
        }).catch((error) => {
            truckTemplatePromise = null;
            throw error;
        });
    }
    return truckTemplatePromise;
}

function cloneTruckTemplate(template: THREE.Object3D) {
    const clone = template.clone(true);
    clone.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry = object.geometry.clone();
        object.material = Array.isArray(object.material)
            ? object.material.map((material) => material.clone())
            : object.material.clone();
        object.castShadow = false;
        object.receiveShadow = false;
        object.renderOrder = 44;
    });
    return clone;
}

function trackKeyFor(id: string, coords: [number, number][], info: RoadObjectInfo) {
    if (info.isBaselineRoute) return `baseline:${info.pathKey ?? geometryKeyFor(coords)}`;
    return `route:${id}`;
}

function geometryKeyFor(coords: [number, number][]) {
    return coords.map(([lng, lat]) => `${lng.toFixed(5)},${lat.toFixed(5)}`).join('|');
}

function orderKeyFor(lineId: string, info: RoadObjectInfo) {
    return info.colorKey ?? info.orderId ?? info.orderFamilyId ?? `order-${lineId}`;
}

function stableHash(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function routeColorFor(orderKey: string, routeColorIndex?: number) {
    if (typeof routeColorIndex === 'number' && Number.isFinite(routeColorIndex)) {
        return ROUTE_COLORS[Math.abs(Math.trunc(routeColorIndex)) % ROUTE_COLORS.length];
    }
    return ROUTE_COLORS[stableHash(orderKey) % ROUTE_COLORS.length];
}

function branchColors(baseColor: number, branchGroupId: string) {
    const hash = stableHash(branchGroupId);
    const base = new THREE.Color(baseColor);
    const hsl = { h: 0, s: 0, l: 0 };
    base.getHSL(hsl);
    const hueShift = ((hash % 2001) / 1000 - 1) * 0.1;
    const saturationShift = (((hash >>> 7) % 17) - 8) / 100;
    const lightnessShift = (((hash >>> 13) % 21) - 10) / 100;
    const branch = new THREE.Color().setHSL(
        (hsl.h + hueShift + 1) % 1,
        THREE.MathUtils.clamp(hsl.s + saturationShift, 0.42, 0.96),
        THREE.MathUtils.clamp(hsl.l + lightnessShift, 0.34, 0.72),
    );
    const snakeHsl = { h: 0, s: 0, l: 0 };
    branch.getHSL(snakeHsl);
    const snake = new THREE.Color().setHSL(
        snakeHsl.h,
        snakeHsl.s,
        Math.max(0.12, snakeHsl.l * 0.8),
    );
    return { branch: branch.getHex(), snake: snake.getHex() };
}

function createEndpointLayer(
    samples: THREE.Vector3[],
    info: RoadObjectInfo,
    color: number,
    laneIndex: number,
) {
    const stops = (info.tripStops ?? []).flatMap((stop) => {
        if (!stop.coordinates) return [];
        const point = mapPosition(stop.coordinates, ROAD_LIFT);
        if (!point) return [];
        return [{
            point,
            action: stop.action,
            sequence: stop.sequence,
            locationName: stop.locationName,
            currentTarget: stop.currentTarget,
            markerColor: stop.markerColor,
        }];
    });
    return stops.length > 0
        ? createRouteStopLayer(stops, 'rm2')
        : createRouteEndpointLayer(samples, 'rm2', info, color, laneIndex);
}

function drawTubeProgress(tube: THREE.Mesh, progress: number, tubularSegments: number, radialSegments: number) {
    const p = clamp01(progress);
    const totalIndexCount = indexCount(tube.geometry);
    if (p <= 0 || tubularSegments <= 0 || totalIndexCount <= 0) {
        tube.geometry.setDrawRange(0, 0);
        return;
    }
    const completedSegments = Math.max(1, Math.ceil(p * tubularSegments));
    tube.geometry.setDrawRange(0, Math.min(totalIndexCount, completedSegments * radialSegments * 6));
}

function progressOnRoad(road: RoadState, worldPos: THREE.Vector3) {
    if (road.samples.length < 2 || road.cumulativeLengths.length !== road.samples.length || road.totalLength <= 0) {
        return 0;
    }

    let nearestDistanceSq = Number.POSITIVE_INFINITY;
    let distanceAlongPath = 0;
    for (let i = 0; i < road.samples.length - 1; i++) {
        const start = road.samples[i];
        const end = road.samples[i + 1];
        const abX = end.x - start.x;
        const abZ = end.z - start.z;
        const segmentLengthSq = abX * abX + abZ * abZ;
        if (segmentLengthSq <= 0.000001) continue;

        const apX = worldPos.x - start.x;
        const apZ = worldPos.z - start.z;
        const segmentProgress = clamp01((apX * abX + apZ * abZ) / segmentLengthSq);
        const projectedX = start.x + abX * segmentProgress;
        const projectedZ = start.z + abZ * segmentProgress;
        const dx = worldPos.x - projectedX;
        const dz = worldPos.z - projectedZ;
        const distanceSq = dx * dx + dz * dz;

        if (distanceSq < nearestDistanceSq) {
            nearestDistanceSq = distanceSq;
            distanceAlongPath = road.cumulativeLengths[i] + Math.sqrt(segmentLengthSq) * segmentProgress;
        }
    }

    return clamp01(distanceAlongPath / road.totalLength);
}

function pointAndTangentAtProgress(road: RoadState, progress: number) {
    const index = Math.min(road.samples.length - 1, Math.max(0, Math.round(progress * (road.samples.length - 1))));
    const point = road.samples[index]?.clone() ?? new THREE.Vector3();
    const prev = road.samples[Math.max(0, index - 1)] ?? point;
    const next = road.samples[Math.min(road.samples.length - 1, index + 1)] ?? point;
    const tangent = next.clone().sub(prev);
    if (tangent.lengthSq() < 0.000001) tangent.set(1, 0, 0);
    tangent.normalize();
    return { point, tangent };
}

function cancelTruckHeadingAnimation(vehicle: VehicleBarState) {
    const visual = vehicle.truckVisual;
    const animationFrame = visual?.userData.headingAnimationFrame;
    if (typeof animationFrame === 'number') cancelAnimationFrame(animationFrame);
    if (visual) visual.userData.headingAnimationFrame = undefined;
}

function animateTruckHeading(vehicle: VehicleBarState, targetWorldHeading: number) {
    const visual = vehicle.truckVisual;
    if (!visual) return;

    cancelTruckHeadingAnimation(vehicle);
    const savedHeading = visual.userData.worldHeading;
    if (typeof savedHeading !== 'number' || !Number.isFinite(savedHeading)) {
        visual.userData.worldHeading = targetWorldHeading;
        visual.rotation.y = targetWorldHeading - vehicle.bar.rotation.y;
        return;
    }

    const angleDelta = Math.atan2(
        Math.sin(targetWorldHeading - savedHeading),
        Math.cos(targetWorldHeading - savedHeading),
    );
    if (Math.abs(angleDelta) < THREE.MathUtils.degToRad(0.5)) {
        visual.userData.worldHeading = targetWorldHeading;
        visual.rotation.y = targetWorldHeading - vehicle.bar.rotation.y;
        return;
    }

    const startedAt = performance.now();
    const duration = THREE.MathUtils.clamp(Math.abs(angleDelta) / Math.PI * 850, 180, 850);
    const step = () => {
        const progress = Math.min(1, (performance.now() - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const worldHeading = savedHeading + angleDelta * eased;
        visual.userData.worldHeading = worldHeading;
        visual.rotation.y = worldHeading - vehicle.bar.rotation.y;
        if (progress < 1) {
            visual.userData.headingAnimationFrame = requestAnimationFrame(step);
            return;
        }
        visual.userData.headingAnimationFrame = undefined;
        visual.userData.worldHeading = targetWorldHeading;
        visual.rotation.y = targetWorldHeading - vehicle.bar.rotation.y;
    };
    visual.userData.headingAnimationFrame = requestAnimationFrame(step);
}

function setVehicleBarTransform(
    road: RoadState,
    vehicle: VehicleBarState,
    trailOffset: number,
) {
    const { point, tangent } = pointAndTangentAtProgress(road, vehicle.progress);
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const trailDirection = vehicle.progress >= 0.5 ? -1 : 1;
    const position = point
        .add(tangent.clone().multiplyScalar(trailOffset * trailDirection))
        .setY(TRUCK_LIFT + 0.08);

    vehicle.bar.position.copy(position);
    vehicle.bar.rotation.y = -Math.atan2(normal.z, normal.x);
    if (vehicle.truckVisual) {
        const pathHeading = Math.atan2(tangent.x, tangent.z);
        const providerDirection = Number(vehicle.info.directionDeg);
        const worldHeading = Number.isFinite(providerDirection)
            ? -THREE.MathUtils.degToRad(providerDirection)
            : pathHeading;
        animateTruckHeading(vehicle, worldHeading);
    }
}

export function useRoadControls(
    refs: ReturnType<typeof useRoadMapRefs>,
) {
    const highlightedLineIdRef = useRef<string | null>(null);
    const highlightGenerationRef = useRef(0);
    const cameraTruckScaleRef = useRef(1);
    const sharedRangeRefreshFrameRef = useRef<number | null>(null);

    const easeInOutCubic = useCallback((value: number) => (
        value < 0.5
            ? 4 * value * value * value
            : 1 - Math.pow(-2 * value + 2, 3) / 2
    ), []);

    const paintGreenRoad = useCallback((tube: THREE.Mesh, progress: number, tubularSegments: number, radialSegments: number) => {
        drawTubeProgress(tube, progress, tubularSegments, radialSegments);
    }, []);

    const findVehicle = useCallback((lineId: string) => {
        const trackKey = refs.lineTrackMapRef.current.get(lineId);
        const road = trackKey ? refs.roadsMapRef.current.get(trackKey) : undefined;
        if (!road) return null;
        for (const lane of road.orders.values()) {
            const vehicle = lane.vehicles.get(lineId);
            if (vehicle) return { road, vehicle };
        }
        return null;
    }, [refs.lineTrackMapRef, refs.roadsMapRef]);

    const applyUpgradeVisual = useCallback((vehicle: VehicleBarState) => {
        const progress = clamp01(vehicle.upgradeProgress);
        const material = vehicle.bar.material as THREE.MeshBasicMaterial;
        const baseOpacity = typeof vehicle.bar.userData.baseOpacity === 'number'
            ? vehicle.bar.userData.baseOpacity
            : 0.95;
        material.opacity = vehicle.truckVisual ? 0 : baseOpacity * (1 - progress);
        material.needsUpdate = true;
        vehicle.truckVisual?.scale.setScalar(
            THREE.MathUtils.lerp(TRUCK_IDLE_VISUAL_SCALE, 1, progress) * cameraTruckScaleRef.current,
        );
    }, []);

    const updateVehicleScaleForCamera = useCallback((cameraHeight: number) => {
        const normalized = THREE.MathUtils.smoothstep(Math.abs(cameraHeight), 480, 2200);
        const nextScale = THREE.MathUtils.lerp(1, TRUCK_HIGH_CAMERA_SCALE, normalized);
        if (Math.abs(nextScale - cameraTruckScaleRef.current) < 0.002) return;
        cameraTruckScaleRef.current = nextScale;
        refs.roadsMapRef.current.forEach((road) => {
            road.orders.forEach((lane) => {
                lane.vehicles.forEach(applyUpgradeVisual);
            });
        });
    }, [applyUpgradeVisual, refs.roadsMapRef]);

    const animateVehicleUpgrade = useCallback((vehicle: VehicleBarState, target: 0 | 1) => {
        if (vehicle.upgradeAnimationFrame !== undefined) {
            cancelAnimationFrame(vehicle.upgradeAnimationFrame);
        }
        const startProgress = vehicle.upgradeProgress;
        const startedAt = performance.now();
        const step = () => {
            const elapsed = Math.min(1, (performance.now() - startedAt) / VEHICLE_UPGRADE_MS);
            const eased = elapsed < 0.5
                ? 4 * elapsed * elapsed * elapsed
                : 1 - Math.pow(-2 * elapsed + 2, 3) / 2;
            vehicle.upgradeProgress = THREE.MathUtils.lerp(startProgress, target, eased);
            applyUpgradeVisual(vehicle);
            if (elapsed < 1) {
                vehicle.upgradeAnimationFrame = requestAnimationFrame(step);
                return;
            }
            vehicle.upgradeAnimationFrame = undefined;
            vehicle.upgradeProgress = target;
            applyUpgradeVisual(vehicle);
        };
        vehicle.upgradeAnimationFrame = requestAnimationFrame(step);
    }, [applyUpgradeVisual]);

    const createTruckVisual = useCallback((template: THREE.Object3D, vehicle: VehicleBarState) => {
        const visual = new THREE.Group();
        const model = cloneTruckTemplate(template);
        model.scale.setScalar(TRUCK_MODEL_SCALE);
        model.position.y = TRUCK_MODEL_Y_OFFSET;
        const locatorColor = new THREE.Color(VEHICLE_COLOR);

        const locator = new THREE.Mesh(
            new THREE.RingGeometry(4.2, 4.8, 64),
            new THREE.MeshBasicMaterial({
                color: locatorColor,
                transparent: true,
                opacity: 0.88,
                side: THREE.DoubleSide,
                depthWrite: false,
            }),
        );
        locator.rotation.x = Math.PI / 2;
        locator.position.y = TRUCK_MODEL_Y_OFFSET + 0.03;
        locator.renderOrder = 43;
        locator.visible = false;
        visual.add(model, locator);
        visual.userData.locator = locator;
        visual.scale.setScalar(TRUCK_IDLE_VISUAL_SCALE);
        vehicle.bar.add(visual);
        vehicle.truckVisual = visual;
        return visual;
    }, []);

    const ensureVehicleTruck = useCallback(async (vehicle: VehicleBarState) => {
        try {
            const template = await loadTruckTemplate();
            const current = findVehicle(vehicle.lineId);
            if (current?.vehicle !== vehicle) return;
            if (!vehicle.truckVisual) createTruckVisual(template, vehicle);
            setVehicleBarTransform(current.road, vehicle, 0);
            applyUpgradeVisual(vehicle);
        } catch (error) {
            console.warn('[RM2 truck model] load failed; keeping vehicle bar', {
                lineId: vehicle.lineId,
                error,
            });
        }
    }, [applyUpgradeVisual, createTruckVisual, findVehicle]);

    const upgradeVehicle = useCallback(async (vehicle: VehicleBarState) => {
        const generation = highlightGenerationRef.current;
        try {
            const template = await loadTruckTemplate();
            if (generation !== highlightGenerationRef.current
                || highlightedLineIdRef.current !== vehicle.lineId
                || findVehicle(vehicle.lineId)?.vehicle !== vehicle) {
                return;
            }
            if (!vehicle.truckVisual) createTruckVisual(template, vehicle);
            const current = findVehicle(vehicle.lineId);
            if (!current) return;
            setVehicleBarTransform(current.road, vehicle, 0);
            const locator = vehicle.truckVisual?.userData.locator;
            if (locator instanceof THREE.Object3D) locator.visible = true;
            animateVehicleUpgrade(vehicle, 1);
        } catch (error) {
            console.warn('[RM2 truck model] load failed; keeping vehicle bar', {
                lineId: vehicle.lineId,
                error,
            });
        }
    }, [animateVehicleUpgrade, createTruckVisual, findVehicle]);

    const downgradeVehicle = useCallback((vehicle: VehicleBarState) => {
        const locator = vehicle.truckVisual?.userData.locator;
        if (locator instanceof THREE.Object3D) locator.visible = false;
        if (!vehicle.truckVisual) {
            vehicle.upgradeProgress = 0;
            applyUpgradeVisual(vehicle);
            return;
        }
        animateVehicleUpgrade(vehicle, 0);
    }, [animateVehicleUpgrade, applyUpgradeVisual]);

    const setHighlightedVehicle = useCallback((lineId: string | null) => {
        if (highlightedLineIdRef.current === lineId) return;
        const previousLineId = highlightedLineIdRef.current;
        highlightedLineIdRef.current = lineId;
        highlightGenerationRef.current += 1;

        if (previousLineId) {
            const previous = findVehicle(previousLineId);
            if (previous) downgradeVehicle(previous.vehicle);
        }
        if (lineId) {
            const next = findVehicle(lineId);
            if (next) void upgradeVehicle(next.vehicle);
        }
    }, [downgradeVehicle, findVehicle, upgradeVehicle]);

    const updateOrderVisuals = useCallback((road: RoadState) => {
        const orderCount = Math.max(1, road.orders.size);
        if (road.renderedOrderCount !== orderCount) {
            const routeWidthFactor = Math.min(2.8, 0.7 + 0.3 * orderCount);
            const baseRadius = 0.22 * routeWidthFactor;
            road.grayTube.geometry.dispose();
            road.grayTube.geometry = new THREE.TubeGeometry(road.displayCurve, road.tubularSegments, baseRadius, road.radialSegments, false);
            road.selectionTube.geometry.dispose();
            road.selectionTube.geometry = new THREE.TubeGeometry(road.displayCurve, road.tubularSegments, baseRadius + 0.16, road.radialSegments, false);
            road.sharedProgressTube.geometry.dispose();
            road.sharedProgressTube.geometry = new THREE.TubeGeometry(
                road.displayCurve,
                road.tubularSegments,
                Math.max(0.52, baseRadius * 1.45),
                road.radialSegments,
                false,
            );
            road.travelledProgressTube.geometry.dispose();
            road.travelledProgressTube.geometry = new THREE.TubeGeometry(
                road.displayCurve,
                road.tubularSegments,
                Math.max(0.54, baseRadius * 1.5),
                road.radialSegments,
                false,
            );
            road.renderedOrderCount = orderCount;
        }

        const lanes = Array.from(road.orders.values());
        lanes.forEach((lane) => {
            const vehicles = Array.from(lane.vehicles.values());
            lane.maxProgress = Math.max(0, ...vehicles.map((vehicle) => vehicle.progress));
        });
        updateSharedProgressMaterial(
            road.sharedProgressTube.material,
            lanes.map((lane) => ({ color: lane.color, progress: lane.maxProgress })),
        );
        updateSharedProgressMaterial(
            road.travelledProgressTube.material,
            lanes.map((lane) => ({ color: lane.color, progress: lane.maxProgress })),
        );

        lanes.forEach((lane, laneIndex) => {
            lane.laneIndex = laneIndex;
            const vehicles = Array.from(lane.vehicles.values());
            // 后端 primary 身份优先；缺失时用稳定 lineId 兜底，不能随进度动态换车。
            const leadVehicle = vehicles.find((vehicle) => vehicle.info.vehicleRole === 'primary')
                ?? [...vehicles].sort((left, right) => left.lineId.localeCompare(right.lineId))[0]
                ?? null;
            let followerIndex = 0;
            vehicles.forEach((vehicle, vehicleIndex) => {
                const material = vehicle.bar.material as THREE.MeshBasicMaterial;
                const isLead = vehicle === leadVehicle;

                // 1. 选择颜色
                if (isLead) {
                    material.color.setHex(VEHICLE_COLOR);
                } else {
                    // 跟随车辆只在订单主色的明度/饱和度上做变化，保持同一色相。
                    material.color.setHex(VEHICLE_COLOR);
                }

                // 2. 透明度
                const baseOpacity = isLead ? 1.0 : 0.85;
                vehicle.bar.userData.baseOpacity = baseOpacity;
                material.opacity = vehicle.truckVisual
                    ? 0
                    : baseOpacity * (1 - clamp01(vehicle.upgradeProgress));

                // 3. 缩放（领头车辆稍大）
                const baseScale = vehicle.upgradeProgress > 0
                    ? { x: 1, y: 1, z: 1 }
                    : isLead
                        ? { x: 1.25, y: 1.34, z: 1.25 }
                        : { x: 0.88, y: 0.98, z: 0.88 };
                vehicle.baseScale.set(baseScale.x, baseScale.y, baseScale.z);
                vehicle.bar.scale.copy(vehicle.baseScale);

                // 4. 渲染顺序
                vehicle.bar.renderOrder = isLead ? 36 : 18 + (vehicleIndex % 8);

                // 横杆中心必须压在线路中心；同线路车辆重合时只沿路线前后错开。
                const followerOrder = followerIndex;
                if (!isLead) followerIndex += 1;
                const overlapsLead = !isLead && leadVehicle !== null
                    && Math.abs(vehicle.progress - leadVehicle.progress) < 0.012;
                const trailOffset = overlapsLead ? Math.min(0.7, (followerOrder + 1) * 0.35) : 0;
                setVehicleBarTransform(road, vehicle, trailOffset);
                syncVehicleAlertRipple(vehicle);
            });
        });
    }, []);

    const refreshSharedRoadColorRanges = useCallback(() => {
        const roads = Array.from(refs.roadsMapRef.current.values());
        roads.forEach((source) => {
            const material = source.sharedProgressTube.material as THREE.ShaderMaterial;
            const travelledMaterial = source.travelledProgressTube.material as THREE.ShaderMaterial;
            const analysis = source.info.routeAnalysis;
            const orderKey = orderKeyFor(source.pathKey, source.info);
            const baseColor = routeColorFor(orderKey, source.info.routeColorIndex);
            configureSharedProgressMaterial(material, baseColor, source.pathKey);
            configureSharedProgressMaterial(travelledMaterial, baseColor, source.pathKey);
            if (source.info.isBaselineRoute || !analysis || analysis.totalLengthM <= 0) {
                updateSharedRouteColorRanges(material, []);
                updateSharedRouteColorRanges(travelledMaterial, []);
                return;
            }
            const ranges = analysis.parts.flatMap((part) => {
                if (part.routeRole !== 'DEVIATION') return [];
                const groupId = part.branchGroupId ?? part.partId;
                const colors = branchColors(baseColor, groupId);
                return [{
                    start: part.fromMeasureM / analysis.totalLengthM,
                    end: part.toMeasureM / analysis.totalLengthM,
                    color: colors.branch,
                    snakeColor: colors.snake,
                }];
            });
            updateSharedRouteColorRanges(material, ranges);
            updateSharedRouteColorRanges(travelledMaterial, ranges);
        });
    }, [refs.roadsMapRef]);

    const scheduleSharedRoadColorRangesRefresh = useCallback(() => {
        if (sharedRangeRefreshFrameRef.current !== null) return;
        sharedRangeRefreshFrameRef.current = requestAnimationFrame(() => {
            sharedRangeRefreshFrameRef.current = null;
            refreshSharedRoadColorRanges();
        });
    }, [refreshSharedRoadColorRanges]);

    const updateProgressFromTruck = useCallback((roadId: string) => {
        const trackKey = refs.lineTrackMapRef.current.get(roadId) ?? roadId;
        const road = refs.roadsMapRef.current.get(trackKey);
        if (!road) return;
        updateOrderVisuals(road);
    }, [refs.lineTrackMapRef, refs.roadsMapRef, updateOrderVisuals]);

    const focusPath = useCallback((points: THREE.Vector3[]) => {
        const camera = refs.cameraRef.current;
        const controls = refs.controlsRef.current;
        const container = refs.containerRef.current;
        if (!camera || !controls || !container || points.length === 0) return;

        const sphere = new THREE.Box3().setFromPoints(points).getBoundingSphere(new THREE.Sphere());
        const center = sphere.center;
        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
        const fitFov = Math.max(THREE.MathUtils.degToRad(10), Math.min(verticalFov, horizontalFov));
        const fitDistance = Math.max(36, (Math.max(sphere.radius, 1) / Math.sin(fitFov / 2)) * 1.18);
        const useNorthUpView = fitDistance <= NORTH_UP_MAX_FIT_DISTANCE;
        const viewDirection = useNorthUpView
            ? NORTH_UP_VIEW_DIRECTION.clone()
            : camera.position.clone().sub(controls.target);
        if (!useNorthUpView) {
            if (viewDirection.lengthSq() < 0.001) viewDirection.set(-0.34, 0.82, 1);
            viewDirection.normalize();
            if (viewDirection.y < 0.28) {
                viewDirection.y = 0.28;
                viewDirection.normalize();
            }
        }

        const targetPosition = center.clone().addScaledVector(viewDirection, fitDistance);
        const targetLookAt = new THREE.Vector3(center.x, 0, center.z);
        const startPosition = camera.position.clone();
        const startTarget = controls.target.clone();
        const duration = 980;
        const startTime = performance.now();

        cancelAnimationFrame(refs.cameraMoveFrameRef.current);
        const step = () => {
            const progress = Math.min((performance.now() - startTime) / duration, 1);
            const eased = easeInOutCubic(progress);
            camera.position.lerpVectors(startPosition, targetPosition, eased);
            controls.target.lerpVectors(startTarget, targetLookAt, eased);
            camera.lookAt(controls.target);
            controls.update();
            if (progress < 1) {
                refs.cameraMoveFrameRef.current = requestAnimationFrame(step);
            } else {
                refs.cameraMoveFrameRef.current = 0;
            }
        };
        refs.cameraMoveFrameRef.current = requestAnimationFrame(step);
    }, [easeInOutCubic, refs]);

    const focusAllRoads = useCallback((delay = 80) => {
        if (refs.cameraFocusTimeoutRef.current !== null) {
            window.clearTimeout(refs.cameraFocusTimeoutRef.current);
        }

        refs.cameraFocusTimeoutRef.current = window.setTimeout(() => {
            refs.cameraFocusTimeoutRef.current = null;
            const points: THREE.Vector3[] = [];
            refs.roadsMapRef.current.forEach((road) => {
                if (road.samples.length === 0) return;
                points.push(...road.samples);
                (road.info.tripStops ?? []).forEach((stop) => {
                    if (!stop.coordinates) return;
                    const point = mapPosition(stop.coordinates, ROAD_LIFT);
                    if (point) points.push(point);
                });
                road.orders.forEach((lane) => {
                    lane.vehicles.forEach((vehicle) => points.push(vehicle.bar.position));
                });
            });
            focusPath(points);
        }, Math.max(0, delay));
    }, [focusPath, refs]);

    const clearRoad = useCallback((id: string) => {
        const trackKey = refs.lineTrackMapRef.current.get(id) ?? id;
        const road = refs.roadsMapRef.current.get(trackKey);
        if (!road) return;
        road.orders.forEach((lane) => {
            lane.vehicles.forEach((vehicle) => {
                if (vehicle.upgradeAnimationFrame !== undefined) {
                    cancelAnimationFrame(vehicle.upgradeAnimationFrame);
                }
                cancelTruckHeadingAnimation(vehicle);
            });
        });
        refs.sceneRef.current?.remove(road.group);
        disposeObject3D(road.group);
        refs.roadsMapRef.current.delete(trackKey);
        road.lineIds.forEach((lineId) => refs.lineTrackMapRef.current.delete(lineId));
    }, [refs]);

    const clearRoads = useCallback(() => {
        if (sharedRangeRefreshFrameRef.current !== null) {
            cancelAnimationFrame(sharedRangeRefreshFrameRef.current);
            sharedRangeRefreshFrameRef.current = null;
        }
        highlightedLineIdRef.current = null;
        highlightGenerationRef.current += 1;
        Array.from(refs.roadsMapRef.current.keys()).forEach((id) => clearRoad(id));
        refs.roadsMapRef.current.clear();
        refs.lineTrackMapRef.current.clear();
        refs.selectedRoadIdRef.current = null;
    }, [clearRoad, refs]);

    const setRoadsOpacity = useCallback((opacity: number) => {
        const multiplier = clamp01(opacity);
        refs.roadsMapRef.current.forEach((road) => {
            road.group.traverse((object) => {
                if (!(object instanceof THREE.Mesh)) return;
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                materials.forEach((material) => {
                    if (!material) return;
                    const baseOpacity = typeof material.userData.baseRoadOpacity === 'number'
                        ? material.userData.baseRoadOpacity
                        : material.opacity;
                    material.userData.baseRoadOpacity = baseOpacity;
                    material.transparent = true;
                    material.opacity = baseOpacity * multiplier;
                    material.needsUpdate = true;
                });
            });
        });
    }, [refs.roadsMapRef]);

    const ensureOrderLane = useCallback((road: RoadState, orderId: string, info: RoadObjectInfo) => {
        let lane = road.orders.get(orderId);
        if (lane) return lane;

        const laneIndex = road.orders.size;
        // 第一车道用主路线色（蓝/黄/绿），分支车道从第一车道派生
        const firstLane = [...road.orders.values()][0];
        const color = laneIndex === 0 || !firstLane
            ? routeColorFor(orderId, info.routeColorIndex)
            : branchColors(firstLane.color, orderId).branch;
        const progressGeo = new THREE.TubeGeometry(road.pathCurve, road.tubularSegments, 0.17, road.radialSegments, false);
        progressGeo.setDrawRange(0, 0);
        const progressTube = new THREE.Mesh(progressGeo, new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -8,
            polygonOffsetUnits: -8,
        }));
        progressTube.renderOrder = 9 + laneIndex;
        progressTube.userData = { roadId: road.pathKey, objectType: '订单进度' };
        progressTube.visible = false;
        const endpointLayer = info.showRouteEndpoints === false
            ? new THREE.Group()
            : createEndpointLayer(road.samples, info, color, info.routeIndex ?? laneIndex);
        road.group.add(endpointLayer);

        lane = {
            orderId,
            color,
            progressTube,
            endpointLayer,
            vehicles: new Map(),
            maxProgress: 0,
            laneIndex,
        };
        road.orders.set(orderId, lane);
        return lane;
    }, []);

    const ensureVehicleBar = useCallback((road: RoadState, lane: OrderLaneState, lineId: string, info: RoadObjectInfo) => {
        let vehicle = lane.vehicles.get(lineId);
        if (vehicle) {
            vehicle.info = { ...vehicle.info, ...info };
            return vehicle;
        }

        const bar = new THREE.Mesh(
            new THREE.BoxGeometry(0.68, 0.15, 0.23),
            new THREE.MeshBasicMaterial({
                color: lane.color,
                transparent: true,
                opacity: 0.95,
                depthWrite: false,
            })
        );
        bar.renderOrder = 22;
        bar.userData = { roadId: road.pathKey, lineId, objectType: '车辆进度条' };
        road.group.add(bar);
        vehicle = {
            lineId,
            orderId: lane.orderId,
            bar,
            baseScale: new THREE.Vector3(1, 1, 1),
            progress: 0,
            currentCoords: road.currentCoords,
            info,
            upgradeProgress: 0,
        };
        bar.visible = info.vehicleVisible !== false;
        lane.vehicles.set(lineId, vehicle);
        road.lineIds.add(lineId);
        refs.lineTrackMapRef.current.set(lineId, road.pathKey);
        void ensureVehicleTruck(vehicle);
        if (highlightedLineIdRef.current === lineId) {
            void upgradeVehicle(vehicle);
        }
        return vehicle;
    }, [ensureVehicleTruck, refs.lineTrackMapRef, upgradeVehicle]);

    const addRoadPath = useCallback(
        (id: string, coords: [number, number][], info: RoadObjectInfo = {}) => {
            const scene = refs.sceneRef.current;
            if (!scene || coords.length < 2) return;

            const pathKey = trackKeyFor(id, coords, info);
            const orderId = orderKeyFor(id, info);
            const existing = refs.roadsMapRef.current.get(pathKey);
            if (existing) {
                const nextGeometryKey = geometryKeyFor(coords);
                if (existing.geometryKey !== nextGeometryKey) {
                    const points = coords
                        .map((coord) => mapPosition(coord, ROAD_LIFT))
                        .filter((point): point is THREE.Vector3 => Boolean(point));
                    if (points.length >= 2) {
                        const pathCurve = makePathCurve(points);
                        const tubularSegments = Math.max(PATH_SAMPLE_COUNT, points.length * 32);
                        const samples = pathCurve.getSpacedPoints(tubularSegments);
                        const displayPoints = coords
                            .map((coord) => mapPosition(coord, ROAD_LIFT))
                            .filter((point): point is THREE.Vector3 => Boolean(point));
                        const displayCurve = makePathCurve(displayPoints.length >= 2 ? displayPoints : points);
                        const displaySamples = displayCurve.getSpacedPoints(tubularSegments);
                        const cumulativeLengths: number[] = [0];
                        for (let index = 1; index < samples.length; index++) {
                            cumulativeLengths[index] = cumulativeLengths[index - 1]
                                + samples[index - 1].distanceTo(samples[index]);
                        }
                        existing.grayTube.geometry.dispose();
                        existing.grayTube.geometry = new THREE.TubeGeometry(
                            displayCurve, tubularSegments, 0.18, existing.radialSegments, false,
                        );
                        existing.selectionTube.geometry.dispose();
                        existing.selectionTube.geometry = new THREE.TubeGeometry(
                            displayCurve, tubularSegments, 0.38, existing.radialSegments, false,
                        );
                        existing.sharedProgressTube.geometry.dispose();
                        existing.sharedProgressTube.geometry = new THREE.TubeGeometry(
                            displayCurve, tubularSegments, 0.28, existing.radialSegments, false,
                        );
                        existing.travelledProgressTube.geometry.dispose();
                        existing.travelledProgressTube.geometry = new THREE.TubeGeometry(
                            displayCurve, tubularSegments, 0.30, existing.radialSegments, false,
                        );
                        existing.orders.forEach((lane) => {
                            lane.progressTube.geometry.dispose();
                            lane.progressTube.geometry = new THREE.TubeGeometry(
                                pathCurve, tubularSegments, 0.17, existing.radialSegments, false,
                            );
                            existing.group.remove(lane.endpointLayer);
                            disposeObject3D(lane.endpointLayer);
                            lane.endpointLayer = info.showRouteEndpoints === false
                                ? new THREE.Group()
                                : createEndpointLayer(samples, info, routeColorFor(orderKeyFor(existing.pathKey, info), info.routeColorIndex), info.routeIndex ?? lane.laneIndex);
                            existing.group.add(lane.endpointLayer);
                        });
                        const oldVisualLayers = existing.group.children.find(
                            (child) => child.userData.routeVisualLayers === true,
                        );
                        if (oldVisualLayers) {
                            existing.group.remove(oldVisualLayers);
                            disposeObject3D(oldVisualLayers);
                        }
                        const visualLayers = createRouteVisualLayers(
                            displayCurve, tubularSegments, existing.radialSegments, displaySamples, 'rm2', info,
                        );
                        visualLayers.userData.routeVisualLayers = true;
                        visualLayers.visible = !info.isBaselineRoute;
                        existing.group.add(visualLayers);
                        existing.pathCurve = pathCurve;
                        existing.displayCurve = displayCurve;
                        existing.samples = samples;
                        existing.cumulativeLengths = cumulativeLengths;
                        existing.totalLength = cumulativeLengths[cumulativeLengths.length - 1] ?? 0;
                        existing.tubularSegments = tubularSegments;
                        existing.currentCoords = coords[0];
                        existing.geometryKey = nextGeometryKey;
                    }
                }
                const lane = ensureOrderLane(existing, orderId, info);
                ensureVehicleBar(existing, lane, id, info);
                existing.info = { ...existing.info, ...info };
                updateOrderVisuals(existing);
                scheduleSharedRoadColorRangesRefresh();
                focusAllRoads();
                return;
            }

            const points = coords
                .map((coord) => mapPosition(coord, ROAD_LIFT))
                .filter((point): point is THREE.Vector3 => Boolean(point));
            if (points.length < 2) return;

            const pathCurve = makePathCurve(points);
            const tubularSegments = Math.max(PATH_SAMPLE_COUNT, points.length * 32);
            const radialSegments = 6;
            const samples = pathCurve.getSpacedPoints(tubularSegments);
            const displayPoints = coords
                .map((coord) => mapPosition(coord, ROAD_LIFT))
                .filter((point): point is THREE.Vector3 => Boolean(point));
            const displayCurve = makePathCurve(displayPoints.length >= 2 ? displayPoints : points);
            const displaySamples = displayCurve.getSpacedPoints(tubularSegments);
            const cumulativeLengths: number[] = [0];
            for (let i = 1; i < samples.length; i++) {
                cumulativeLengths[i] = cumulativeLengths[i - 1] + samples[i - 1].distanceTo(samples[i]);
            }

            const grayTube = new THREE.Mesh(
                new THREE.TubeGeometry(displayCurve, tubularSegments, 0.18, radialSegments, false),
                new THREE.MeshBasicMaterial({
                    color: info.isBaselineRoute ? 0x64748b : 0x0f172a,
                    transparent: true,
                    opacity: 0.10, // 未走过路线虚化
                    depthWrite: false,
                })
            );
            grayTube.renderOrder = 2;
            grayTube.userData = { roadId: pathKey, objectType: info.isBaselineRoute ? '计划基线' : '路线结构' };

            const selectionTube = new THREE.Mesh(new THREE.TubeGeometry(displayCurve, tubularSegments, 0.38, radialSegments, false), new THREE.MeshBasicMaterial({
                color: 0x38bdf8,
                transparent: true,
                opacity: 0,
                depthWrite: false,
            }));
            selectionTube.renderOrder = 12;
            selectionTube.userData = { roadId: pathKey, objectType: info.isBaselineRoute ? '计划基线' : '路线结构' };

            const sharedProgressMaterial = createSharedProgressMaterial('untravelled');
            configureSharedProgressMaterial(sharedProgressMaterial, routeColorFor(orderId, info.routeColorIndex), pathKey);
            const sharedProgressTube = new THREE.Mesh(
                new THREE.TubeGeometry(displayCurve, tubularSegments, 0.28, radialSegments, false),
                sharedProgressMaterial,
            );
            sharedProgressTube.position.y = 0.04;
            sharedProgressTube.renderOrder = 8;
            sharedProgressTube.userData = { roadId: pathKey, objectType: '未走路线' };
            sharedProgressTube.visible = !info.isBaselineRoute;
            const travelledProgressMaterial = createSharedProgressMaterial('travelled');
            configureSharedProgressMaterial(travelledProgressMaterial, routeColorFor(orderId, info.routeColorIndex), pathKey);
            const travelledProgressTube = new THREE.Mesh(
                new THREE.TubeGeometry(displayCurve, tubularSegments, 0.30, radialSegments, false),
                travelledProgressMaterial,
            );
            travelledProgressTube.position.y = 0.055;
            travelledProgressTube.renderOrder = 9;
            travelledProgressTube.userData = { roadId: pathKey, objectType: '已走路线' };
            travelledProgressTube.onBeforeRender = () => {
                travelledProgressMaterial.uniforms.uTime.value = performance.now() / 1_000;
            };
            travelledProgressTube.visible = !info.isBaselineRoute;
            const labelAnchor = samples[Math.floor(samples.length * 0.58)]?.clone() ?? samples[0].clone();
            labelAnchor.x += 1.25;
            labelAnchor.y = TRUCK_LIFT + 3.25;
            labelAnchor.z += 0.95;

            const visualLayers = createRouteVisualLayers(
                displayCurve, tubularSegments, radialSegments, displaySamples, 'rm2', info,
            );
            visualLayers.userData.routeVisualLayers = true;
            visualLayers.visible = !info.isBaselineRoute;
            const group = new THREE.Group();
            group.add(
                visualLayers,
                grayTube,
                sharedProgressTube,
                travelledProgressTube,
                selectionTube,
            );
            scene.add(group);

            const road: RoadState = {
                pathKey,
                group,
                pathCurve,
                displayCurve,
                grayTube,
                selectionTube,
                sharedProgressTube,
                travelledProgressTube,
                samples,
                cumulativeLengths,
                totalLength: cumulativeLengths[cumulativeLengths.length - 1] ?? 0,
                tubularSegments,
                radialSegments,
                currentCoords: coords[0],
                labelAnchor,
                info,
                orders: new Map(),
                lineIds: new Set(),
                renderedOrderCount: 0,
                isSelected: false,
                geometryKey: geometryKeyFor(coords),
            };

            refs.roadsMapRef.current.set(pathKey, road);
            const lane = ensureOrderLane(road, orderId, info);
            ensureVehicleBar(road, lane, id, info);
            updateOrderVisuals(road);
            scheduleSharedRoadColorRangesRefresh();
            focusAllRoads();
        },
        [ensureOrderLane, ensureVehicleBar, focusAllRoads, refs, scheduleSharedRoadColorRangesRefresh, updateOrderVisuals],
    );

    const removeRoadPath = useCallback((id: string) => {
        const trackKey = refs.lineTrackMapRef.current.get(id);
        if (!trackKey) {
            clearRoad(id);
            scheduleSharedRoadColorRangesRefresh();
            return;
        }

        const road = refs.roadsMapRef.current.get(trackKey);
        if (!road) return;
        road.orders.forEach((lane) => {
            const vehicle = lane.vehicles.get(id);
            if (!vehicle) return;
            if (vehicle.upgradeAnimationFrame !== undefined) {
                cancelAnimationFrame(vehicle.upgradeAnimationFrame);
            }
            lane.vehicles.delete(id);
            road.group.remove(vehicle.bar);
            disposeObject3D(vehicle.bar);
            if (lane.vehicles.size === 0 && !road.info.isBaselineRoute) {
                disposeObject3D(lane.progressTube);
                road.group.remove(lane.endpointLayer);
                disposeObject3D(lane.endpointLayer);
                road.orders.delete(lane.orderId);
            }
        });
        road.lineIds.delete(id);
        refs.lineTrackMapRef.current.delete(id);
        if (road.lineIds.size === 0 && !road.info.isBaselineRoute) {
            clearRoad(trackKey);
            scheduleSharedRoadColorRangesRefresh();
            return;
        }
        updateOrderVisuals(road);
        scheduleSharedRoadColorRangesRefresh();
    }, [clearRoad, refs, scheduleSharedRoadColorRangesRefresh, updateOrderVisuals]);

    const setRoadPath = useCallback(
        (coords: [number, number][]) => {
            const id = `road_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            addRoadPath(id, coords);
        },
        [addRoadPath],
    );

    const updateTruckPosition = useCallback((lineId: string, position: [number, number], info: RoadObjectInfo = {}) => {
        const trackKey = refs.lineTrackMapRef.current.get(lineId);
        const worldPos = mapPosition(position, TRUCK_LIFT);
        if (!worldPos) return;
        if (!trackKey) {
            if (!info.manualMarker) return;
            let marker = refs.manualMarkersRef.current.get(lineId);
            if (!marker) {
                marker = new THREE.Group();
                const dot = new THREE.Mesh(
                    new THREE.SphereGeometry(0.36, 24, 24),
                    new THREE.MeshBasicMaterial({ color: 0x22d3ee })
                );
                const glow = new THREE.Mesh(
                    new THREE.SphereGeometry(0.72, 24, 24),
                    new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.22, depthWrite: false })
                );
                const ring = new THREE.Mesh(
                    new THREE.RingGeometry(0.78, 1.05, 64),
                    new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false })
                );
                ring.rotation.x = Math.PI / 2;
                marker.add(glow, dot, ring);
                marker.userData = {
                    roadId: lineId,
                    objectType: '手动查询车辆',
                    info,
                };
                refs.manualMarkersRef.current.set(lineId, marker);
                refs.sceneRef.current?.add(marker);
            }
            marker.position.copy(worldPos);
            marker.userData.info = { ...(marker.userData.info ?? {}), ...info };
            focusPath([worldPos]);
            return;
        }

        const road = refs.roadsMapRef.current.get(trackKey);
        if (!road) return;
        const existingLane = Array.from(road.orders.values())
            .find((candidate) => candidate.vehicles.has(lineId));
        const lane = existingLane ?? ensureOrderLane(road, orderKeyFor(lineId, info), info);
        const vehicle = existingLane?.vehicles.get(lineId)
            ?? ensureVehicleBar(road, lane, lineId, info);
        vehicle.bar.visible = true;
        vehicle.currentCoords = position;
        vehicle.info = { ...vehicle.info, ...info };
        const authoritativeProgress = Number(info.routeProgress);
        vehicle.progress = Number.isFinite(authoritativeProgress)
            ? clamp01(authoritativeProgress)
            : progressOnRoad(road, worldPos);
        road.currentCoords = position;
        road.info = { ...road.info, ...info };
        updateOrderVisuals(road);
        scheduleSharedRoadColorRangesRefresh();
    }, [ensureOrderLane, ensureVehicleBar, focusPath, refs, scheduleSharedRoadColorRangesRefresh, updateOrderVisuals]);

    const refreshAllPositions = useCallback(() => {
        const ids = Array.from(refs.lineTrackMapRef.current.keys());
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('roadmap:refresh-positions', { detail: ids }));
        }
    }, [refs.lineTrackMapRef]);

    return {
        addRoadPath,
        removeRoadPath,
        clearRoads,
        setRoadsOpacity,
        setRoadPath,
        updateTruckPosition,
        refreshAllPositions,
        paintGreenRoad,
        updateProgressFromTruck,
        focusAllRoads,
        setHighlightedVehicle,
        updateVehicleScaleForCamera,
    };
}
