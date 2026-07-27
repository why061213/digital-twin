export type TripRouteIdentity = {
    lineId?: string;
    visualKey?: string;
    currentLegId?: string;
    planVersion?: number;
    routeSignature?: string;
    coordinates?: readonly (readonly [number, number])[];
    tripPhase?: string;
    tripDecision?: string;
    targetAction?: 'PICKUP' | 'DELIVERY';
    status?: string;
};

export function routeVisualKey(route: TripRouteIdentity) {
    return route.visualKey?.trim() || route.lineId || '';
}

/** Three 场景使用稳定 visualKey 作为车辆 ID，后端 lineId 变化也不会复制车辆对象。 */
export function sceneRouteId(route: TripRouteIdentity) {
    return routeVisualKey(route);
}

export function coordinatesSignature(coordinates: TripRouteIdentity['coordinates']) {
    return (coordinates ?? [])
        .map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`)
        .join('|');
}

export function routeRequiresSync(previous: TripRouteIdentity | undefined, next: TripRouteIdentity) {
    if (!previous) return true;
    return previous.currentLegId !== next.currentLegId
        || previous.planVersion !== next.planVersion
        || previous.routeSignature !== next.routeSignature
        || coordinatesSignature(previous.coordinates) !== coordinatesSignature(next.coordinates);
}

export function removedSceneRouteIds(
    previous: readonly TripRouteIdentity[],
    next: readonly TripRouteIdentity[],
) {
    const nextVisualKeys = new Set(next.map(routeVisualKey));
    return previous
        .filter((route) => !nextVisualKeys.has(routeVisualKey(route)))
        .map(sceneRouteId);
}

export function tripBusinessStage(route: TripRouteIdentity) {
    switch (route.tripDecision) {
        case 'EN_ROUTE_TO_PICKUP': return '前往装货点';
        case 'ARRIVED': return '已到达';
        case 'LOADING': return '装货中';
        case 'EN_ROUTE_TO_DELIVERY': return '前往卸货点';
        case 'UNLOADING': return '卸货中';
        case 'TRIP_COMPLETED_LOCAL': return '已完成';
        default: break;
    }
    if (route.targetAction === 'PICKUP') return '前往装货点';
    if (route.targetAction === 'DELIVERY') return '前往卸货点';
    switch (route.tripPhase) {
        case 'COLLECTING': return '前往装货点';
        case 'AT_PICKUP': return '装货中';
        case 'LINEHAUL': return '干线运输';
        case 'DISTRIBUTING': return '前往卸货点';
        case 'TRIP_COMPLETED_PENDING_CONFIRMATION': return '已完成';
        default: return route.status || '等待数据';
    }
}
