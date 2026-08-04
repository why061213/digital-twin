export type SingleRm1GroupAction = 'exhaust' | 'replay';

/** 单节点环不能靠 next 推进：节点已完成或已从快照消失时，应结束本轮 RM1。 */
export function singleRm1GroupAction(
    groupStillAvailable: boolean,
    groupComplete: boolean,
): SingleRm1GroupAction {
    return groupStillAvailable && !groupComplete ? 'replay' : 'exhaust';
}
