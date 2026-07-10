import type {
    TownAnimationStage,
    TownCandidatePath,
    TownProvinceEdge,
    TownRoadRenderCommand,
    TownRouteGroup,
    TownTransportOrder,
} from './types';

function normalizeOrders(command: TownRoadRenderCommand): TownTransportOrder[] {
    return command.orders?.length ? command.orders : (command.tasks ?? []);
}

function normalizeRenderProvinces(command: TownRoadRenderCommand): string[] {
    return command.renderProvinces?.length ? command.renderProvinces : (command.renderAdcodes ?? []);
}

function safeIdPart(value: string | null | undefined, fallback: string) {
    const source = value && value.trim() ? value : fallback;
    return source.replace(/[^\w\u4e00-\u9fa5>-]+/g, '_');
}

function unique(values: Array<string | null | undefined>) {
    return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

function sortedUnique(values: Array<string | null | undefined>) {
    return unique(values).map(String).sort();
}

function provinceFromDistrictAdcode(adcode?: string) {
    if (!adcode || !/^\d{6}$/.test(adcode)) return undefined;
    return `${adcode.slice(0, 2)}0000`;
}

function collectOrderRenderProvinces(order: TownTransportOrder) {
    return unique([
        provinceFromDistrictAdcode(order.from.adcode),
        provinceFromDistrictAdcode(order.to.adcode),
    ]);
}

function collectGroupRenderProvinces(group: TownRouteGroup, orders: TownTransportOrder[]) {
    const pathProvinces = getGroupRenderProvinces(group);
    if (pathProvinces.length > 0) return pathProvinces;

    const groupOrderLineIds = new Set(collectGroupOrderLineIds(group));
    const orderProvinces = sortedUnique(orders
        .filter((order) => groupOrderLineIds.has(order.lineId))
        .flatMap(collectOrderRenderProvinces));
    if (orderProvinces.length > 0) return orderProvinces;

    return sortedUnique([group.fromProvinceKey, group.toProvinceKey]);
}

export function getGroupRenderProvinces(group: TownRouteGroup): string[] {
    return sortedUnique((group.candidatePaths ?? []).flatMap((path) => path.provincePath ?? []));
}

function collectPathRenderProvinces(path: TownCandidatePath, fallbackRenderProvinces: string[]) {
    return unique(path.provincePath?.length ? path.provincePath : fallbackRenderProvinces);
}

/**
 * 当前路线组的地图范围必须覆盖所有候选最短路径。
 * 例如 广东 -> 浙江 有两条候选：
 *   广东 -> 福建 -> 浙江
 *   广东 -> 江西 -> 浙江
 * 那么这一组切入时必须一次性渲染：广东、福建、浙江、江西。
 * 后续 candidatePath / edge / order 阶段只做高亮，不再缩小地图范围，避免没有真实高速路网时误导为唯一线路。
 */
function collectGroupPlaybackRenderProvinces(group: TownRouteGroup, orders: TownTransportOrder[]) {
    const groupRenderProvinces = collectGroupRenderProvinces(group, orders);
    const candidatePathProvinces = sortedUnique((group.candidatePaths ?? []).flatMap((path) => collectPathRenderProvinces(path, groupRenderProvinces)));
    return candidatePathProvinces.length > 0 ? candidatePathProvinces : groupRenderProvinces;
}

export function getTownSceneKey(command: TownRoadRenderCommand) {
    if (command.sourceProvince?.provinceKey) {
        return `source-${command.sourceProvince.provinceKey}`;
    }
    if (command.commandId) return `command-${command.commandId}`;
    const provinces = normalizeRenderProvinces(command).slice().sort().join('_');
    return `scene-${provinces || 'unknown'}`;
}

function groupOrdersByLineId(orders: TownTransportOrder[]) {
    const map = new Map<string, TownTransportOrder>();
    orders.forEach((order) => {
        if (order.lineId) map.set(order.lineId, order);
    });
    return map;
}

function collectGroupOrderLineIds(group: TownRouteGroup) {
    return Array.from(new Set([
        ...(group.primaryOrderLineIds ?? []),
        ...(group.alongOrderLineIds ?? []),
    ]));
}

function hasEveryPrimaryOrderAbsorbedByLargerGroup(group: TownRouteGroup, largerGroup: TownRouteGroup) {
    const primaryLineIds = unique(group.primaryOrderLineIds ?? []);
    if (primaryLineIds.length === 0) return false;

    const largerAlongLineIds = new Set(largerGroup.alongOrderLineIds ?? []);
    return primaryLineIds.every((lineId) => largerAlongLineIds.has(lineId));
}

function isLargerAbsorbingGroup(candidate: TownRouteGroup, target: TownRouteGroup) {
    if (candidate.groupId === target.groupId) return false;
    const candidateLineCount = collectGroupOrderLineIds(candidate).length;
    const targetLineCount = collectGroupOrderLineIds(target).length;
    if (candidateLineCount <= targetLineCount) return false;
    return hasEveryPrimaryOrderAbsorbedByLargerGroup(target, candidate);
}

function getDisplayRouteGroups(command: TownRoadRenderCommand) {
    const sourceGroups = command.displayRouteGroups?.length
        ? command.displayRouteGroups
        : command.routeGroups ?? [];
    const displayEnabledGroups = sourceGroups.filter((group) => group.display !== false && !group.absorbed);

    return displayEnabledGroups.filter((group) => {
        const absorbedByLargerGroup = displayEnabledGroups.some((candidate) => isLargerAbsorbingGroup(candidate, group));
        return !absorbedByLargerGroup;
    });
}

function collectPathOrderLineIds(path: TownCandidatePath) {
    return Array.from(new Set([
        ...(path.primaryOrderLineIds ?? []),
        ...(path.alongOrderLineIds ?? []),
    ]));
}

function collectEdgeOrderLineIds(edge: TownProvinceEdge) {
    return Array.from(new Set([
        ...(edge.orderLineIds ?? []),
        ...(edge.primaryOrderLineIds ?? []),
        ...(edge.alongOrderLineIds ?? []),
    ]));
}

function buildStageBase(command: TownRoadRenderCommand) {
    const sceneKey = getTownSceneKey(command);
    const version = command.issuedAt ?? command.commandId ?? `${Date.now()}`;
    return { sceneKey, version };
}

export function buildTownAnimationStages(command: TownRoadRenderCommand): TownAnimationStage[] {
    const { sceneKey, version } = buildStageBase(command);
    const orders = normalizeOrders(command).filter((order) => !order.deleted && order.status !== '已取消');
    const orderByLineId = groupOrdersByLineId(orders);
    const routeGroups = getDisplayRouteGroups(command);
    const provinceEdges = command.provinceEdges ?? [];
    const stages: TownAnimationStage[] = [];
    const usedIds = new Set<string>();

    const pushStage = (stage: TownAnimationStage) => {
        if (usedIds.has(stage.id)) return;
        usedIds.add(stage.id);
        stages.push(stage);
    };

    pushStage({
        id: `${sceneKey}:boot`,
        kind: 'scene_boot',
        sceneKey,
        commandId: command.commandId,
        label: command.title ?? command.sourceProvince?.provinceName ?? '短途运输场景',
        version,
        playbackStatus: 'pending',
        payload: {
            renderProvinces: [],
            orderLineIds: orders.map((order) => order.lineId),
        },
    });

    routeGroups.forEach((group, groupIndex) => {
        const groupOrderLineIds = collectGroupOrderLineIds(group);
        const groupRenderProvinces = collectGroupPlaybackRenderProvinces(group, orders);
        const groupOrders = groupOrderLineIds
            .map((lineId) => orderByLineId.get(lineId))
            .filter((order): order is TownTransportOrder => Boolean(order));
        const groupEdgeKeys = unique((group.candidatePaths ?? []).flatMap((path) => path.edgeKeys ?? []));
        const groupId = safeIdPart(group.groupId, `group_${groupIndex}`);

        pushStage({
            id: `${sceneKey}:group:${groupId}`,
            kind: 'route_group_focus',
            sceneKey,
            commandId: command.commandId,
            label: group.groupName ?? `${group.fromProvinceName ?? ''} -> ${group.toProvinceName ?? ''}`.trim(),
            version,
            playbackStatus: 'pending',
            payload: {
                routeGroupId: group.groupId,
                edgeKeys: groupEdgeKeys,
                orderLineIds: groupOrders.length > 0 ? groupOrders.map((order) => order.lineId) : groupOrderLineIds,
                renderProvinces: groupRenderProvinces,
            },
        });

        (group.candidatePaths ?? []).forEach((path, pathIndex) => {
            const pathId = safeIdPart(path.pathId, `${groupId}_path_${pathIndex}`);
            const pathLineIds = collectPathOrderLineIds(path);
            pushStage({
                id: `${sceneKey}:path:${pathId}`,
                kind: 'candidate_path_focus',
                sceneKey,
                commandId: command.commandId,
                label: path.provinceNames?.join(' → ') ?? path.provincePath.join(' → '),
                version,
                playbackStatus: 'pending',
                payload: {
                    routeGroupId: group.groupId,
                    candidatePathId: path.pathId,
                    provincePath: path.provincePath,
                    edgeKeys: path.edgeKeys,
                    orderLineIds: pathLineIds,
                    // 地图范围保持为当前路线组的所有候选最短路径省份并集。
                    // 具体 candidatePath 只负责高亮，不负责缩小渲染范围。
                    renderProvinces: groupRenderProvinces,
                },
            });

            (path.edgeKeys ?? []).forEach((edgeKey, edgeIndex) => {
                const edge = provinceEdges.find((item) => item.edgeKey === edgeKey);
                const edgeLineIds = edge ? collectEdgeOrderLineIds(edge) : pathLineIds;
                pushStage({
                    id: `${sceneKey}:edge:${safeIdPart(path.pathId, `${groupId}_path_${pathIndex}`)}:${safeIdPart(edgeKey, `edge_${edgeIndex}`)}`,
                    kind: 'province_edge_highlight',
                    sceneKey,
                    commandId: command.commandId,
                    label: edge
                        ? `${edge.fromProvinceName ?? edge.fromProvinceKey} → ${edge.toProvinceName ?? edge.toProvinceKey}`
                        : edgeKey,
                    version,
                    playbackStatus: 'pending',
                    payload: {
                        routeGroupId: group.groupId,
                        candidatePathId: path.pathId,
                        edgeKey,
                        orderLineIds: edgeLineIds,
                        // 省际边高亮也不能把地图缩到 from/to 两省。
                        // 必须保留当前路线组所有候选最短路径的完整省份范围。
                        renderProvinces: groupRenderProvinces,
                    },
                });
            });
        });
    });

    // 如果后端暂时还没有 routeGroups，就退化成按订单批次播放，避免队列为空。
    if (routeGroups.length === 0 && orders.length > 0) {
        orders.forEach((order, index) => {
            pushStage({
                id: `${sceneKey}:order:${safeIdPart(order.lineId, `order_${index}`)}`,
                kind: 'order_batch_focus',
                sceneKey,
                commandId: command.commandId,
                label: order.groupName ?? `${order.from.name} → ${order.to.name}`,
                version,
                playbackStatus: 'pending',
                payload: {
                    routeGroupId: order.groupId,
                    orderLineIds: [order.lineId],
                    renderProvinces: collectOrderRenderProvinces(order),
                },
            });
        });
    }

    return stages;
}


export function buildTownStageRenderCommand(command: TownRoadRenderCommand, stage: TownAnimationStage | null | undefined): TownRoadRenderCommand {
    if (!stage) return command;

    const orders = normalizeOrders(command).filter((order) => !order.deleted && order.status !== '已取消');
    const orderLineIds = new Set(stage.payload.orderLineIds ?? []);
    const stageOrders = orderLineIds.size > 0
        ? orders.filter((order) => orderLineIds.has(order.lineId))
        : orders;
    const renderProvinces = stage.payload.renderProvinces?.length
        ? stage.payload.renderProvinces
        : normalizeRenderProvinces(command);
    const displayRouteGroups = getDisplayRouteGroups(command);
    const routeGroups = stage.payload.routeGroupId
        ? displayRouteGroups.filter((group) => group.groupId === stage.payload.routeGroupId)
        : displayRouteGroups;
    const edgeKeys = new Set([
        ...(stage.payload.edgeKeys ?? []),
        ...(stage.payload.edgeKey ? [stage.payload.edgeKey] : []),
    ]);
    const provinceEdges = edgeKeys.size > 0
        ? (command.provinceEdges ?? []).filter((edge) => edgeKeys.has(edge.edgeKey))
        : command.provinceEdges ?? [];

    return {
        ...command,
        commandId: command.commandId ? `${command.commandId}::${stage.id}` : stage.id,
        title: stage.label || command.title,
        renderProvinces,
        renderAdcodes: renderProvinces,
        orders: stageOrders,
        tasks: stageOrders,
        routeGroups,
        provinceEdges,
    };
}

export function scoreTownScene(command: TownRoadRenderCommand) {
    const orderScore = normalizeOrders(command).filter((order) => !order.deleted && order.status !== '已取消').length * 100;
    const groupScore = (command.routeGroups?.length ?? 0) * 30;
    const edgeScore = (command.provinceEdges?.length ?? 0) * 10;
    const provinceScore = normalizeRenderProvinces(command).length;
    return orderScore + groupScore + edgeScore + provinceScore;
}
