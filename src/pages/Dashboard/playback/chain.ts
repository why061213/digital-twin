import type { Rm2GroupDTO, RenderRouteDTO } from '../services/renderRouteApi';

// ============================================================
// 嵌套链表播放结构
//
// Root (环)
//   Province → Direction → Group → Route (叶子)
//
// 只有最外层 Province 是环形，内层 Direction/Group 都是线性。
// 内层尾节点 .next 指向外层下一个节点，播完自动回上层。
// ============================================================

/** 链表节点 */
export type ChainNode = {
    id: string;
    label: string;
    /** 本层下一个节点（叶子层无） */
    next: ChainNode | null;
    /** 下一层头节点 */
    child: ChainNode | null;
    /** 叶子数据：仅 Group 层有 */
    routes?: RenderRouteDTO[];
    durationMs?: number;
};

// ============================================================
// 构建
// ============================================================

const SECONDS_PER_ROUTE = 8;
const MIN_SECONDS = 15;
const MAX_SECONDS = 60;

function calcDuration(routeCount: number): number {
    return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, routeCount * SECONDS_PER_ROUTE)) * 1000;
}

/** 将后端 groups 构建为播放链表 */
export function buildPlaybackChain(
    groups: Rm2GroupDTO[],
    routesByGroupId: Map<string, RenderRouteDTO[]>,
): ChainNode | null {
    if (groups.length === 0) return null;

    // 按 mapKey 分组 → Province
    const provinceMap = new Map<string, Rm2GroupDTO[]>();
    for (const g of groups) {
        const key = g.mapKey || '000000';
        if (!provinceMap.has(key)) provinceMap.set(key, []);
        provinceMap.get(key)!.push(g);
    }

    // 每个 Province 内按 OD (from:to) 分组 → Direction
    const provinceNodes: ChainNode[] = [];
    for (const [mapKey, pGroups] of provinceMap) {
        const dirMap = new Map<string, Rm2GroupDTO[]>();
        for (const g of pGroups) {
            const odKey = extractOD(g.groupId);
            if (!dirMap.has(odKey)) dirMap.set(odKey, []);
            dirMap.get(odKey)!.push(g);
        }

        // Direction 内按 index 排序 groups
        const dirNodes: ChainNode[] = [];
        for (const [odKey, dGroups] of dirMap) {
            dGroups.sort((a, b) => a.index - b.index);
            const groupNodes: ChainNode[] = [];
            for (const g of dGroups) {
                const routes = routesByGroupId.get(g.groupId) ?? [];
                groupNodes.push({
                    id: g.groupId,
                    label: g.groupName,
                    next: null,
                    child: null,
                    routes,
                    durationMs: calcDuration(g.count),
                });
            }
            // 线性：G1.next=G2, G2.next=G3, ..., GN.next = Direction.next（后面链）
            for (let i = 0; i < groupNodes.length - 1; i++) {
                groupNodes[i].next = groupNodes[i + 1];
            }

            dirNodes.push({
                id: odKey,
                label: odKey, // 如 "440000:360000"
                next: null,
                child: groupNodes[0] ?? null,
            });
        }
        // Direction 链表线性
        for (let i = 0; i < dirNodes.length - 1; i++) {
            dirNodes[i].next = dirNodes[i + 1];
        }

        provinceNodes.push({
            id: mapKey,
            label: mapKey,
            next: null,
            child: dirNodes[0] ?? null,
        });
    }

    // Province 环形链表
    for (let i = 0; i < provinceNodes.length - 1; i++) {
        provinceNodes[i].next = provinceNodes[i + 1];
    }
    // 尾→头 形成环
    if (provinceNodes.length > 0) {
        provinceNodes[provinceNodes.length - 1].next = provinceNodes[0];
    }

    // 关键：内层尾节点 .next 指向外层下一个节点
    // Group 尾 → 下一个 Direction（或下一个 Province）
    // Direction 尾 → 下一个 Province
    linkTailToParentNext(provinceNodes);

    // 创建 Root 包装节点
    return {
        id: 'root',
        label: 'Root',
        next: null,
        child: provinceNodes[0] ?? null,
    };
}

/** 提取 OD 键：从 groupId "rm2:440000:360000:page-1:hash" 中取 "440000:360000" */
function extractOD(groupId: string): string {
    const parts = groupId.split(':');
    if (parts.length >= 3) return parts[1] + ':' + parts[2];
    return groupId;
}

/** 将每层尾节点的 next 连接到上一层的下一个节点 */
function linkTailToParentNext(provinceNodes: ChainNode[]) {
    for (const prov of provinceNodes) {
        // Direction 尾.next = Province.next
        let dir = prov.child;
        if (!dir) continue;
        let dirTail = dir;
        while (dirTail.next) dirTail = dirTail.next!;
        dirTail.next = prov.next;

        while (dir) {
            // Group 尾.next = Direction.next
            let group = dir.child;
            if (group) {
                let groupTail = group;
                while (groupTail.next) groupTail = groupTail.next!;
                groupTail.next = dir.next;
            }
            dir = dir.next;
            // 避免环（链尾指向了头）
            if (dir === prov.child) break;
        }
    }
}
