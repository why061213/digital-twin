import type { Rm2GroupDTO, RenderRouteDTO } from '../services/renderRouteApi';

export type ChainNode = {
    id: string;
    label: string;
    next: ChainNode | null;
    child: ChainNode | null;
    routes?: RenderRouteDTO[];
    durationMs?: number;
};

const SECONDS_PER_ROUTE = 8;
const MIN_SECONDS = 15;
const MAX_SECONDS = 60;

function calcDuration(routeCount: number): number {
    return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, routeCount * SECONDS_PER_ROUTE)) * 1000;
}

function extractDirection(groupId: string) {
    const parts = groupId.split(':');
    return parts.length >= 3 ? `${parts[1]}:${parts[2]}` : groupId;
}

/**
 * Playback owns one circular chain of group leaves. Province and direction are
 * ordering dimensions, not linked nodes: cross-level next pointers made the
 * previous nested chain traverse into its own outer ring indefinitely.
 */
export function buildPlaybackChain(
    groups: readonly Rm2GroupDTO[],
    routesByGroupId: ReadonlyMap<string, RenderRouteDTO[]> = new Map(),
): ChainNode | null {
    const orderedGroups = [...groups].sort((left, right) => (
        left.mapKey.localeCompare(right.mapKey)
        || extractDirection(left.groupId).localeCompare(extractDirection(right.groupId))
        || left.index - right.index
        || left.groupId.localeCompare(right.groupId)
    ));
    if (orderedGroups.length === 0) return null;

    const nodes: ChainNode[] = orderedGroups.map((group) => ({
        id: group.groupId,
        label: group.groupName,
        next: null,
        child: null,
        routes: routesByGroupId.get(group.groupId) ?? [],
        durationMs: calcDuration(group.count),
    } satisfies ChainNode));

    nodes.forEach((node, index) => {
        node.next = nodes[(index + 1) % nodes.length];
    });

    return { id: 'root', label: 'RM2', next: null, child: nodes[0] };
}
