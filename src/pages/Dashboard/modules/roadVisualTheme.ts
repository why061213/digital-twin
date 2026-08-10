import * as THREE from 'three';

/** RM1/RM2 共用的业务路线色盘。 */
export const ROUTE_COLORS = [
    0x3b82f6,
    0xf59e0b,
    0x22c55e,
    0xa78bfa,
    0xfb7185,
    0x2dd4bf,
] as const;

export const VEHICLE_COLOR = 0xf8fafc;

export function stableRouteHash(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function routeColorFor(orderKey: string, routeColorIndex?: number) {
    const colorIndex = typeof routeColorIndex === 'number' && Number.isFinite(routeColorIndex)
        ? Math.abs(Math.trunc(routeColorIndex))
        : stableRouteHash(orderKey);
    return ROUTE_COLORS[colorIndex % ROUTE_COLORS.length];
}

export function branchRouteColors(baseColor: number, branchGroupId: string) {
    const hash = stableRouteHash(branchGroupId);
    const base = new THREE.Color(baseColor);
    const hsl = { h: 0, s: 0, l: 0 };
    base.getHSL(hsl);
    const hueShift = ((hash % 2001) / 1000 - 1) * 0.1;
    const saturationShift = (((hash >>> 7) % 17) - 8) / 100;
    const lightnessShift = (((hash >>> 13) % 21) - 10) / 100;
    const branch = new THREE.Color().setHSL(
        (hsl.h + hueShift + 1) % 1,
        THREE.MathUtils.clamp(hsl.s + saturationShift, 0.42, 0.96),
        THREE.MathUtils.clamp(hsl.l + lightnessShift, 0.34, 0.72),
    );
    const snakeHsl = { h: 0, s: 0, l: 0 };
    branch.getHSL(snakeHsl);
    const snake = new THREE.Color().setHSL(
        snakeHsl.h,
        snakeHsl.s,
        Math.max(0.12, snakeHsl.l * 0.8),
    );
    return { branch: branch.getHex(), snake: snake.getHex() };
}
