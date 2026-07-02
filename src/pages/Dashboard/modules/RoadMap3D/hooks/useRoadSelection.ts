import { useCallback, useState } from 'react';
import * as THREE from 'three';
import type { HoverInfo } from '../types';
import { formatNumber, screenPosition } from '../utils';
import { useRoadMapRefs } from './useRoadMapRefs';

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
            const greenMat = road.greenTube.material as THREE.MeshBasicMaterial;
            const glowMat = road.truckGlow.material as THREE.MeshBasicMaterial;
            const ringMat = road.selectionRing.material as THREE.MeshBasicMaterial;

            grayMat.opacity = selected ? 0.9 : 0.76;
            selectionMat.opacity = selected ? 0.22 : 0;
            greenMat.opacity = selected ? 1 : 0.92;
            glowMat.opacity = selected ? 0.42 : 0.24;
            ringMat.opacity = selected ? 0.34 : 0;
            road.truck.scale.setScalar(selected ? 1.12 : 1);
            road.truckGlow.scale.setScalar(selected ? 1.12 : 1);
        });
    }, [refs]);

    const buildHoverInfo = useCallback((roadId: string, objectType: string, x: number, y: number): HoverInfo | null => {
        const road = refs.roadsMapRef.current.get(roadId);
        if (!road) return null;
        const info = road.info;
        const coords = road.currentCoords;
        const routeTitle = `${info.from ?? '--'} -> ${info.to ?? '--'}`;
        return {
            x,
            y,
            title: info.plate ?? (objectType === '车辆' || objectType === '车辆光晕' ? '车辆信息' : '路线信息'),
            subtitle: routeTitle,
            status: info.status ?? '--',
            rows: [
                ['货物', info.cargo ?? '--'],
                ['当前经度', formatNumber(coords[0], 6)],
                ['当前纬度', formatNumber(coords[1], 6)],
                ['时速', `${formatNumber(info.speedKmh, 1)} km/h`],
                ['路线长度', `${formatNumber(info.routeLengthKm, 1)} km`],
            ],
        };
    }, [refs.roadsMapRef]);

    const handlePointerMove = useCallback((event: PointerEvent) => {
        const camera = refs.cameraRef.current;
        const container = refs.containerRef.current;
        if (!camera || !container) return;

        const rect = container.getBoundingClientRect();
        refs.pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        refs.pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        refs.raycasterRef.current.setFromCamera(refs.pointerRef.current, camera);

        const objects = Array.from(refs.roadsMapRef.current.values()).flatMap((road) => [
            road.truck,
            road.truckGlow,
            road.greenTube,
            road.grayTube,
            road.selectionTube,
        ]);
        const hit = refs.raycasterRef.current.intersectObjects(objects, false)[0];
        const roadId = hit?.object.userData.roadId;
        if (typeof roadId !== 'string') {
            setSelectedRoad(null);
            setHoverInfo(null);
            return;
        }

        const objectType = String(hit.object.userData.objectType ?? '对象');
        setSelectedRoad(roadId);
        const road = refs.roadsMapRef.current.get(roadId);
        const label = road
            ? screenPosition(road.labelAnchor, camera, container)
            : screenPosition(hit.point, camera, container);
        setHoverInfo(buildHoverInfo(roadId, objectType, label.x, label.y));
    }, [refs, buildHoverInfo, setSelectedRoad]);

    const handlePointerLeave = useCallback(() => {
        setSelectedRoad(null);
        setHoverInfo(null);
    }, [setSelectedRoad]);

    return {
        hoverInfo,
        setSelectedRoad,
        buildHoverInfo,
        handlePointerMove,
        handlePointerLeave,
    };
}