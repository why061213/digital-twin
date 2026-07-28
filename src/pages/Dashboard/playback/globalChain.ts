/**
 * 全局播放链表类型定义。
 *
 * 固定链表结构：
 *   Head → ChinaMap → RM1_Judge → RM1 → RM2_Judge → RM2 → End → (回到ChinaMap)
 *
 * - Judge 节点不切换视图，仅检查对应视图是否有可播放内容
 * - 切换到 Judge 节点时不结束前一个节点的播放（避免黑屏）
 */

export type GlobalNodeKind = 'chinaMap' | 'rm1Judge' | 'rm1' | 'rm2Judge' | 'rm2' | 'end';

export type GlobalNode = {
    id: string;
    kind: GlobalNodeKind;
    label: string;
    next: GlobalNode | null;
};

/** 构建全局播放链表（环形） */
export function buildGlobalChain(): GlobalNode {
    const chinaMap: GlobalNode = { id: 'chinaMap', kind: 'chinaMap', label: 'ChinaMap', next: null };
    const rm1Judge: GlobalNode = { id: 'rm1Judge', kind: 'rm1Judge', label: 'RM1 Judge', next: null };
    const rm1: GlobalNode = { id: 'rm1', kind: 'rm1', label: 'RM1', next: null };
    const rm2Judge: GlobalNode = { id: 'rm2Judge', kind: 'rm2Judge', label: 'RM2 Judge', next: null };
    const rm2: GlobalNode = { id: 'rm2', kind: 'rm2', label: 'RM2', next: null };
    const end: GlobalNode = { id: 'end', kind: 'end', label: 'End', next: null };

    chinaMap.next = rm1Judge;
    rm1Judge.next = rm1;
    rm1.next = rm2Judge;
    rm2Judge.next = rm2;
    rm2.next = end;
    end.next = chinaMap;

    return chinaMap;
}

export type GlobalPlaybackConfig = {
    /** ChinaMap 仓库巡游循环次数，达到后进入下一节点 */
    chinaMapLoopCount: number;
    /** 空视图重试间隔（ms） */
    emptyViewRetryMs: number;
};
