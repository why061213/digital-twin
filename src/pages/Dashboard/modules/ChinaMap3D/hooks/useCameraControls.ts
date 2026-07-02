import { useCallback } from 'react';
import * as THREE from 'three';
import { easeInOutCubic, mapPosition } from '../utils';
import { FOSHAN, FOSHAN_COORDS, CAMERA_TILT_RATIO, CAMERA_CONTROL_DEDUPE_MS } from '../constants';
import { useChinaMapRefs } from './useChinaMapRefs';
import type { CameraFocusMode, CameraPose } from '../types';

export function useCameraControls(
    refs: ReturnType<typeof useChinaMapRefs>,
    setLabelVisibility: (visibility: { mode: 'all' | 'focus'; focusedKey?: string }) => void,
    applyLabelVisibility: () => void,
) {
    const focusPoints = useCallback((points: THREE.Vector3[], startPose?: CameraPose, mode: CameraFocusMode = 'overview') => {
        const camera = refs.cameraRef.current;
        const controls = refs.controlsRef.current;
        const container = refs.containerRef.current;
        if (!camera || !controls || !container || points.length === 0) return Promise.resolve();

        refs.isCameraMovingRef.current = true;
        applyLabelVisibility();

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

        const targetLookAt = new THREE.Vector3(center.x, 0, center.z);
        const southOffset = targetHeight * (mode === 'focus' ? 0.58 : 0.8);
        const targetPosition = new THREE.Vector3(center.x, targetHeight, center.z - southOffset);

        const startPosition = startPose?.position.clone() ?? camera.position.clone();
        const startTarget = startPose?.target.clone() ?? controls.target.clone();
        const duration = mode === 'focus' ? 950 : 1150;
        const startTime = performance.now();

        cancelAnimationFrame(refs.cameraMoveFrameRef.current);
        return new Promise<void>((resolve) => {
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
                    refs.isCameraMovingRef.current = false;
                    applyLabelVisibility();
                    resolve();
                }
            };
            refs.cameraMoveFrameRef.current = requestAnimationFrame(step);
        });
    }, [refs]);

    const focusOnCities = useCallback((cityNames: string[], mode: CameraFocusMode) => {
        const safeMode: CameraFocusMode = mode === 'focus' ? 'focus' : 'overview';
        const safeCityNames = Array.from(new Set(cityNames.filter(Boolean)));
        const requestKey = `${safeMode}:${safeCityNames.slice().sort().join('|')}`;
        const now = performance.now();

        if (!refs.mapGroupRef.current || Object.keys(refs.meshMapRef.current).length === 0) {
            refs.pendingCameraControlRef.current = { cityNames: safeCityNames, mode: safeMode };
            return;
        }

        if (
            !refs.firstCameraControlRef.current &&
            requestKey === refs.lastCameraControlRef.current.key &&
            now - refs.lastCameraControlRef.current.time < CAMERA_CONTROL_DEDUPE_MS
        ) {
            return;
        }
        refs.lastCameraControlRef.current = { key: requestKey, time: now };

        refs.isCameraMovingRef.current = true;
        applyLabelVisibility();

        const points: THREE.Vector3[] = [];
        const collectCityCenter = (cityName: string) => {
            const key = Object.keys(refs.meshMapRef.current).find((name) => name.includes(cityName) || cityName.includes(name));
            const group = key ? refs.meshMapRef.current[key] : undefined;
            if (group) {
                const box = new THREE.Box3().setFromObject(group);
                if (!box.isEmpty()) points.push(box.getCenter(new THREE.Vector3()));
            }
        };

        if (safeMode === 'overview') {
            for (const name of safeCityNames) collectCityCenter(name);
            collectCityCenter(FOSHAN);
            setLabelVisibility({ mode: 'all' });
        } else if (safeMode === 'focus' && safeCityNames.length === 1) {
            collectCityCenter(safeCityNames[0]);
            const focusedKey = Object.keys(refs.meshMapRef.current).find((name) => name.includes(safeCityNames[0]));
            if (focusedKey) setLabelVisibility({ mode: 'focus', focusedKey });
        }

        if (points.length > 0) {
            const startPose = refs.firstCameraControlRef.current ? refs.initialCameraPoseRef.current ?? undefined : undefined;
            refs.firstCameraControlRef.current = false;
            void focusPoints(points, startPose, safeMode);
        } else {
            refs.pendingCameraControlRef.current = { cityNames: safeCityNames, mode: safeMode };
        }
    }, [refs, focusPoints, setLabelVisibility]);

    const focusFreightNodes = useCallback((delay = 0) => {
        const scheduleFocus = () => {
            refs.cameraFocusTimeoutRef.current = null;
            const camera = refs.cameraRef.current;
            const controls = refs.controlsRef.current;
            const container = refs.containerRef.current;
            if (!camera || !controls || !container) return;

            const points = [FOSHAN_COORDS, ...Array.from(refs.activeRouteCoordsRef.current.values()).flat()].map((coords) =>
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
            const targetHeight = THREE.MathUtils.clamp(Math.max(neededHeightByDepth, neededHeightByWidth) * 1.42 + 10, 22, 98);
            const tilt = THREE.MathUtils.clamp(span * CAMERA_TILT_RATIO + 8, 14, 42);

            const startPosition = camera.position.clone();
            const startTarget = controls.target.clone();
            const viewDirection = new THREE.Vector3(camera.position.x - controls.target.x, 0, camera.position.z - controls.target.z);
            if (viewDirection.lengthSq() < 0.001) viewDirection.set(-0.38, 0, 1);
            viewDirection.normalize();
            const targetPosition = new THREE.Vector3(center.x + viewDirection.x * tilt, targetHeight, center.z + viewDirection.z * tilt);
            const targetLookAt = new THREE.Vector3(center.x, 0, center.z);
            const duration = 1100;
            const startTime = performance.now();

            cancelAnimationFrame(refs.cameraMoveFrameRef.current);
            const step = () => {
                const progress = Math.min((performance.now() - startTime) / duration, 1);
                const eased = easeInOutCubic(progress);
                camera.position.lerpVectors(startPosition, targetPosition, eased);
                controls.target.lerpVectors(startTarget, targetLookAt, eased);
                camera.lookAt(controls.target);
                controls.update();
                if (progress < 1) refs.cameraMoveFrameRef.current = requestAnimationFrame(step);
            };
            refs.cameraMoveFrameRef.current = requestAnimationFrame(step);
        };

        if (refs.cameraFocusTimeoutRef.current !== null) window.clearTimeout(refs.cameraFocusTimeoutRef.current);
        refs.cameraFocusTimeoutRef.current = window.setTimeout(scheduleFocus, Math.max(80, delay));
    }, [refs]);

    return { focusPoints, focusOnCities, focusFreightNodes };
}
