import { useCallback } from 'react';
import * as THREE from 'three';
import { FOSHAN } from '../constants';
import { WAREHOUSE_TOUR_START_DELAY, WAREHOUSE_TOUR_FOCUS_HOLD, WAREHOUSE_TOUR_OVERVIEW_HOLD, WAREHOUSE_TOUR_LOOP_HOLD } from '../constants';
import { useChinaMapRefs } from './useChinaMapRefs';
import type { CameraFocusMode } from '../types';

export function useWarehouseTour(
    refs: ReturnType<typeof useChinaMapRefs>,
    focusPoints: (points: THREE.Vector3[], startPose?: any, mode?: CameraFocusMode) => Promise<void>,
    refreshWarehouseLabels: () => void,
    setLabelVisibility: (visibility: { mode: 'all' | 'focus'; focusedKey?: string }) => void,
    findCityKey: (cityName: string) => string | undefined,
    showCachedCityPanels: (cityName: string) => boolean,
    onTourStateChange?: (state: { mode: 'overview' | 'focus'; cityName?: string; displayData?: Record<string, any> }) => void,
    onLoopCompleted?: () => void,
) {
    const startWarehouseTour = useCallback(() => {
        const runId = refs.warehouseTourRunRef.current + 1;
        refs.warehouseTourRunRef.current = runId;
        refs.firstCameraControlRef.current = false;

        if (refs.warehouseTourTimeoutRef.current !== null) {
            window.clearTimeout(refs.warehouseTourTimeoutRef.current);
            refs.warehouseTourTimeoutRef.current = null;
        }

        const wait = (delay: number) => new Promise<void>((resolve) => {
            refs.warehouseTourTimeoutRef.current = window.setTimeout(() => {
                refs.warehouseTourTimeoutRef.current = null;
                resolve();
            }, delay);
        });

        const cityCenterByKey = (key: string) => {
            const group = refs.meshMapRef.current[key];
            if (!group) return null;
            const box = new THREE.Box3().setFromObject(group);
            return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
        };

        const cityDisplayDataByKey = (key: string) => {
            const group = refs.meshMapRef.current[key];
            return group?.userData.displayData ?? {};
        };

        const runTour = async () => {
            await wait(WAREHOUSE_TOUR_START_DELAY);
            if (refs.warehouseTourRunRef.current !== runId) return;

            let isFirstLoop = true;
            while (refs.warehouseTourRunRef.current === runId) {
                const warehouseKeys = Object.entries(refs.meshMapRef.current)
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

                refs.isCameraMovingRef.current = true;
                setLabelVisibility({ mode: 'all' });
                onTourStateChange?.({ mode: 'overview' });
                await focusPoints(overviewPoints, isFirstLoop ? refs.initialCameraPoseRef.current ?? undefined : undefined, 'overview');
                isFirstLoop = false;
                if (refs.warehouseTourRunRef.current !== runId) return;
                await wait(WAREHOUSE_TOUR_OVERVIEW_HOLD);

                for (const key of warehouseKeys) {
                    if (refs.warehouseTourRunRef.current !== runId) return;
                    const center = cityCenterByKey(key);
                    if (!center) continue;
                    refs.isCameraMovingRef.current = true;
                    setLabelVisibility({ mode: 'focus', focusedKey: key });
                    onTourStateChange?.({ mode: 'overview' });
                    await focusPoints([center], undefined, 'focus');
                    if (refs.warehouseTourRunRef.current !== runId) return;
                    showCachedCityPanels(key);
                    onTourStateChange?.({
                        mode: 'focus',
                        cityName: key,
                        displayData: cityDisplayDataByKey(key),
                    });
                    refreshWarehouseLabels();
                    await wait(WAREHOUSE_TOUR_FOCUS_HOLD);
                }

                if (refs.warehouseTourRunRef.current !== runId) return;
                refs.isCameraMovingRef.current = true;
                setLabelVisibility({ mode: 'all' });
                onTourStateChange?.({ mode: 'overview' });
                await focusPoints(overviewPoints, undefined, 'overview');
                if (refs.warehouseTourRunRef.current !== runId) return;
                refreshWarehouseLabels();
                onLoopCompleted?.();
                await wait(WAREHOUSE_TOUR_LOOP_HOLD);
            }
        };

        void runTour();
    }, [refs, focusPoints, refreshWarehouseLabels, setLabelVisibility, findCityKey, showCachedCityPanels, onTourStateChange, onLoopCompleted]);

    return { startWarehouseTour };
}
