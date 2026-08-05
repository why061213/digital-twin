export type SingleRm1GroupAction = 'exhaust' | 'traverse';

/** 刷新快照后仍只有一个节点时，本次 advance 应退出 RM1，不能重播当前节点。 */
export function singleRm1GroupAction(groupCountAfterRefresh: number): SingleRm1GroupAction {
    return groupCountAfterRefresh <= 1 ? 'exhaust' : 'traverse';
}
