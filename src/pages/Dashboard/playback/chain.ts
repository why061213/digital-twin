import type {
    RenderRouteDTO,
    Rm2ChainNodeDTO,
    Rm2ChainStructureResponse,
    Rm2GroupDTO,
} from '../services/renderRouteApi';

export type ChainNode = {
    id: string;
    kind: 'root' | 'province' | 'direction' | 'group';
    label: string;
    parentId: string | null;
    hierarchyNext: ChainNode | null;
    playbackNext: ChainNode | null;
    child: ChainNode | null;
    groupId?: string;
    provinceKey?: string;
    directionKey?: string;
    provinceMapKeys?: string[];
    directionMapKeys?: string[];
    routes?: RenderRouteDTO[];
    durationMs?: number;
};

export type PlaybackChain = {
    root: ChainNode;
    headLeaf: ChainNode | null;
    nodes: Map<string, ChainNode>;
    leaves: Map<string, ChainNode>;
};

const SECONDS_PER_ROUTE = 8;
const MIN_SECONDS = 15;
const MAX_SECONDS = 60;

function calcDuration(routeCount: number): number {
    return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, routeCount * SECONDS_PER_ROUTE)) * 1000;
}

function orderedRing(
    candidateNodeIds: readonly string[],
    rawNodes: ReadonlyMap<string, Rm2ChainNodeDTO>,
    acceptedNodeIds: ReadonlySet<string>,
    preferredHeadId?: string | null,
) {
    const fallback = candidateNodeIds
        .map((nodeId) => rawNodes.get(nodeId))
        .filter((node): node is Rm2ChainNodeDTO => Boolean(node && acceptedNodeIds.has(node.nodeId)))
        .sort((left, right) => left.index - right.index || left.nodeId.localeCompare(right.nodeId));
    if (fallback.length < 2) return fallback;

    const remaining = new Map(fallback.map((node) => [node.nodeId, node]));
    const head = (preferredHeadId ? remaining.get(preferredHeadId) : null) ?? fallback[0];
    const ordered: Rm2ChainNodeDTO[] = [];
    let current: Rm2ChainNodeDTO | undefined = head;
    while (current && remaining.delete(current.nodeId)) {
        ordered.push(current);
        current = remaining.get(current.nextNodeId);
    }
    fallback.forEach((node) => {
        if (remaining.delete(node.nodeId)) ordered.push(node);
    });
    return ordered;
}

function linkHierarchyRing(nodes: ChainNode[]) {
    nodes.forEach((node, index) => {
        node.hierarchyNext = nodes[(index + 1) % nodes.length] ?? null;
    });
}

/**
 * Reconciles the immutable backend hierarchy with the currently playable leaf
 * groups. The hierarchy keeps three independent sibling rings; playbackNext
 * provides the depth-first leaf sequence used by the animation controller.
 */
