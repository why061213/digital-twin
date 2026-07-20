import { useCallback, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mapPosition } from '../geo';
import { disposeObject3D, clamp01, makePathCurve, indexCount } from '../utils';
import { ROAD_LIFT, TRUCK_LIFT, PATH_SAMPLE_COUNT, CAMERA_TILT_RATIO } from '../constants';
import type { RoadState, RoadObjectInfo, OrderLaneState, VehicleBarState } from '../types';
import type { useRoadMapRefs } from './useRoadMapRefs';
import { createRouteVisualLayers } from '../../routeVisuals';
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
const UNIFIED_COLORS = [
    0x00ff88,   // 亮绿色
    0x00ccff,   // 亮青色
    0xffaa00,   // 亮橙色
    0xff44aa,   // 亮粉红
    0xaaff00,   // 亮黄绿
    0x00ffff,   // 纯青色
    0xff8800,   // 深橙色
    0x44aaff,   // 亮蓝色
    0xff0000,   // 纯红色
    0xffff00,   // 纯黄色
    0xff00ff,   // 品红色
    0x00ff00,   // 纯绿色
];

const TRUCK_MODEL_URL = '/models/rm2-truck.glb';
const TRUCK_MODEL_SCALE = 0.25;
const TRUCK_MODEL_Y_OFFSET = -0.31;
const TRUCK_IDLE_VISUAL_SCALE = 0.14;
const VEHICLE_UPGRADE_MS = 420;
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

function vehicleLocatorColor(laneColor: number, lineId: string) {
    const color = new THREE.Color(laneColor);
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    const variant = Array.from(lineId).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
    const lightnessOffset = [-0.08, -0.04, 0, 0.05, 0.1][variant];
    color.setHSL(
        hsl.h,
        THREE.MathUtils.clamp(hsl.s * 0.92 + 0.08, 0.58, 1),
        THREE.MathUtils.clamp(hsl.l + lightnessOffset, 0.42, 0.72),
    );
    return color;
}

function trackKeyFor(id: string, coords: [number, number][], info: RoadObjectInfo) {
    if (info.pathKey) return info.pathKey;
    return coords.map(([lng, lat]) => `${lng.toFixed(4)},${lat.toFixed(4)}`).join('|') || id;
}

function orderKeyFor(lineId: string, info: RoadObjectInfo) {
    return info.orderFamilyId ?? info.orderId ?? `order-${lineId}`;
}

