import { useCallback } from 'react';
import * as THREE from 'three';
import { normalizeCityName, easeInOutCubic, disposeObject3D } from '../utils';
import { CITY_RISE_DURATION, RISE_HEIGHT, FOSHAN, CITY_BASE_COLOR, CITY_BASE_EMISSIVE, CITY_ACTIVE_COLOR, CITY_ACTIVE_EMISSIVE, FOSHAN_COLOR, FOSHAN_EMISSIVE, CITY_EDGE_LINE_FLAG } from '../constants';
import { useChinaMapRefs } from './useChinaMapRefs';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export function useCityControls(
    refs: ReturnType<typeof useChinaMapRefs>,
    labels: { applyLabelVisibility: () => void; refreshWarehouseLabels: () => void },
    focusFreightNodes: (delay?: number) => void,
) {
    const findCityKey = useCallback((cityName: string) => {
        const normalized = normalizeCityName(cityName);
        const cityKeys = Object.keys(refs.meshMapRef.current);

        // 先做严格归一化匹配，避免“上海市/上海”这类名称被 includes 的顺序影响。
        const exactKey = cityKeys.find((name) => normalizeCityName(name) === normalized);
        if (exactKey) return exactKey;

        // GeoJSON 名称和后端名称偶尔会一个带“市”、一个不带“市”，这里做双向兜底。
        return cityKeys.find((name) => {
            const candidate = normalizeCityName(name);
            return candidate.includes(normalized) || normalized.includes(candidate);
        });
    }, [refs.meshMapRef]);

    const animateCity = useCallback((cityName: string, targetZ: number, duration = CITY_RISE_DURATION) => {
        const group = refs.meshMapRef.current[cityName];
        if (!group) return;

        const oldFrame = refs.cityAnimFramesRef.current.get(cityName);
        if (oldFrame !== undefined) {
            cancelAnimationFrame(oldFrame);
            refs.cityAnimFramesRef.current.delete(cityName);
        }

        const startZ = group.position.z;
        const delta = targetZ - startZ;
        if (Math.abs(delta) < 0.001) return;

        const startTime = performance.now();
        const step = () => {
            const progress = Math.min((performance.now() - startTime) / duration, 1);
            group.position.z = startZ + delta * easeInOutCubic(progress);

            if (progress < 1) {
                refs.cityAnimFramesRef.current.set(cityName, requestAnimationFrame(step));
            } else {
                group.position.z = targetZ;
                refs.cityAnimFramesRef.current.delete(cityName);
            }
        };

        refs.cityAnimFramesRef.current.set(cityName, requestAnimationFrame(step));
    }, [refs.meshMapRef, refs.cityAnimFramesRef]);

    const riseCity = useCallback((cityName: string) => {
        const matchedKey = findCityKey(cityName);
        const normalized = normalizeCityName(cityName);

        if (!matchedKey) {
            refs.pendingRaisedCitiesRef.current.add(normalized);
            return;
        }

        const status = refs.cityStatusRef.current.get(matchedKey) ?? 0;
        if (status === 1) return;

        refs.cityStatusRef.current.set(matchedKey, 1);
        const group = refs.meshMapRef.current[matchedKey];
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
    }, [findCityKey, animateCity, refs.cityStatusRef, refs.meshMapRef, refs.pendingRaisedCitiesRef]);

    const fallCity = useCallback((cityName: string) => {
        const matchedKey = findCityKey(cityName);
        if (!matchedKey || normalizeCityName(matchedKey).includes(FOSHAN)) return;

        const status = refs.cityStatusRef.current.get(matchedKey) ?? 0;
        if (status === 0) return;

        refs.cityStatusRef.current.set(matchedKey, 0);
        const group = refs.meshMapRef.current[matchedKey];
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
    }, [findCityKey, animateCity, refs.cityStatusRef, refs.meshMapRef]);

    const updateCityData = useCallback((cityName: string, data: Record<string, any> | null) => {
        const matchedKey = findCityKey(cityName);
        if (!matchedKey) {
            refs.pendingCityDataRef.current.set(normalizeCityName(cityName), data);
            return;
        }
        const group = refs.meshMapRef.current[matchedKey];
        if (!group) return;

        if (data) {
            riseCity(cityName);
            group.userData.displayData = data;
            if (!refs.cityLabelMapRef.current.has(matchedKey)) {
                const div = document.createElement('div');
                const layout = group.userData.labelLayout as any;
                const initialHtml = warehouseLabelHtml(cityName, data, layout ?? {
                    x: 96,
                    y: -58,
                    align: 'left',
                    startOffset: [0, 0],
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
                refs.cityLabelMapRef.current.set(matchedKey, labelObj);
                labels.applyLabelVisibility();
            } else {
                // 更新已有标签
                const existingLabel = refs.cityLabelMapRef.current.get(matchedKey);
                if (existingLabel) {
                    const layout = group.userData.labelLayout as any;
                    const element = existingLabel.element as HTMLDivElement;
                    const nextHtml = warehouseLabelHtml(cityName, data, layout ?? {
                        x: 96,
                        y: -58,
                        align: 'left',
                        startOffset: [0, 0],
                    });
                    if (element.dataset.labelHtml !== nextHtml) {
                        element.innerHTML = nextHtml;
                        element.dataset.labelHtml = nextHtml;
                    }
                    existingLabel.position.copy(group.userData.labelAnchor ?? new THREE.Vector3(0, 1.2, 0));
                }
            }
            const normalizedKey = normalizeCityName(matchedKey);
            const pendingPanels =
                refs.pendingCityPanelsRef.current.get(matchedKey) ??
                refs.pendingCityPanelsRef.current.get(normalizedKey);
            if (pendingPanels) {
                const pendingStyle =
                    refs.pendingCityPanelStylesRef.current.get(cityName) ??
                    refs.pendingCityPanelStylesRef.current.get(normalizeCityName(cityName)) ??
                    refs.pendingCityPanelStylesRef.current.get(matchedKey) ??
                    refs.pendingCityPanelStylesRef.current.get(normalizedKey);
                refs.pendingCityPanelsRef.current.delete(cityName);
                refs.pendingCityPanelsRef.current.delete(normalizeCityName(cityName));
                refs.pendingCityPanelsRef.current.delete(matchedKey);
                refs.pendingCityPanelsRef.current.delete(normalizedKey);
                refs.pendingCityPanelStylesRef.current.delete(cityName);
                refs.pendingCityPanelStylesRef.current.delete(normalizeCityName(cityName));
                refs.pendingCityPanelStylesRef.current.delete(matchedKey);
                refs.pendingCityPanelStylesRef.current.delete(normalizedKey);
                window.setTimeout(() => refs.showCityPanelsRef.current(cityName, pendingPanels, pendingStyle), 0);
            }
            labels.refreshWarehouseLabels();
        } else {
            if (refs.cityLabelMapRef.current.has(matchedKey)) {
                const labelObj = refs.cityLabelMapRef.current.get(matchedKey);
                if (labelObj) {
                    group.remove(labelObj);
                    labelObj.element.remove();
                }
                refs.cityLabelMapRef.current.delete(matchedKey);
            }
            delete group.userData.displayData;
            labels.refreshWarehouseLabels();
        }
    }, [findCityKey, riseCity, refs, labels]);

    return { findCityKey, animateCity, riseCity, fallCity, updateCityData };
}

// 需要从 labelUtils 导入 warehouseLabelHtml
import { warehouseLabelHtml } from '../labelUtils';