export function buildPlaybackChain(
    structure: Rm2ChainStructureResponse,
    groups: readonly Rm2GroupDTO[],
    routesByGroupId: ReadonlyMap<string, RenderRouteDTO[]> = new Map(),
): PlaybackChain {
    const rawNodes = new Map(structure.nodes.map((node) => [node.nodeId, node]));
    const groupById = new Map(groups.map((group) => [group.groupId, group]));
    const acceptedLeafIds = new Set(
        structure.leafGroupIds.filter((groupId) => groupById.has(groupId)),
    );

    const acceptedDirectionIds = new Set<string>();
    structure.nodes.filter((node) => node.nodeType === 'direction').forEach((node) => {
        if (node.childNodeIds.some((childId) => acceptedLeafIds.has(childId))) {
            acceptedDirectionIds.add(node.nodeId);
        }
    });
    const acceptedProvinceIds = new Set<string>();
    structure.nodes.filter((node) => node.nodeType === 'province').forEach((node) => {
        if (node.childNodeIds.some((childId) => acceptedDirectionIds.has(childId))) {
            acceptedProvinceIds.add(node.nodeId);
        }
    });

    const nodes = new Map<string, ChainNode>();
    const leaves = new Map<string, ChainNode>();
    acceptedLeafIds.forEach((groupId) => {
        const raw = rawNodes.get(groupId);
        const group = groupById.get(groupId);
        if (!raw || !group || raw.nodeType !== 'group') return;
        const directionRaw = rawNodes.get(raw.parentNodeId);
        const provinceRaw = directionRaw ? rawNodes.get(directionRaw.parentNodeId) : null;
        const leaf: ChainNode = {
            id: raw.nodeId,
            kind: 'group',
            label: group.groupName,
            parentId: raw.parentNodeId,
            hierarchyNext: null,
            playbackNext: null,
            child: null,
            groupId,
            provinceKey: provinceRaw?.key ?? group.fromProvinceKey,
            directionKey: directionRaw?.key ?? group.directionKey,
            provinceMapKeys: provinceRaw?.renderProvinceKeys ?? [group.fromProvinceKey],
            directionMapKeys: directionRaw?.renderProvinceKeys ?? group.renderProvinceKeys,
            routes: routesByGroupId.get(groupId) ?? [],
            durationMs: calcDuration(group.count),
        };
        nodes.set(leaf.id, leaf);
        leaves.set(groupId, leaf);
    });

    acceptedDirectionIds.forEach((nodeId) => {
        const raw = rawNodes.get(nodeId);
        if (!raw) return;
        nodes.set(nodeId, {
            id: nodeId,
            kind: 'direction',
            label: raw.label,
            parentId: raw.parentNodeId,
            hierarchyNext: null,
            playbackNext: null,
            child: null,
            directionKey: raw.key,
            directionMapKeys: raw.renderProvinceKeys,
        });
    });
    acceptedProvinceIds.forEach((nodeId) => {
        const raw = rawNodes.get(nodeId);
        if (!raw) return;
        nodes.set(nodeId, {
            id: nodeId,
            kind: 'province',
            label: raw.label,
            parentId: raw.parentNodeId,
            hierarchyNext: null,
            playbackNext: null,
            child: null,
            provinceKey: raw.key,
            provinceMapKeys: raw.renderProvinceKeys,
        });
    });

    const provinceIds = structure.nodes
        .filter((node) => node.nodeType === 'province')
        .map((node) => node.nodeId);
    const provinces = orderedRing(
        provinceIds,
        rawNodes,
        acceptedProvinceIds,
        structure.headNodeId,
    );
    const orderedLeaves: ChainNode[] = [];
    provinces.forEach((provinceRaw) => {
        const province = nodes.get(provinceRaw.nodeId);
        if (!province) return;
        const directionRaws = orderedRing(
            provinceRaw.childNodeIds,
            rawNodes,
            acceptedDirectionIds,
            provinceRaw.childNodeIds[0],
        );
        const directions = directionRaws
            .map((raw) => nodes.get(raw.nodeId))
            .filter((node): node is ChainNode => Boolean(node));
        linkHierarchyRing(directions);
        province.child = directions[0] ?? null;

        directionRaws.forEach((directionRaw) => {
            const direction = nodes.get(directionRaw.nodeId);
            if (!direction) return;
            const groupRaws = orderedRing(
                directionRaw.childNodeIds,
                rawNodes,
                acceptedLeafIds,
                directionRaw.childNodeIds[0],
            );
            const groupNodes = groupRaws
                .map((raw) => leaves.get(raw.groupId ?? raw.nodeId))
                .filter((node): node is ChainNode => Boolean(node));
            linkHierarchyRing(groupNodes);
            direction.child = groupNodes[0] ?? null;
            orderedLeaves.push(...groupNodes);
        });
    });
    const provinceNodes = provinces
        .map((raw) => nodes.get(raw.nodeId))
        .filter((node): node is ChainNode => Boolean(node));
    linkHierarchyRing(provinceNodes);

    orderedLeaves.forEach((leaf, index) => {
        leaf.playbackNext = orderedLeaves[(index + 1) % orderedLeaves.length] ?? null;
    });
    const root: ChainNode = {
        id: 'rm2:root',
        kind: 'root',
        label: 'RM2',
        parentId: null,
        hierarchyNext: null,
        playbackNext: null,
        child: provinceNodes[0] ?? null,
    };
    nodes.set(root.id, root);

    return { root, headLeaf: orderedLeaves[0] ?? null, nodes, leaves };
}
