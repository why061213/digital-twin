import { useCallback } from 'react';
import * as THREE from 'three';
import { easeInOutCubic, disposeObject3D, indexCount, mapPosition } from '../utils';
import { FLY_LINE_DELAY, FLY_GROW_DURATION, FLY_TRAVEL_DURATION, FLY_MIN_LIFETIME } from '../constants';
import { useChinaMapRefs } from './useChinaMapRefs';

export function useFlyLines(
    refs: ReturnType<typeof useChinaMapRefs>,
    focusFreightNodes: (delay?: number) => void,
) {
    const disposeFlyLineNow = useCallback((lineId: string, shouldFocus = true) => {
        const frame = refs.flyAnimFramesRef.current.get(lineId);
        if (frame !== undefined) {
            cancelAnimationFrame(frame);
            refs.flyAnimFramesRef.current.delete(lineId);
        }

        const timeout = refs.flyTimeoutsRef.current.get(lineId);
        if (timeout !== undefined) {
            clearTimeout(timeout);
            refs.flyTimeoutsRef.current.delete(lineId);
        }

        const removalTimeout = refs.flyRemovalTimeoutsRef.current.get(lineId);
        if (removalTimeout !== undefined) {
            clearTimeout(removalTimeout);
            refs.flyRemovalTimeoutsRef.current.delete(lineId);
        }

        refs.pendingFlyRemovalRef.current.delete(lineId);
        refs.flyStartTimesRef.current.delete(lineId);
        refs.activeRouteCoordsRef.current.delete(lineId);

        const group = refs.flyLinesRef.current.get(lineId);
        if (!group) {
            if (shouldFocus) focusFreightNodes(180);
            return;
        }

        refs.sceneRef.current?.remove(group);
        refs.flyLinesRef.current.delete(lineId);
        disposeObject3D(group);
        if (shouldFocus) focusFreightNodes(180);
    }, [refs, focusFreightNodes]);

    const removeFlyLine = useCallback((lineId: string) => {
        refs.pendingFlyRemovalRef.current.add(lineId);
        const startTime = refs.flyStartTimesRef.current.get(lineId);
        if (startTime === undefined) return;

        const elapsed = performance.now() - startTime;
        const remaining = Math.max(0, FLY_MIN_LIFETIME - elapsed);
        const oldRemovalTimeout = refs.flyRemovalTimeoutsRef.current.get(lineId);
        if (oldRemovalTimeout !== undefined) clearTimeout(oldRemovalTimeout);

        if (remaining === 0) {
            disposeFlyLineNow(lineId, false);
            return;
        }

        const removalTimeout = window.setTimeout(() => {
            refs.flyRemovalTimeoutsRef.current.delete(lineId);
            disposeFlyLineNow(lineId);
        }, remaining);
        refs.flyRemovalTimeoutsRef.current.set(lineId, removalTimeout);
    }, [refs, disposeFlyLineNow]);

    const addFlyLine = useCallback((lineId: string, fromCoords: [number, number], toCoords: [number, number]) => {
        disposeFlyLineNow(lineId);
        refs.activeRouteCoordsRef.current.set(lineId, [fromCoords, toCoords]);
        focusFreightNodes(FLY_LINE_DELAY);

        const timeoutId = window.setTimeout(() => {
            const scene = refs.sceneRef.current;
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

            const baseTube = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({
                color: 0x334155, transparent: true, opacity: 0.24, depthWrite: false,
            }));
            const streamMaterial = new THREE.MeshBasicMaterial({
                color: 0x8b9bd8, transparent: true, opacity: 0.58, depthWrite: false,
            });
            const glowMaterial = new THREE.MeshBasicMaterial({
                color: 0xa5b4fc, transparent: true, opacity: 0.12, depthWrite: false,
            });
            const streamTube = new THREE.Mesh(streamGeo, streamMaterial);
            const glowTube = new THREE.Mesh(glowGeo, glowMaterial);

            const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 18), new THREE.MeshBasicMaterial({ color: 0xdbeafe }));
            const halo = new THREE.Mesh(new THREE.SphereGeometry(0.58, 18, 18), new THREE.MeshBasicMaterial({
                color: 0x818cf8, transparent: true, opacity: 0.18, depthWrite: false,
            }));
            head.position.copy(from);
            halo.position.copy(from);

            const tailParticles = Array.from({ length: 4 }, (_, index) => {
                const particle = new THREE.Mesh(
                    new THREE.SphereGeometry(0.12 - index * 0.018, 12, 12),
                    new THREE.MeshBasicMaterial({
                        color: 0xc7d2fe, transparent: true, opacity: 0.34 - index * 0.06, depthWrite: false,
                    })
                );
                particle.position.copy(from);
                particle.visible = false;
                return particle;
            });

            const group = new THREE.Group();
            group.add(glowTube, baseTube, streamTube, ...tailParticles, head, halo);
            scene.add(group);
            refs.flyLinesRef.current.set(lineId, group);
            refs.flyTimeoutsRef.current.delete(lineId);
            refs.flyStartTimesRef.current.set(lineId, performance.now());

            const startTime = performance.now();
            const growDuration = FLY_GROW_DURATION;
            const travelDuration = FLY_TRAVEL_DURATION;

            if (refs.pendingFlyRemovalRef.current.has(lineId)) {
                const removalTimeout = window.setTimeout(() => {
                    refs.flyRemovalTimeoutsRef.current.delete(lineId);
                    disposeFlyLineNow(lineId);
                }, FLY_MIN_LIFETIME);
                refs.flyRemovalTimeoutsRef.current.set(lineId, removalTimeout);
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

                refs.flyAnimFramesRef.current.set(lineId, requestAnimationFrame(step));
            };

            refs.flyAnimFramesRef.current.set(lineId, requestAnimationFrame(step));
        }, FLY_LINE_DELAY);

        refs.flyTimeoutsRef.current.set(lineId, timeoutId);
    }, [refs, disposeFlyLineNow, focusFreightNodes]);

    return { addFlyLine, removeFlyLine, disposeFlyLineNow };
}