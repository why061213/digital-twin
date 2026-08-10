export type RoadTrackIdentityInfo = {
    isBaselineRoute?: boolean;
    pathKey?: string;
};

export function roadGeometryKey(coords: readonly (readonly [number, number])[]) {
    return coords.map(([lng, lat]) => `${lng.toFixed(5)},${lat.toFixed(5)}`).join('|');
}

/**
 * 道路实体按路线而不是车辆建模：同一路线上的多辆车共享一条 RoadState，
 * 车辆仍由 lineId 在道路内部独立维护，避免重复绘制起终点和路线底图。
 */
export function roadTrackKey(
    lineId: string,
    coords: readonly (readonly [number, number])[],
    info: RoadTrackIdentityInfo,
) {
    const pathKey = info.pathKey?.trim() || roadGeometryKey(coords);
    return info.isBaselineRoute ? `baseline:${pathKey}` : `route:${pathKey || lineId}`;
}
