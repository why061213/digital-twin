import * as THREE from 'three';
import {projection} from "@/pages/Dashboard/modules/ChinaMap3D/geo.ts";
import {MAP_ROTATION_Z, OCTAGON_ORDER, LABEL_ANCHOR_RADIUS, LABEL_ANCHOR_CENTER_Y} from "@/pages/Dashboard/modules/ChinaMap3D/constants.ts";
import {} from "@/pages/Dashboard/modules/ChinaMap3D/"
export function normalizeCityName(cityName: string) { return cityName.endsWith('市') ? cityName.slice(0, -1) : cityName; }
export function easeInOutCubic(t: number) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
export function disposeObject3D(object: THREE.Object3D) {
    object.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
            child.geometry.dispose();
            const material = child.material;
            if (Array.isArray(material)) {
                material.forEach((item) => item.dispose());
            } else {
                material.dispose();
            }
        }
    });
}
export function indexCount(geometry: THREE.BufferGeometry) {
    return geometry.index?.count ?? geometry.attributes.position.count;
}


export function mapPosition(coords: [number, number], lift = 1.8) {
    const projected = projection(coords);
    if (!projected) return null;
    const x = -projected[0];
    const z = -projected[1];
    const cos = Math.cos(MAP_ROTATION_Z);
    const sin = Math.sin(MAP_ROTATION_Z);
    return new THREE.Vector3(x * cos - z * sin, lift, x * sin + z * cos);
}

export function octagonDirections() {
    const root = Math.SQRT1_2;
    // 1-8 从东侧开始顺时针编号，使用时按 1,3,5,7,2,4,6,8 分散占位。
    return [
        new THREE.Vector2(1, 0),
        new THREE.Vector2(root, root),
        new THREE.Vector2(0, 1),
        new THREE.Vector2(-root, root),
        new THREE.Vector2(-1, 0),
        new THREE.Vector2(-root, -root),
        new THREE.Vector2(0, -1),
        new THREE.Vector2(root, -root),
    ];
}

export function octagonStartOffset(orderIndex: number, scale = 1): [number, number] {
    const directions = octagonDirections();
    const direction = directions[OCTAGON_ORDER[orderIndex % OCTAGON_ORDER.length]];
    const centerScale = Math.pow(scale, 1.25);
    return [
        direction.x * LABEL_ANCHOR_RADIUS * scale,
        LABEL_ANCHOR_CENTER_Y * centerScale + direction.y * LABEL_ANCHOR_RADIUS * scale,
    ];
}
