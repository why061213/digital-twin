import type {
    TownRoadDiffSummary,
    TownRoadRenderCommand,
    TownTransportOrder,
} from './types';
import { getTownSceneKey } from './townAnimationPlanner';

export type TownCommandMergeResult = {
    commands: TownRoadRenderCommand[];
    diff: Required<TownRoadDiffSummary>;
};

const EMPTY_DIFF: Required<TownRoadDiffSummary> = {
    added: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    routeChanged: 0,
    skippedInvalid: 0,
    skippedNotRenderable: 0,
    skippedLongHaul: 0,
};

function cloneDiff(diff?: TownRoadDiffSummary): Required<TownRoadDiffSummary> {
    return {
        ...EMPTY_DIFF,
        ...(diff ?? {}),
    };
}

function addDiff(target: Required<TownRoadDiffSummary>, source: TownRoadDiffSummary) {
    target.added += source.added ?? 0;
    target.updated += source.updated ?? 0;
    target.deleted += source.deleted ?? 0;
    target.unchanged += source.unchanged ?? 0;
    target.routeChanged += source.routeChanged ?? 0;
    target.skippedInvalid += source.skippedInvalid ?? 0;
    target.skippedNotRenderable += source.skippedNotRenderable ?? 0;
    target.skippedLongHaul += source.skippedLongHaul ?? 0;
}

export function getTownCommandKey(command: TownRoadRenderCommand) {
    if (command.sourceProvince?.provinceKey) return `source:${command.sourceProvince.provinceKey}`;
    if (command.commandId) return `command:${command.commandId}`;
    return getTownSceneKey(command);
}

function normalizeOrders(command: TownRoadRenderCommand) {
    return command.orders?.length ? command.orders : (command.tasks ?? []);
}

function normalizeRenderProvinces(command: TownRoadRenderCommand) {
    return command.renderProvinces?.length ? command.renderProvinces : (command.renderAdcodes ?? []);
}

function isDeletedOrder(order: TownTransportOrder) {
    return Boolean(order.deleted) || order.status === '已取消';
}

function stableStringify(value: unknown) {
    // 这里不做深度排序，依赖后端 DTO 字段顺序稳定。用途是快速判断“展示数据是否完全没变”。
    return JSON.stringify(value);
}

function sameOrder(previous: TownTransportOrder, next: TownTransportOrder) {
    return stableStringify(previous) === stableStringify(next);
}

function sameArray(previous: unknown[] | undefined, next: unknown[] | undefined) {
    return stableStringify(previous ?? []) === stableStringify(next ?? []);
}

type MergeOrdersResult = {
    orders: TownTransportOrder[];
    diff: TownRoadDiffSummary;
};

function mergeOrderSnapshot(previousOrders: TownTransportOrder[], incomingOrders: TownTransportOrder[]): MergeOrdersResult {
    const previousByLineId = new Map<string, TownTransportOrder>();
    previousOrders.forEach((order) => {
        if (order.lineId) previousByLineId.set(order.lineId, order);
    });

    const nextIds = new Set<string>();
    const mergedOrders: TownTransportOrder[] = [];
    const diff: Required<TownRoadDiffSummary> = cloneDiff();

    incomingOrders.forEach((incoming) => {
        if (!incoming.lineId) {
            diff.skippedInvalid += 1;
            return;
        }

        nextIds.add(incoming.lineId);
        const previous = previousByLineId.get(incoming.lineId);

        if (isDeletedOrder(incoming)) {
            if (previous) diff.deleted += 1;
            return;
        }

        if (!previous) {
            diff.added += 1;
            mergedOrders.push(incoming);
            return;
        }

        if (sameOrder(previous, incoming)) {
            diff.unchanged += 1;
            // 复用旧对象，减少 React/Three 后续 diff 噪音。
            mergedOrders.push(previous);
            return;
        }

        diff.updated += 1;
        if (incoming.upToDate === false) diff.routeChanged += 1;
        mergedOrders.push(incoming);
    });

    previousOrders.forEach((previous) => {
        if (!nextIds.has(previous.lineId)) {
            // 后端每次给完整快照，因此旧快照有、新快照没有的订单应从当前命令移除。
            diff.deleted += 1;
        }
    });

    return { orders: mergedOrders, diff };
}

export function mergeTownCommandSnapshot(previous: TownRoadRenderCommand | undefined, incoming: TownRoadRenderCommand) {
    const incomingOrders = normalizeOrders(incoming);
    const incomingRenderProvinces = normalizeRenderProvinces(incoming);

    if (!previous) {
        const activeOrders = incomingOrders.filter((order) => !isDeletedOrder(order));
        return {
            command: {
                ...incoming,
                renderLevel: incoming.renderLevel ?? 'province-district',
                renderProvinces: incomingRenderProvinces,
                renderAdcodes: incoming.renderAdcodes ?? incomingRenderProvinces,
                orders: activeOrders,
                tasks: incoming.tasks ?? activeOrders,
                routeGroups: incoming.routeGroups ?? [],
                provinceEdges: incoming.provinceEdges ?? [],
            },
            diff: {
                ...EMPTY_DIFF,
                added: activeOrders.length,
                skippedInvalid: incomingOrders.length - activeOrders.length,
            },
        };
    }

    const previousOrders = normalizeOrders(previous);
    const { orders, diff } = mergeOrderSnapshot(previousOrders, incomingOrders);
    const nextRouteGroups = sameArray(previous.routeGroups, incoming.routeGroups)
        ? previous.routeGroups
        : incoming.routeGroups ?? [];
    const nextProvinceEdges = sameArray(previous.provinceEdges, incoming.provinceEdges)
        ? previous.provinceEdges
        : incoming.provinceEdges ?? [];
    const nextRenderProvinces = sameArray(normalizeRenderProvinces(previous), incomingRenderProvinces)
        ? normalizeRenderProvinces(previous)
        : incomingRenderProvinces;

    return {
        command: {
            ...previous,
            ...incoming,
            renderLevel: incoming.renderLevel ?? previous.renderLevel ?? 'province-district',
            renderProvinces: nextRenderProvinces,
            renderAdcodes: incoming.renderAdcodes ?? nextRenderProvinces,
            orders,
            tasks: incoming.tasks ? orders : previous.tasks ? orders : undefined,
            routeGroups: nextRouteGroups,
            provinceEdges: nextProvinceEdges,
            issuedAt: incoming.issuedAt ?? previous.issuedAt,
        },
        diff,
    };
}

export function mergeTownRenderCommandSnapshot(
    previousCommands: TownRoadRenderCommand[],
    incomingCommands: TownRoadRenderCommand[],
    envelopeDiff?: TownRoadDiffSummary
): TownCommandMergeResult {
    const previousByKey = new Map<string, TownRoadRenderCommand>();
    previousCommands.forEach((command) => previousByKey.set(getTownCommandKey(command), command));

    const totalDiff = cloneDiff(envelopeDiff);
    const nextCommands = incomingCommands.map((incoming) => {
        const previous = previousByKey.get(getTownCommandKey(incoming));
        const merged = mergeTownCommandSnapshot(previous, incoming);
        addDiff(totalDiff, merged.diff);
        return merged.command;
    });

    const incomingKeys = new Set(incomingCommands.map(getTownCommandKey));
    previousCommands.forEach((previous) => {
        if (!incomingKeys.has(getTownCommandKey(previous))) {
            totalDiff.deleted += normalizeOrders(previous).length;
        }
    });

    return { commands: nextCommands, diff: totalDiff };
}
