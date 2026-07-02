import { useCallback } from 'react';
import * as THREE from 'three';
import { LABEL_CONFIG } from '@/config/labelLayout';
import { octagonStartOffset } from '../utils.ts'
import { projectToScreen, equalCircleOverlapRatio, warehouseLabelHtml, labelAnchorScale } from '../labelUtils';
import { useChinaMapRefs } from './useChinaMapRefs';
import type { MarkedWarehouse, LabelLayout } from '../types';

export function useWarehouseLabels(refs: ReturnType<typeof useChinaMapRefs>) {
    const applyLabelVisibility = useCallback(() => {
        console.log('👁️ focusedKey:', refs.labelVisibilityRef.current.focusedKey);
        console.log('🗺️ 面板 keys:', Array.from(refs.cityPanelMapRef.current.keys()));
        const visibility = refs.labelVisibilityRef.current;
        refs.cityLabelMapRef.current.forEach((labelObj, key) => {
            const element = labelObj.element as HTMLDivElement;
            const shouldShow = visibility.mode !== 'focus' || key === visibility.focusedKey;
            element.style.display = shouldShow ? 'block' : 'none';
            element.style.visibility = shouldShow ? 'visible' : 'hidden';
            element.style.transition = 'opacity 220ms ease';
            element.style.opacity = shouldShow && !refs.isCameraMovingRef.current ? '1' : '0';
        });
        refs.cityPanelMapRef.current.forEach((panel, key) => {
            const shouldShow = refs.labelVisibilityRef.current.mode === 'focus' &&
                key === refs.labelVisibilityRef.current.focusedKey;
            panel.style.display = shouldShow ? 'block' : 'none';
            panel.style.opacity = shouldShow && !refs.isCameraMovingRef.current ? '1' : '0';
            panel.style.pointerEvents = shouldShow && !refs.isCameraMovingRef.current ? 'none' : 'none';
            if (shouldShow && !refs.isCameraMovingRef.current) {
                // 显示后触发 echarts 重绘
                window.setTimeout(() => {
                    refs.cityPanelChartsRef.current.get(key)?.forEach(chart => chart.resize());
                }, 0);
            }
        });
        if (refs.labelRendererRef.current) {
            refs.labelRendererRef.current.domElement.style.opacity = refs.isCameraMovingRef.current ? '0' : '1';
        }
    }, [refs]);

    const setLabelVisibility = useCallback((visibility: { mode: 'all' | 'focus'; focusedKey?: string }) => {
        refs.labelVisibilityRef.current = visibility;
        applyLabelVisibility();
    }, [refs, applyLabelVisibility]);

    const refreshWarehouseLabels = useCallback(() => {
        const camera = refs.cameraRef.current;
        const controls = refs.controlsRef.current;
        const container = refs.containerRef.current;
        if (!camera || !controls || !container) return;
        const cameraDistance = camera.position.distanceTo(controls.target);
        const zoomScale = THREE.MathUtils.clamp(LABEL_CONFIG.zoomScaleFactor / Math.max(cameraDistance, 1), 0.5, 1.08);
        const anchorScale = labelAnchorScale(camera);
        const isFocusMode = refs.labelVisibilityRef.current.mode === 'focus';

        const entries = Object.entries(refs.meshMapRef.current)
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
                const visibility = refs.labelVisibilityRef.current;
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
                    clusterB.forEach((name) => { clusterA.add(name); clusters.set(name, clusterA); });
                }
            }
        }

        entries.forEach((item) => {
            let density = 0;
            let nearestDistance = Number.POSITIVE_INFINITY;
            const current = item.screen.clone();
            const cluster = findCluster(item.name);
            const clusterItems = entries.filter((entry) => cluster.has(entry.name));
            const clusterCenter = clusterItems.reduce((acc, entry) => acc.add(entry.screen.clone()), new THREE.Vector2()).multiplyScalar(1 / clusterItems.length);
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
                if (distance < nearestDistance) nearestDistance = distance;
            });

            const clusterOutward = current.clone().sub(clusterCenter);
            if (clusterOutward.lengthSq() < 0.001) clusterOutward.copy(current.clone().sub(screenCenter));
            if (clusterOutward.lengthSq() < 0.001) clusterOutward.set(1, -0.35);
            clusterOutward.normalize();

            const outward = current.clone().sub(screenCenter);
            if (outward.lengthSq() < 0.001) outward.set(1, -0.35);
            outward.normalize();
            const direction = clusterOutward
                .multiplyScalar(clusterItems.length > 1 ? LABEL_CONFIG.clusterOutwardStrong : LABEL_CONFIG.clusterOutwardWeak)
                .add(localRepulsion)
                .add(overlapRepulsion.multiplyScalar(LABEL_CONFIG.overlapDirectionScale))
                .add(globalRepulsion)
                .add(outward.multiplyScalar(LABEL_CONFIG.outwardWeight));
            if (direction.lengthSq() < 0.001) direction.copy(outward);
            direction.normalize();

            const hash = Array.from(item.name).reduce((sum, char) => sum + char.charCodeAt(0), 0);
            const rawLabelDistance = THREE.MathUtils.clamp(
                LABEL_CONFIG.minDistance + density * LABEL_CONFIG.densityFactor + Math.max(0, LABEL_CONFIG.neighborRadius - nearestDistance) * LABEL_CONFIG.nearestDistanceFactor,
                LABEL_CONFIG.minDistance,
                LABEL_CONFIG.maxDistance
            );
            const labelDistance = THREE.MathUtils.clamp(rawLabelDistance * zoomScale, LABEL_CONFIG.zoomClampMin, LABEL_CONFIG.maxDistance);
            const labelStartOffset: [number, number] = isFocusMode ? octagonStartOffset(0, anchorScale) : [0, 0];
            let x = labelStartOffset[0] + direction.x * labelDistance;
            const verticalBias = Math.abs(direction.y) < 0.22 ? ((hash % 3) - 1) * LABEL_CONFIG.verticalBiasRange : 0;
            let y = labelStartOffset[1] + direction.y * labelDistance * LABEL_CONFIG.verticalCompression + verticalBias;
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
                    if (away.lengthSq() < 0.001) away.set(x || 1, y || -1);
                    away.normalize();
                    const horizontalPush = (LABEL_CONFIG.cardWidth / 2 + LABEL_CONFIG.citySafeMargin) - Math.abs(other.screen.x - cardCenter.x);
                    const verticalPush = (LABEL_CONFIG.cardHeight / 2 + LABEL_CONFIG.citySafeMargin) - Math.abs(other.screen.y - cardCenter.y);
                    if (verticalPush > 0) y += Math.sign(away.y || -1) * Math.min(LABEL_CONFIG.maxVerticalPush, verticalPush * LABEL_CONFIG.verticalPushFactor);
                    if (horizontalPush > 0) x += Math.sign(away.x || (x >= 0 ? 1 : -1)) * Math.min(LABEL_CONFIG.maxHorizontalPush, horizontalPush * LABEL_CONFIG.horizontalPushFactor);
                    align = x < 0 ? 'right' : 'left';
                });
            }

            item.group.userData.labelLayout = { x, y, align, startOffset: labelStartOffset } satisfies LabelLayout;
            const labelObj = refs.cityLabelMapRef.current.get(item.name);
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
    }, [refs, applyLabelVisibility]);

    return { applyLabelVisibility, setLabelVisibility, refreshWarehouseLabels };
}
