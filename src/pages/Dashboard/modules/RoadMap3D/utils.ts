import * as THREE from 'three';

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

export function clamp01(value: number) {
    return Math.min(Math.max(value, 0), 1);
}

export function makeLinearCurve(points: THREE.Vector3[]) {
    const path = new THREE.CurvePath<THREE.Vector3>();
    path.add(new THREE.LineCurve3(points[0], points[points.length - 1]));
    return path;
}

export function makePathCurve(points: THREE.Vector3[]) {
    if (points.length === 2) {
        return makeLinearCurve(points);
    }
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < points.length - 1; i++) {
        path.add(new THREE.LineCurve3(points[i], points[i + 1]));
    }
    return path;
}

export function indexCount(geometry: THREE.BufferGeometry) {
    return geometry.index?.count ?? geometry.attributes.position.count;
}

export function formatNumber(value: number | null | undefined, digits = 2) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

export function screenPosition(point: THREE.Vector3, camera: THREE.Camera, container: HTMLDivElement) {
    const projected = point.clone().project(camera);
    return {
        x: (projected.x * 0.5 + 0.5) * container.clientWidth,
        y: (-projected.y * 0.5 + 0.5) * container.clientHeight,
    };
}