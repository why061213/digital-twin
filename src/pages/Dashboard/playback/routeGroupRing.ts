import type { RouteGroupNode, RouteGroupRing, RouteGroupSnapshot } from './types';

type IndexedSnapshot = RouteGroupSnapshot & { sourceIndex: number };

export function createRing(): RouteGroupRing {
    return { nodes: new Map(), head: null, tail: null, current: null };
}

export function normalizeRing(ring: RouteGroupRing): RouteGroupRing {
    const nodes = Array.from(ring.nodes.values());
    if (nodes.length === 0) {
        ring.head = null;
        ring.tail = null;
        ring.current = null;
        return ring;
    }

    ring.head = nodes[0];
    ring.tail = nodes[nodes.length - 1];
    nodes.forEach((node, index) => {
        node.next = nodes[(index + 1) % nodes.length];
    });

    if (!ring.current || !ring.nodes.has(ring.current.groupId)) {
        ring.current = ring.head;
    }
    return ring;
}

export function removeNode(ring: RouteGroupRing, groupId: string): RouteGroupNode | null {
    const node = ring.nodes.get(groupId);
    if (!node) return null;

    const nextGroupId = node.next?.groupId ?? null;
    const wasCurrent = ring.current?.groupId === groupId;
    ring.nodes.delete(groupId);
    normalizeRing(ring);

    if (wasCurrent) {
        ring.current = nextGroupId ? ring.nodes.get(nextGroupId) ?? ring.head : ring.head;
    }
    return node;
}

export function setCurrent(ring: RouteGroupRing, groupId: string): boolean {
    const node = ring.nodes.get(groupId);
    if (!node) return false;
    ring.current = node;
    return true;
}

export function getNext(ring: RouteGroupRing): RouteGroupNode | null {
    return ring.current?.next ?? ring.head;
}

export function syncRing<T extends RouteGroupSnapshot>(ring: RouteGroupRing, groups: readonly T[]): RouteGroupRing {
    const previousCurrentId = ring.current?.groupId ?? null;
    const previousNextId = ring.current?.next?.groupId ?? null;
    const snapshots = normalizeSnapshots(groups);
    const nextIds = new Set(snapshots.map((group) => group.groupId));
    const nextNodes = new Map<string, RouteGroupNode>();

    snapshots.forEach(({ groupId }) => {
        nextNodes.set(groupId, ring.nodes.get(groupId) ?? { groupId, next: null });
    });

    ring.nodes = nextNodes;
    normalizeRing(ring);

    if (previousCurrentId && nextIds.has(previousCurrentId)) {
        ring.current = ring.nodes.get(previousCurrentId) ?? ring.head;
    } else if (previousNextId && nextIds.has(previousNextId)) {
        ring.current = ring.nodes.get(previousNextId) ?? ring.head;
    }
    return ring;
}

function normalizeSnapshots<T extends RouteGroupSnapshot>(groups: readonly T[]): IndexedSnapshot[] {
    const unique = new Map<string, IndexedSnapshot>();
    groups.forEach((group, sourceIndex) => {
        const groupId = group.groupId?.trim();
        if (!groupId || unique.has(groupId)) return;
        unique.set(groupId, { ...group, groupId, sourceIndex });
    });

    return Array.from(unique.values()).sort((left, right) => {
        const leftIndex = typeof left.index === 'number' && Number.isFinite(left.index) ? left.index : null;
        const rightIndex = typeof right.index === 'number' && Number.isFinite(right.index) ? right.index : null;
        if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
            return leftIndex - rightIndex;
        }
        return left.sourceIndex - right.sourceIndex;
    });
}
