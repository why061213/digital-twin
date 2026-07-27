import type { RefObject } from 'react';
import type { RoadMap3DHandle } from '../modules/RoadMap3D-2';
import type { RoadObjectInfo } from '../modules/RoadMap3D-2/types';
import {
    adaptRenderRoute,
    type RenderRouteDTO,
    type Rm2GroupDTO,
} from '../services/renderRouteApi';

const FADE_DURATION_MS = 180;

export type Rm2PreparedRoute = {
    lineId: string;
    pathKey: string;
    coordinates: [number, number][];
    baselineCoordinates?: [number, number][];
    baselinePathKey?: string;
    initialPosition: [number, number];
    info: RoadObjectInfo;
    visualKey: string;
};

export type Rm2PreparedGroup = {
    groupId: string;
    mapKey: string;
    routes: Rm2PreparedRoute[];
    pathLineIds: Map<string, string[]>;
    bounds: { minLng: number; maxLng: number; minLat: number; maxLat: number } | null;
    rejectedLineIds: string[];
};

function nextFrame() {
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function routeInfo(route: RenderRouteDTO, routeIndex: number, routeColorIndex: number): RoadObjectInfo {
    const hasVehicleRoute = typeof route.routeRevision === 'number'
        && Number.isFinite(route.routeRevision);
    return {
        plate: route.plate,
        cargo: route.cargo,
        from: route.from,
        to: route.to,
        status: route.meta?.tripStatusText ?? route.status,
        speedKmh: route.speedKmh,
        routeLengthKm: route.routeLengthKm,
        orderId: route.orderId,
        orderFamilyId: route.businessLineId,
        pathKey: route.pathKey,
        colorKey: route.colorKey,
        isRouteBranch: route.isRouteBranch,
        isBaselineRoute: !hasVehicleRoute,
        isVehicleRoute: hasVehicleRoute,
        deviationCoordinates: route.deviationCoordinates,
        routeAnalysis: route.analysis,
        routeIndex,
        routeColorIndex,
        showRouteEndpoints: true,
        tripId: route.meta?.tripId,
        visualKey: route.meta?.visualKey,
        currentLegId: route.meta?.currentLegId,
        planVersion: route.meta?.planVersion,
        targetStopId: route.meta?.targetStopId,
        targetOrderInstanceId: route.meta?.targetOrderInstanceId,
        targetAction: route.meta?.targetAction,
        tripStatusText: route.meta?.tripStatusText,
        tripStops: route.meta?.tripStops,
    };
}

function calculateBounds(routes: readonly Rm2PreparedRoute[]) {
    if (routes.length === 0) return null;

    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    routes.forEach((route) => route.coordinates.forEach(([lng, lat]) => {
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    }));
    return { minLng, maxLng, minLat, maxLat };
}

export function buildRm2RouteColorIndexes(group: Rm2GroupDTO) {
    const byBusinessLineId = new Map(
        group.orderLineIds.map((businessLineId, colorIndex) => [businessLineId, colorIndex]),
    );
    const byVehicleLineId = new Map<string, number>();
    group.orderLineIds.forEach((businessLineId, colorIndex) => {
        (group.vehicleLineIdsByOrderLineId[businessLineId] ?? []).forEach((lineId) => {
            byVehicleLineId.set(lineId, colorIndex);
        });
    });
    return { byBusinessLineId, byVehicleLineId };
}

export function createRm2SceneAdapter(
    roadMapRef: RefObject<RoadMap3DHandle | null>,
) {
    let fadeFrame = 0;
    let fadeResolve: ((completed: boolean) => void) | null = null;
    let transitionGeneration = 0;
    let currentOpacity = 1;
    let renderedGroupId: string | null = null;
    let renderedByLineId = new Map<string, Rm2PreparedRoute>();

    const stopFade = () => {
        if (fadeFrame) window.cancelAnimationFrame(fadeFrame);
        fadeFrame = 0;
        fadeResolve?.(false);
        fadeResolve = null;
    };

    const fadeRoadsTo = (targetOpacity: number, generation: number) => new Promise<boolean>((resolve) => {
        const roadMap = roadMapRef.current;
        if (!roadMap) {
            resolve(false);
            return;
        }

        stopFade();
        const start = performance.now();
        const initialOpacity = currentOpacity;
        roadMap.setRoadsOpacity(initialOpacity);
        fadeResolve = resolve;
        const tick = (now: number) => {
            if (generation !== transitionGeneration) {
                fadeResolve = null;
                resolve(false);
                return;
            }
            const progress = Math.min(1, (now - start) / FADE_DURATION_MS);
            currentOpacity = initialOpacity + (targetOpacity - initialOpacity) * progress;
            roadMap.setRoadsOpacity(currentOpacity);
            if (progress < 1) {
                fadeFrame = window.requestAnimationFrame(tick);
                return;
            }
            fadeFrame = 0;
            fadeResolve = null;
            resolve(true);
        };
        fadeFrame = window.requestAnimationFrame(tick);
    });

    return {
        async prepareSceneForGroup(group: Rm2GroupDTO) {
            if (!roadMapRef.current) throw new Error('RM2 scene is not ready');

            // RM2 底图由场景初始化统一加载；等一个绘制帧确保不在切换中的旧场景上操作。
            await nextFrame();
            if (!roadMapRef.current) throw new Error(`RM2 scene was disposed while preparing ${group.groupId}`);
        },

        async prepareRoutes(group: Rm2GroupDTO, routes: readonly RenderRouteDTO[]): Promise<Rm2PreparedGroup> {
            const pathLineIds = new Map<string, string[]>();
            const rejectedLineIds: string[] = [];
            const preparedRoutes: Rm2PreparedRoute[] = [];
            const seenLineIds = new Set<string>();
            // 颜色槽必须以后端分组使用的业务路线 ID 为准。复合行程中的多张订单
            // 可能共享同一个 orderId；用 orderId 分色会把它们错误地压进同一颜色。
            const {
                byBusinessLineId: colorIndexByBusinessLineId,
                byVehicleLineId: colorIndexByVehicleLineId,
            } = buildRm2RouteColorIndexes(group);

            routes.forEach((rawRoute, routeIndex) => {
                if (!adaptRenderRoute(rawRoute)
                    || rawRoute.groupId !== group.groupId
                    || seenLineIds.has(rawRoute.lineId)) {
                    rejectedLineIds.push(rawRoute.lineId);
                    return;
                }

                seenLineIds.add(rawRoute.lineId);
                const routeColorIndex = colorIndexByBusinessLineId.get(rawRoute.businessLineId)
                    ?? colorIndexByVehicleLineId.get(rawRoute.lineId)
                    ?? routeIndex;
                const lineIds = pathLineIds.get(rawRoute.pathKey) ?? [];
                lineIds.push(rawRoute.lineId);
                pathLineIds.set(rawRoute.pathKey, lineIds);
                preparedRoutes.push({
                    lineId: rawRoute.lineId,
                    pathKey: rawRoute.pathKey,
                    coordinates: rawRoute.coordinates,
                    baselineCoordinates: rawRoute.baselineCoordinates,
                    baselinePathKey: rawRoute.baselinePathKey,
                    initialPosition: rawRoute.coordinates[0],
                    info: routeInfo(rawRoute, routeIndex, routeColorIndex),
                    visualKey: rawRoute.meta?.visualKey ?? rawRoute.lineId,
                });
            });

            return {
                groupId: group.groupId,
                mapKey: group.mapKey,
                routes: preparedRoutes,
                pathLineIds,
                bounds: calculateBounds(preparedRoutes),
                rejectedLineIds,
            };
        },

        async replaceRenderedGroup(
            prepared: Rm2PreparedGroup,
            beforeReveal?: () => void | Promise<void>,
        ) {
            const roadMap = roadMapRef.current;
            if (!roadMap) throw new Error('RM2 scene is not ready for replacement');
            const generation = ++transitionGeneration;

            if (renderedGroupId === prepared.groupId) {
                const nextByLineId = new Map(prepared.routes.map((route) => [route.lineId, route]));
                renderedByLineId.forEach((oldRoute, lineId) => {
                    if (!nextByLineId.has(lineId)) roadMap.removeRoadPath(oldRoute.lineId);
                });
                prepared.routes.forEach((route) => {
                    roadMap.addRoadPath(route.lineId, route.coordinates, route.info);
                    roadMap.updateTruckPosition(route.lineId, route.initialPosition, route.info);
                });
                renderedByLineId = nextByLineId;
                await beforeReveal?.();
                return;
            }

            // 此处才移除旧组：请求、校验和新组描述都已完成，避免等待网络时出现黑屏。
            if (!await fadeRoadsTo(0, generation) || generation !== transitionGeneration || !roadMapRef.current) return;
            roadMap.clearRoads();

            const renderedBaselineKeys = new Set<string>();
            prepared.routes.forEach((route) => {
                if (!route.info.isVehicleRoute
                    || !route.baselinePathKey
                    || !route.baselineCoordinates
                    || renderedBaselineKeys.has(route.baselinePathKey)) return;
                renderedBaselineKeys.add(route.baselinePathKey);
                const referenceId = `baseline:${route.baselinePathKey}`;
                roadMap.addRoadPath(referenceId, route.baselineCoordinates, {
                    ...route.info,
                    pathKey: route.baselinePathKey,
                    colorKey: route.info.orderId,
                    isBaselineRoute: true,
                    isVehicleRoute: false,
                    isRouteBranch: false,
                    showRouteEndpoints: false,
                    deviationCoordinates: undefined,
                });
                // 只保留基准线图层，不留下虚拟车辆。
                roadMap.removeRoadPath(referenceId);
            });
            renderedGroupId = prepared.groupId;
            renderedByLineId = new Map(prepared.routes.map((route) => [route.lineId, route]));

            prepared.routes.forEach((route) => {
                if (generation !== transitionGeneration) return;
                roadMap.addRoadPath(route.lineId, route.coordinates, route.info);
                roadMap.updateTruckPosition(route.lineId, route.initialPosition, route.info);
            });
            if (generation !== transitionGeneration) return;

            roadMap.setRoadsOpacity(0);
            currentOpacity = 0;
            await beforeReveal?.();
            if (generation !== transitionGeneration || !roadMapRef.current) return;
            // beforeReveal 可能创建车辆专属路线，新对象也必须保持隐藏，统一淡入。
            roadMap.setRoadsOpacity(0);
            if (!await fadeRoadsTo(1, generation) || generation !== transitionGeneration) return;
            console.info('[RM2 scene replace]', {
                groupId: prepared.groupId,
                mapKey: prepared.mapKey,
                routeCount: prepared.routes.length,
                sharedPathCount: prepared.pathLineIds.size,
                bounds: prepared.bounds,
                rejectedLineIds: prepared.rejectedLineIds,
            });
        },

        clearRenderedGroup() {
            transitionGeneration += 1;
            stopFade();
            currentOpacity = 1;
            renderedGroupId = null;
            renderedByLineId.clear();
            roadMapRef.current?.clearRoads();
        },
    };
}
