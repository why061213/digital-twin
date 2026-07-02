import { useCallback } from 'react';
import * as THREE from 'three';
import { DragControls } from 'three/examples/jsm/controls/DragControls.js';
import { mapPosition } from '../geo';
import { disposeObject3D, clamp01, makePathCurve, indexCount } from '../utils';
import { ROAD_LIFT, TRUCK_LIFT, PATH_SAMPLE_COUNT, CAMERA_TILT_RATIO } from '../constants';
import type { RoadState, RoadObjectInfo } from '../types';
import type { useRoadMapRefs } from './useRoadMapRefs';

export function useRoadControls(
    refs: ReturnType<typeof useRoadMapRefs>,
) {
    // 通用绿色进度绘制
    const paintGreenRoad = useCallback((tube: THREE.Mesh, progress: number, tubularSegments: number, radialSegments: number) => {
        if (!tube) return;
        const p = clamp01(progress);
        const totalIndexCount = indexCount(tube.geometry);
        if (p <= 0 || tubularSegments <= 0 || totalIndexCount <= 0) {
            tube.geometry.setDrawRange(0, 0);
            return;
        }
        const completedSegments = Math.max(1, Math.ceil(p * tubularSegments));
        const drawCount = Math.min(totalIndexCount, completedSegments * radialSegments * 6);
        tube.geometry.setDrawRange(0, drawCount);
    }, []);

    // 根据货车位置更新指定道路的进度
    const updateProgressFromTruck = useCallback((roadId: string) => {
        const road = refs.roadsMapRef.current.get(roadId);
        if (!road) return;
        const { truck, samples, cumulativeLengths, totalLength, greenTube, tubularSegments, radialSegments, progressRef } = road;
        if (!truck || samples.length < 2 || cumulativeLengths.length !== samples.length || totalLength <= 0) return;

        const truckPos = truck.position;
        let nearestDistanceSq = Number.POSITIVE_INFINITY;
        let distanceAlongPath = 0;

        for (let i = 0; i < samples.length - 1; i++) {
            const start = samples[i];
            const end = samples[i + 1];
            const abX = end.x - start.x;
            const abZ = end.z - start.z;
            const segmentLengthSq = abX * abX + abZ * abZ;
            if (segmentLengthSq <= 0.000001) continue;

            const apX = truckPos.x - start.x;
            const apZ = truckPos.z - start.z;
            const segmentProgress = clamp01((apX * abX + apZ * abZ) / segmentLengthSq);
            const projectedX = start.x + abX * segmentProgress;
            const projectedZ = start.z + abZ * segmentProgress;
            const dx = truckPos.x - projectedX;
            const dz = truckPos.z - projectedZ;
            const distanceSq = dx * dx + dz * dz;

            if (distanceSq < nearestDistanceSq) {
                nearestDistanceSq = distanceSq;
                distanceAlongPath = cumulativeLengths[i] + Math.sqrt(segmentLengthSq) * segmentProgress;
            }
        }

        const nextProgress = clamp01(distanceAlongPath / totalLength);
        progressRef.current = nextProgress;
        paintGreenRoad(greenTube, nextProgress, tubularSegments, radialSegments);
    }, [refs.roadsMapRef, paintGreenRoad]);

    // 镜头聚焦到一组点
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

        camera.position.set(center.x + viewDirection.x * tilt, height, center.z + viewDirection.z * tilt);
        controls.target.set(center.x, 0, center.z);
        controls.update();
    }, [refs]);

    // 移除单条道路
    const clearRoad = useCallback((id: string) => {
        const road = refs.roadsMapRef.current.get(id);
        if (!road) return;
        road.dragControls.dispose();
        refs.sceneRef.current?.remove(road.group);
        disposeObject3D(road.group);
        refs.roadsMapRef.current.delete(id);
    }, [refs]);

    const clearRoads = useCallback(() => {
        Array.from(refs.roadsMapRef.current.keys()).forEach((id) => clearRoad(id));
        refs.roadsMapRef.current.clear();
    }, [clearRoad, refs.roadsMapRef]);

    // 添加一条道路
    const addRoadPath = useCallback(
        (id: string, coords: [number, number][], info: RoadObjectInfo = {}) => {
            const scene = refs.sceneRef.current;
            if (!scene || coords.length < 2) return;

            clearRoad(id); // 如果已存在同 ID 则先移除

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

            // 灰色底路
            const grayTubeGeo = new THREE.TubeGeometry(pathCurve, tubularSegments, 0.08, radialSegments, false);
            const grayTube = new THREE.Mesh(grayTubeGeo, new THREE.MeshBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.76 }));
            grayTube.userData = { roadId: id, objectType: '路线' };

            const selectionTubeGeo = new THREE.TubeGeometry(pathCurve, tubularSegments, 0.16, radialSegments, false);
            const selectionTube = new THREE.Mesh(selectionTubeGeo, new THREE.MeshBasicMaterial({
                color: 0x38bdf8, transparent: true, opacity: 0, depthWrite: false,
            }));
            selectionTube.userData = { roadId: id, objectType: '路线' };

            // 绿色覆盖路
            const greenTubeGeo = new THREE.TubeGeometry(pathCurve, tubularSegments, 0.105, radialSegments, false);
            greenTubeGeo.setDrawRange(0, 0);
            const greenTube = new THREE.Mesh(greenTubeGeo, new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.92 }));
            greenTube.userData = { roadId: id, objectType: '已行驶路线' };

            // 货车与光晕
            const startPoint = samples[0].clone();
            startPoint.y = TRUCK_LIFT;
            const labelAnchor = samples[Math.floor(samples.length * 0.58)]?.clone() ?? startPoint.clone();
            labelAnchor.x += 1.25;
            labelAnchor.y = TRUCK_LIFT + 3.25;
            labelAnchor.z += 0.95;
            const truck = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffb020 }));
            const truckGlow = new THREE.Mesh(new THREE.SphereGeometry(0.48, 16, 16), new THREE.MeshBasicMaterial({
                color: 0xffb020, transparent: true, opacity: 0.24, depthWrite: false,
            }));
            const selectionRing = new THREE.Mesh(
                new THREE.RingGeometry(0.45, 0.62, 48),
                new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
            );
            truck.position.copy(startPoint);
            truckGlow.position.copy(startPoint);
            selectionRing.position.copy(startPoint);
            selectionRing.rotation.x = Math.PI / 2;
            truck.userData = { roadId: id, objectType: '车辆' };
            truckGlow.userData = { roadId: id, objectType: '车辆光晕' };

            const group = new THREE.Group();
            group.add(grayTube, selectionTube, greenTube, selectionRing, truck, truckGlow);
            scene.add(group);

            const progressRef = { current: 0 };
            const road: RoadState = {
                group, grayTube, selectionTube, greenTube, truck, truckGlow, selectionRing,
                dragControls: null as any,
                samples, cumulativeLengths,
                totalLength: cumulativeLengths[cumulativeLengths.length - 1] ?? 0,
                tubularSegments, radialSegments, progressRef,
                currentCoords: coords[0],
                labelAnchor,
                info,
                isSelected: false,
            };

            // 拖拽
            if (refs.rendererRef.current && refs.cameraRef.current) {
                const dragControls = new DragControls([truck], refs.cameraRef.current, refs.rendererRef.current.domElement);
                dragControls.addEventListener('dragstart', () => {
                    if (refs.controlsRef.current) refs.controlsRef.current.enabled = false;
                });
                dragControls.addEventListener('drag', () => {
                    const draggedId = truck.userData.roadId;
                    if (draggedId) {
                        truck.position.y = TRUCK_LIFT;
                        truckGlow.position.copy(truck.position);
                        updateProgressFromTruck(draggedId);
                    }
                });
                dragControls.addEventListener('dragend', () => {
                    const draggedId = truck.userData.roadId;
                    if (draggedId) {
                        truck.position.y = TRUCK_LIFT;
                        truckGlow.position.copy(truck.position);
                        updateProgressFromTruck(draggedId);
                    }
                    if (refs.controlsRef.current) refs.controlsRef.current.enabled = true;
                });
                road.dragControls = dragControls;
            }

            refs.roadsMapRef.current.set(id, road);
            focusPath(points);
        },
        [refs, clearRoad, updateProgressFromTruck, focusPath, paintGreenRoad],
    );

    const removeRoadPath = useCallback((id: string) => clearRoad(id), [clearRoad]);

    const setRoadPath = useCallback(
        (coords: [number, number][]) => {
            const id = `road_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            addRoadPath(id, coords);
        },
        [addRoadPath],
    );

    const updateTruckPosition = useCallback((lineId: string, position: [number, number], info: RoadObjectInfo = {}) => {
        const road = refs.roadsMapRef.current.get(lineId);
        if (!road) return;
        const worldPos = mapPosition(position, TRUCK_LIFT);
        if (!worldPos) return;
        road.truck.position.copy(worldPos);
        road.truckGlow.position.copy(worldPos);
        road.selectionRing.position.copy(worldPos);
        road.currentCoords = position;
        road.info = { ...road.info, ...info };
        updateProgressFromTruck(lineId);
    }, [refs.roadsMapRef, updateProgressFromTruck]);

    return {
        addRoadPath,
        removeRoadPath,
        clearRoads,
        setRoadPath,
        updateTruckPosition,
        paintGreenRoad,
        updateProgressFromTruck,
    };
}