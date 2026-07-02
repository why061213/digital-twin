import { useCallback } from 'react';
import * as THREE from 'three';
import { useChinaMapRefs } from './useChinaMapRefs';

export function useMapHover(refs: ReturnType<typeof useChinaMapRefs>) {
    const onMouseMove = useCallback((event: MouseEvent) => {
        const container = refs.containerRef.current;
        if (!container) return;

        const rect = container.getBoundingClientRect();
        refs.mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        refs.mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        if (refs.tooltipRef.current) {
            refs.tooltipRef.current.style.left = event.clientX + 12 + 'px';
            refs.tooltipRef.current.style.top = event.clientY + 12 + 'px';
        }
    }, [refs]);

    const checkHover = useCallback(() => {
        const camera = refs.cameraRef.current;
        const scene = refs.sceneRef.current;
        if (!camera || !scene) return;

        refs.raycasterRef.current.setFromCamera(refs.mouseRef.current, camera);
        const targets = Object.values(refs.meshMapRef.current);
        const intersects = refs.raycasterRef.current.intersectObjects(targets, true);

        let newHoveredCity: THREE.Group | null = null;
        if (intersects.length > 0) {
            let obj: THREE.Object3D | null = intersects[0].object;
            while (obj && !(obj instanceof THREE.Group && targets.includes(obj))) {
                obj = obj.parent;
            }
            if (obj && obj instanceof THREE.Group && targets.includes(obj)) {
                newHoveredCity = obj;
            }
        }

        if (refs.tooltipRef.current) {
            if (newHoveredCity !== refs.hoveredCityRef.current) {
                refs.hoveredCityRef.current = newHoveredCity;
                if (newHoveredCity && newHoveredCity.userData.displayData) {
                    const data = newHoveredCity.userData.displayData;
                    refs.tooltipRef.current.innerHTML = `
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:7px">
                            <strong style="color:#cffafe;font-size:13px">${data.label || newHoveredCity.name}</strong>
                            <span style="border:1px solid rgba(52,211,153,0.28);background:rgba(16,185,129,0.12);color:#bbf7d0;border-radius:4px;padding:1px 6px;font-size:11px">${data.status}</span>
                        </div>
                        <div style="display:grid;grid-template-columns:70px 1fr;gap:5px 12px">
                            <span style="color:#94a3b8">库存</span><span style="text-align:right;color:#f8fafc">${data.inventory} 吨</span>
                            <span style="color:#94a3b8">今日入库</span><span style="text-align:right;color:#67e8f9">${data.todayIn} 吨</span>
                            <span style="color:#94a3b8">今日出库</span><span style="text-align:right;color:#fbbf24">${data.todayOut} 吨</span>
                        </div>
                    `;
                    refs.tooltipRef.current.style.display = 'block';
                } else {
                    refs.tooltipRef.current.style.display = 'none';
                }
            }
        }
    }, [refs]);

    return { onMouseMove, checkHover };
}