function orderColor(orderId: string, index: number) {
    let hash = 0;
    for (const char of orderId) hash += char.charCodeAt(0);
    return UNIFIED_COLORS[(hash + index) % UNIFIED_COLORS.length];
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

function setVehicleBarTransform(road: RoadState, lane: OrderLaneState, vehicle: VehicleBarState) {
    const { point, tangent } = pointAndTangentAtProgress(road, vehicle.progress);
    const laneCount = Math.max(1, road.orders.size);
    const laneOffset = (lane.laneIndex - (laneCount - 1) / 2) * 0.2;
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const position = point
        .add(normal.clone().multiplyScalar(laneOffset))
        .setY(TRUCK_LIFT + 0.05 + lane.laneIndex * 0.0035);

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
            if (vehicle) return { road, lane, vehicle };
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
            THREE.MathUtils.lerp(TRUCK_IDLE_VISUAL_SCALE, 1, progress),
        );
    }, []);

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

    const createTruckVisual = useCallback((template: THREE.Object3D, vehicle: VehicleBarState, laneColor: number) => {
        const visual = new THREE.Group();
        const model = cloneTruckTemplate(template);
        model.scale.setScalar(TRUCK_MODEL_SCALE);
        model.position.y = TRUCK_MODEL_Y_OFFSET;
        const locatorColor = vehicleLocatorColor(laneColor, vehicle.lineId);
        const locator = new THREE.Mesh(
            new THREE.RingGeometry(1.05, 1.2, 64),
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
    }, []);

    const ensureVehicleTruck = useCallback(async (vehicle: VehicleBarState) => {
        try {
            const template = await loadTruckTemplate();
            const current = findVehicle(vehicle.lineId);
            if (current?.vehicle !== vehicle) return;
            if (!vehicle.truckVisual) createTruckVisual(template, vehicle, current.lane.color);
            setVehicleBarTransform(current.road, current.lane, vehicle);
            applyUpgradeVisual(vehicle);
        } catch (error) {
            console.warn('[RM1 truck model] load failed; keeping vehicle bar', {
                lineId: vehicle.lineId,
                error,
            });
        }
    }, [applyUpgradeVisual, createTruckVisual, findVehicle]);

    const upgradeVehicle = useCallback(async (vehicle: VehicleBarState) => {
        const generation = highlightGenerationRef.current;
        try {
            const template = await loadTruckTemplate();
            const current = findVehicle(vehicle.lineId);
            if (generation !== highlightGenerationRef.current
                || highlightedLineIdRef.current !== vehicle.lineId
                || current?.vehicle !== vehicle) {
                return;
            }
            if (!vehicle.truckVisual) createTruckVisual(template, vehicle, current.lane.color);
            setVehicleBarTransform(current.road, current.lane, vehicle);
            const locator = vehicle.truckVisual?.userData.locator;
            if (locator instanceof THREE.Object3D) locator.visible = true;
            animateVehicleUpgrade(vehicle, 1);
        } catch (error) {
            console.warn('[RM1 truck model] load failed; keeping vehicle bar', {
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
            const baseRadius = 0.105 * routeWidthFactor;
            road.grayTube.geometry.dispose();
            road.grayTube.geometry = new THREE.TubeGeometry(road.pathCurve, road.tubularSegments, baseRadius, road.radialSegments, false);
            road.selectionTube.geometry.dispose();
            road.selectionTube.geometry = new THREE.TubeGeometry(road.pathCurve, road.tubularSegments, baseRadius + 0.075, road.radialSegments, false);
            road.renderedOrderCount = orderCount;
        }

        Array.from(road.orders.values()).forEach((lane, laneIndex) => {
            lane.laneIndex = laneIndex;
            const vehicles = Array.from(lane.vehicles.values());
            lane.maxProgress = Math.max(0, ...vehicles.map((vehicle) => vehicle.progress));
            const leadVehicle = vehicles.reduce<VehicleBarState | null>((lead, vehicle) => {
                if (!lead || vehicle.progress > lead.progress) return vehicle;
                return lead;
            }, null);
            lane.progressTube.position.y = 0.04 + laneIndex * 0.055;
            drawTubeProgress(lane.progressTube, lane.maxProgress, road.tubularSegments, road.radialSegments);
            vehicles.forEach((vehicle, vehicleIndex) => {
                const material = vehicle.bar.material as THREE.MeshBasicMaterial;
                const isLead = vehicle === leadVehicle;

                // 1. 选择颜色
                if (isLead) {
                    material.color.setHex(lane.color);
                } else {
                    // 跟随车辆：从统一颜色库中选一个与当前车道颜色不同的颜色
                    let followerColorIndex = (laneIndex + vehicleIndex) % UNIFIED_COLORS.length;
                    if (UNIFIED_COLORS[followerColorIndex] === lane.color) {
                        followerColorIndex = (followerColorIndex + 1) % UNIFIED_COLORS.length;
                    }
                    material.color.setHex(UNIFIED_COLORS[followerColorIndex]);
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
                        ? { x: 1.08, y: 1.22, z: 1.08 }
                        : { x: 0.65, y: 0.80, z: 0.65 };
                vehicle.baseScale.set(baseScale.x, baseScale.y, baseScale.z);
                vehicle.bar.scale.copy(vehicle.baseScale);

                // 4. 渲染顺序
                vehicle.bar.renderOrder = isLead ? 36 : 18 + (vehicleIndex % 8);

                setVehicleBarTransform(road, lane, vehicle);
                syncVehicleAlertRipple(vehicle);
            });
        });
    }, []);

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

        const box = new THREE.Box3().setFromPoints(points);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
        const neededHeightByDepth = size.z / (2 * Math.tan(verticalFov / 2));
        const neededHeightByWidth = size.x / (2 * Math.tan(horizontalFov / 2));
        const span = Math.max(size.x, size.z, 1);
        const height = THREE.MathUtils.clamp(Math.max(neededHeightByDepth, neededHeightByWidth) * 1.55 + 10, 24, 132);
        const tilt = THREE.MathUtils.clamp(span * CAMERA_TILT_RATIO + 10, 16, 48);
        const viewDirection = new THREE.Vector3(
            camera.position.x - controls.target.x,
            0,
            camera.position.z - controls.target.z
        );
        if (viewDirection.lengthSq() < 0.001) viewDirection.set(-0.34, 0, 1);
        viewDirection.normalize();

        const targetPosition = new THREE.Vector3(center.x + viewDirection.x * tilt, height, center.z + viewDirection.z * tilt);
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
                points.push(road.samples[0]);
                points.push(road.samples[road.samples.length - 1]);
                points.push(road.samples[Math.floor(road.samples.length * 0.5)]);
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
        // Preserve the requested line across an atomic same-group rebuild. The newly
        // created vehicle bar upgrades itself when that line is registered again.
        highlightGenerationRef.current += 1;
        Array.from(refs.roadsMapRef.current.keys()).forEach((id) => clearRoad(id));
        refs.roadsMapRef.current.clear();
        refs.lineTrackMapRef.current.clear();
        refs.selectedRoadIdRef.current = null;
    }, [clearRoad, refs]);

    const ensureOrderLane = useCallback((road: RoadState, orderId: string) => {
        let lane = road.orders.get(orderId);
        if (lane) return lane;

        const laneIndex = road.orders.size;
        const color = orderColor(orderId, laneIndex);
        const progressGeo = new THREE.TubeGeometry(road.pathCurve, road.tubularSegments, 0.072, road.radialSegments, false);
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
        road.group.add(progressTube);

        lane = {
            orderId,
            color,
            progressTube,
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
            new THREE.BoxGeometry(0.28, 0.07, 0.1),
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
                const lane = ensureOrderLane(existing, orderId);
                ensureVehicleBar(existing, lane, id, info);
                existing.info = { ...existing.info, ...info };
                updateOrderVisuals(existing);
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
            const cumulativeLengths: number[] = [0];
            for (let i = 1; i < samples.length; i++) {
                cumulativeLengths[i] = cumulativeLengths[i - 1] + samples[i - 1].distanceTo(samples[i]);
            }

            const grayTube = new THREE.Mesh(
                new THREE.TubeGeometry(pathCurve, tubularSegments, 0.08, radialSegments, false),
                new THREE.MeshBasicMaterial({
                    color: 0x6b7280,       // 更浅的灰（原 0x475569）
                    transparent: true,
                    opacity: 0.45,         // 更透明（原 0.7）
                    depthWrite: false,
                })
            );
            grayTube.renderOrder = 2;
            grayTube.userData = { roadId: pathKey, objectType: '共享路线' };

            const selectionTube = new THREE.Mesh(new THREE.TubeGeometry(pathCurve, tubularSegments, 0.17, radialSegments, false), new THREE.MeshBasicMaterial({
                color: 0x38bdf8,
                transparent: true,
                opacity: 0,
                depthWrite: false,
            }));
            selectionTube.renderOrder = 12;
            selectionTube.userData = { roadId: pathKey, objectType: '共享路线' };

            const labelAnchor = samples[Math.floor(samples.length * 0.58)]?.clone() ?? samples[0].clone();
            labelAnchor.x += 1.25;
            labelAnchor.y = TRUCK_LIFT + 3.25;
            labelAnchor.z += 0.95;

            const group = new THREE.Group();
            group.add(
                createRouteVisualLayers(pathCurve, tubularSegments, radialSegments, samples, 'rm1', info),
                grayTube,
                selectionTube,
            );
            scene.add(group);

            const road: RoadState = {
                pathKey,
                group,
                pathCurve,
                grayTube,
                selectionTube,
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
            };

            refs.roadsMapRef.current.set(pathKey, road);
            const lane = ensureOrderLane(road, orderId);
            ensureVehicleBar(road, lane, id, info);
            updateOrderVisuals(road);
            focusAllRoads();
        },
        [ensureOrderLane, ensureVehicleBar, focusAllRoads, refs, updateOrderVisuals],
    );

    const removeRoadPath = useCallback((id: string) => {
        const trackKey = refs.lineTrackMapRef.current.get(id);
        if (!trackKey) {
            clearRoad(id);
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
            cancelTruckHeadingAnimation(vehicle);
            lane.vehicles.delete(id);
            road.group.remove(vehicle.bar);
            disposeObject3D(vehicle.bar);
            if (lane.vehicles.size === 0) {
                road.group.remove(lane.progressTube);
                disposeObject3D(lane.progressTube);
                road.orders.delete(lane.orderId);
            }
        });
        road.lineIds.delete(id);
        refs.lineTrackMapRef.current.delete(id);
        if (road.lineIds.size === 0) {
            clearRoad(trackKey);
            return;
        }
        updateOrderVisuals(road);
    }, [clearRoad, refs, updateOrderVisuals]);

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
        const orderId = orderKeyFor(lineId, info);
        const lane = ensureOrderLane(road, orderId);
        const vehicle = ensureVehicleBar(road, lane, lineId, info);
        vehicle.currentCoords = position;
        vehicle.info = { ...vehicle.info, ...info };
        vehicle.progress = progressOnRoad(road, worldPos);
        road.currentCoords = position;
        road.info = { ...road.info, ...info };
        updateOrderVisuals(road);
    }, [ensureOrderLane, ensureVehicleBar, focusPath, refs, updateOrderVisuals]);

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
        setRoadPath,
        updateTruckPosition,
        refreshAllPositions,
        paintGreenRoad,
        updateProgressFromTruck,
        focusAllRoads,
        setHighlightedVehicle,
    };
}
