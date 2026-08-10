import { useCallback, useState } from 'react';
import * as THREE from 'three';
import type { HoverInfo, RoadObjectInfo } from '../types';
import { formatNumber, screenPosition } from '../utils';
import { useRoadMapRefs } from './useRoadMapRefs';
import { tripBusinessStage } from '../../../playback/rm2RouteIdentity';

function deviationStateLabel(state: RoadObjectInfo['routeDeviationState']) {
    switch (state) {
        case 'BASELINE': return '基准路线';
        case 'SUSPECTED': return '待确认路线不一致';
        case 'ALTERNATIVE': return '合理替代路线';
        case 'EXPECTED': return '疑似货车限制绕行';
        case 'ANOMALOUS': return '疑似异常偏航';
        case 'UNKNOWN': return '定位证据不足';
        default: return '--';
    }
}

export function useRoadSelection(refs: ReturnType<typeof useRoadMapRefs>) {
    const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);

    const setSelectedRoad = useCallback((selectedId: string | null) => {
        refs.selectedRoadIdRef.current = selectedId;
        refs.roadsMapRef.current.forEach((road, id) => {
            const selected = id === selectedId;
            if (road.isSelected === selected) return;
            road.isSelected = selected;

            const grayMat = road.grayTube.material as THREE.MeshBasicMaterial;
            const selectionMat = road.selectionTube.material as THREE.MeshBasicMaterial;
            grayMat.opacity = selected ? 0.88 : 0.7;
            selectionMat.opacity = selected ? 0.2 : 0;
            road.orders.forEach((lane) => {
                const mat = lane.progressTube.material as THREE.MeshBasicMaterial;
                mat.opacity = selected ? 1 : 0.95;
                lane.vehicles.forEach((vehicle) => {
                    vehicle.bar.scale.copy(vehicle.baseScale).multiplyScalar(selected ? 1.12 : 1);
                });
            });
        });
    }, [refs]);

    const findVehicleInfo = useCallback((roadId: string, lineId?: string): { info: RoadObjectInfo; coords: [number, number] } | null => {
        const road = refs.roadsMapRef.current.get(roadId);
        if (!road) return null;
        if (!lineId) return { info: road.info, coords: road.currentCoords };
        for (const lane of road.orders.values()) {
            const vehicle = lane.vehicles.get(lineId);
            if (vehicle) return { info: vehicle.info, coords: vehicle.currentCoords };
        }
        return { info: road.info, coords: road.currentCoords };
    }, [refs.roadsMapRef]);

    const buildHoverInfo = useCallback((roadId: string, objectType: string, x: number, y: number, lineId?: string): HoverInfo | null => {
        const found = findVehicleInfo(roadId, lineId);
        if (!found) return null;
        const { info, coords } = found;
        const routeTitle = `${info.from ?? '--'} -> ${info.to ?? '--'}`;
        return {
            x,
            y,
            title: info.plate ?? (objectType === '车辆进度条' ? '车辆信息' : '路线信息'),
            subtitle: routeTitle,
            status: tripBusinessStage(info),
            rows: [
                ['订单', info.orderName ?? info.orderId ?? '--'],
                ['Trip阶段', tripBusinessStage(info)],
                ['定位质量', info.positionQuality ?? '--'],
                ['订单进度', `${info.pendingOrderCount ?? 0}待装 / ${info.onboardOrderCount ?? 0}在途 / ${info.completedOrderCount ?? 0}完成`],
                ['货物', info.cargo ?? '--'],
                ['当前经度', formatNumber(coords[0], 6)],
                ['当前纬度', formatNumber(coords[1], 6)],
                ['时速', `${formatNumber(info.speedKmh, 1)} km/h`],
                ['路线长度', `${formatNumber(info.routeLengthKm, 1)} km`],
                ['路线判断', deviationStateLabel(info.routeDeviationState)],
                ['判断置信度', info.routeDeviationConfidence == null
                    ? '--'
                    : `${Math.round(info.routeDeviationConfidence * 100)}%`],
            ],
        };
    }, [findVehicleInfo]);

    const updateHoverPosition = useCallback(() => {
        const camera = refs.cameraRef.current;
        const container = refs.containerRef.current;
        const selectedRoadId = refs.selectedRoadIdRef.current;
        if (!camera || !container || !selectedRoadId) return;

        const road = refs.roadsMapRef.current.get(selectedRoadId);
        if (!road) return;

        const label = screenPosition(road.labelAnchor, camera, container);
        setHoverInfo((current) => {
            if (!current) return current;
            if (Math.abs(current.x - label.x) < 0.5 && Math.abs(current.y - label.y) < 0.5) {
                return current;
            }
            return { ...current, x: label.x, y: label.y };
        });
    }, [refs]);

    const clearSelection = useCallback(() => {
        setSelectedRoad(null);
        setHoverInfo(null);
    }, [setSelectedRoad]);

    const handlePointerMove = useCallback((event: PointerEvent) => {
        const camera = refs.cameraRef.current;
        const container = refs.containerRef.current;
        if (!camera || !container) return;

        const canvas = refs.rendererRef.current?.domElement;
        const rect = (canvas ?? container).getBoundingClientRect();
        refs.pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        refs.pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        refs.raycasterRef.current.setFromCamera(refs.pointerRef.current, camera);

        const objects = Array.from(refs.roadsMapRef.current.values()).flatMap((road) => [
            road.grayTube,
            road.selectionTube,
            ...Array.from(road.orders.values()).flatMap((lane) => [
                lane.progressTube,
                ...Array.from(lane.vehicles.values()).map((vehicle) => vehicle.bar),
            ]),
        ]);
        const hit = refs.raycasterRef.current.intersectObjects(objects, false)[0];
        const roadId = hit?.object.userData.roadId;
        if (typeof roadId !== 'string') {
            setSelectedRoad(null);
            setHoverInfo(null);
            return;
        }

        const objectType = String(hit.object.userData.objectType ?? '对象');
        const lineId = typeof hit.object.userData.lineId === 'string' ? hit.object.userData.lineId : undefined;
        setSelectedRoad(roadId);
        const road = refs.roadsMapRef.current.get(roadId);
        const label = road
            ? screenPosition(road.labelAnchor, camera, container)
            : screenPosition(hit.point, camera, container);
        setHoverInfo(buildHoverInfo(roadId, objectType, label.x, label.y, lineId));
    }, [refs, buildHoverInfo, setSelectedRoad]);

    const handlePointerLeave = useCallback(() => {
        clearSelection();
    }, [clearSelection]);

    return {
        hoverInfo,
        setSelectedRoad,
        buildHoverInfo,
        updateHoverPosition,
        clearSelection,
        handlePointerMove,
        handlePointerLeave,
    };
}
