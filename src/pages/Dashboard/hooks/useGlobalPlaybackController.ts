import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ChinaMap3DHandle } from '../modules/ChinaMap3D';
import type { ViewMode } from '../types';
import { buildGlobalChain, type GlobalNode, type GlobalNodeKind } from '../playback/globalChain';
import { LABEL_CONFIG } from '@/config/labelLayout';

type UseGlobalPlaybackControllerOptions = {
    /** 当前视图 */
    currentView: ViewMode;
    /** 切换视图函数 */
    onViewChange: (nextView: ViewMode) => void;
    /** ChinaMap ref */
    chinaMapRef: RefObject<ChinaMap3DHandle | null>;
    /** ChinaMap 是否视觉就绪 */
    isChinaMapVisualReady: boolean;
    /** RM1 路线组数量（>0 即有可播放内容） */
    rm1GroupCount: number;
    /** RM2 路线组数量 */
    rm2GroupCount: number;
    /** 检查 RM1 是否有可播放数据（直接调 API，返回 boolean） */
    fetchRm1Data: () => Promise<boolean>;
    /** 检查 RM2 是否有可播放数据（直接调 API，返回 boolean） */
    fetchRm2Data: () => Promise<boolean>;
    /** 是否启用全局播放 */
    enabled?: boolean;
};

type UseGlobalPlaybackControllerResult = {
    /** 当前链表节点类型 */
    currentNodeKind: GlobalNodeKind;
    /** 手动推进到下一个节点 */
    advanceToNext: () => void;
    /** 手动直达视图，同时同步链表当前节点。 */
    jumpToView: (view: ViewMode) => void;
};

export function useGlobalPlaybackController({
    currentView,
    onViewChange,
    chinaMapRef,
    isChinaMapVisualReady,
    rm1GroupCount,
    rm2GroupCount,
    fetchRm1Data,
    fetchRm2Data,
    enabled = true,
}: UseGlobalPlaybackControllerOptions): UseGlobalPlaybackControllerResult {
    const [chain] = useState(buildGlobalChain);
    const currentNodeRef = useRef<GlobalNode>(chain);
    const [currentNodeKind, setCurrentNodeKind] = useState<GlobalNodeKind>('chinaMap');
    const chinaMapLoopRef = useRef(0);
    const totalLoopRef = useRef(0);
    const advancingRef = useRef(false);
    const viewEnteredAtRef = useRef(0);  // 进入 rm1/rm2 的时间戳，用于冷却期
    const emptyRetryTimerRef = useRef<number | null>(null);
    const loopCallbackInstalledRef = useRef(false);
    const advanceTimerRef = useRef<number | null>(null);
    const advanceToRef = useRef<(node: GlobalNode) => void>(() => {});
    const config = LABEL_CONFIG.globalPlayback;
    const chinaMapLoopCount = config.chinaMapLoopCount;
    const totalLoopCount = config.totalLoopCount ?? 0; // 0=无限循环
    const emptyViewRetryMs = config.emptyViewRetryMs;
    const rm1GroupHoldMs = config.rm1GroupHoldMs;
    const viewCooldownMs = config.viewCooldownMs;

    const clearEmptyRetry = useCallback(() => {
        if (emptyRetryTimerRef.current !== null) {
            window.clearTimeout(emptyRetryTimerRef.current);
            emptyRetryTimerRef.current = null;
        }
    }, []);

    const handleChinaMapLoopCompleted = useCallback(() => {
        if (currentNodeRef.current.kind !== 'chinaMap') return;
        chinaMapLoopRef.current += 1;
        console.info('[GlobalPlayback] ChinaMap loop completed:', chinaMapLoopRef.current, '/', chinaMapLoopCount);
        if (chinaMapLoopRef.current >= chinaMapLoopCount) {
            const next = currentNodeRef.current.next;
            if (!next) return;
            // 使用 setTimeout 异步推进，避免在 onLoopCompleted 回调栈中同步完成整条链。
            // 否则 RM1_Judge→RM2_Judge→End→ChinaMap 同步执行，计数器被立即重置为 0。
            if (advanceTimerRef.current !== null) window.clearTimeout(advanceTimerRef.current);
            advanceTimerRef.current = window.setTimeout(() => {
                advanceTimerRef.current = null;
                console.info('[GlobalPlayback] ChinaMap loop count reached, advancing to', next.label);
                advanceToRef.current(next);
            }, 300);
        }
    }, [chinaMapLoopCount]);

    // 安装/卸载 ChinaMap 巡游循环回调。用 isChinaMapVisualReady 触发重装。
    useEffect(() => {
        const chinaMap = chinaMapRef.current;
        if (isChinaMapVisualReady && chinaMap && !loopCallbackInstalledRef.current) {
            chinaMap.onTourLoopCompleted(handleChinaMapLoopCompleted);
            loopCallbackInstalledRef.current = true;
            console.info('[GlobalPlayback] installed ChinaMap loop callback');
        }
        return () => {
            if (loopCallbackInstalledRef.current && chinaMap) {
                chinaMap.onTourLoopCompleted(null);
                loopCallbackInstalledRef.current = false;
            }
        };
    }, [chinaMapRef, handleChinaMapLoopCompleted, isChinaMapVisualReady]);

    const advanceTo = useCallback((node: GlobalNode) => {
        if (advancingRef.current) return;
        advancingRef.current = true;
        clearEmptyRetry();
        currentNodeRef.current = node;
        setCurrentNodeKind(node.kind);

        console.info('[GlobalPlayback] entering node:', node.kind, node.label,
            '| rm1Groups:', rm1GroupCount, '| rm2Groups:', rm2GroupCount);

        switch (node.kind) {
            case 'chinaMap': {
                chinaMapLoopRef.current = 0;
                // 如果已经在 ChinaMap 视图，直接重启巡游（避免 requestViewChange 短路）
                if (currentView === 'chinaMap' && chinaMapRef.current) {
                    console.info('[GlobalPlayback] already in chinaMap view, restarting warehouse tour');
                    chinaMapRef.current.startWarehouseTour();
                } else {
                    onViewChange('chinaMap');
                }
                advancingRef.current = false;
                break;
            }
            case 'rm1Judge': {
                advancingRef.current = false;
                const nextRm1 = node.next!;
                const nextRm2Judge = nextRm1.next!;
                console.info('[GlobalPlayback] RM1 Judge: checking data...');
                fetchRm1Data().then((hasData) => {
                    if (hasData) {
                        console.info('[GlobalPlayback] RM1 has data, advancing to RM1');
                        advanceToRef.current(nextRm1);
                    } else {
                        console.info('[GlobalPlayback] RM1 no data, skipping to RM2_Judge');
                        advanceToRef.current(nextRm2Judge);
                    }
                }).catch((err: unknown) => {
                    console.warn('[GlobalPlayback] RM1 fetch failed, skipping', err);
                    advanceToRef.current(nextRm2Judge);
                });
                break;
            }
            case 'rm1': {
                // Judge 已确认有数据，直接切换视图
                viewEnteredAtRef.current = Date.now();
                onViewChange('roadMap');
                advancingRef.current = false;
                break;
            }
            case 'rm2Judge': {
                advancingRef.current = false;
                const nextRm2 = node.next!;
                const nextEnd = nextRm2.next!;
                console.info('[GlobalPlayback] RM2 Judge: checking data...');
                fetchRm2Data().then((hasData) => {
                    if (hasData) {
                        console.info('[GlobalPlayback] RM2 has data, advancing to RM2');
                        advanceToRef.current(nextRm2);
                    } else {
                        console.info('[GlobalPlayback] RM2 no data, skipping to End');
                        advanceToRef.current(nextEnd);
                    }
                }).catch((err: unknown) => {
                    console.warn('[GlobalPlayback] RM2 fetch failed, skipping', err);
                    advanceToRef.current(nextEnd);
                });
                break;
            }
            case 'rm2': {
                // Judge 已确认有数据，直接切换视图
                viewEnteredAtRef.current = Date.now();
                onViewChange('roadMap2');
                advancingRef.current = false;
                break;
            }
            case 'end': {
                totalLoopRef.current += 1;
                console.info('[GlobalPlayback] end node, total loops:', totalLoopRef.current,
                    totalLoopCount > 0 ? '/ ' + totalLoopCount : '(unlimited)');
                advancingRef.current = false;
                // 总循环次数限制
                if (totalLoopCount > 0 && totalLoopRef.current >= totalLoopCount) {
                    console.info('[GlobalPlayback] total loop limit reached, restarting chinaMap and stopping');
                    // 最后一次回到 ChinaMap 后不再推进
                    advanceToRef.current(node.next!);
                    return;
                }
                advanceToRef.current(node.next!);
                break;
            }
        }
    }, [clearEmptyRetry, onViewChange, rm1GroupCount, rm2GroupCount, currentView, chinaMapRef, fetchRm1Data, fetchRm2Data, totalLoopCount]);

    useEffect(() => {
        advanceToRef.current = advanceTo;
    }, [advanceTo]);

    const advanceToNext = useCallback(() => {
        const next = currentNodeRef.current.next;
        if (next) advanceTo(next);
    }, [advanceTo]);

    const jumpToView = useCallback((targetView: ViewMode) => {
        const targetKind: GlobalNodeKind = targetView === 'chinaMap'
            ? 'chinaMap'
            : targetView === 'roadMap'
                ? 'rm1'
                : 'rm2';
        let target = chain;
        do {
            if (target.kind === targetKind) {
                advanceTo(target);
                return;
            }
            target = target.next!;
        } while (target !== chain);
    }, [advanceTo, chain]);

    // 监听 RM1/RM2 的 groupCount 变化，组耗尽时推进（含冷却期避免刚进入就误判）
    useEffect(() => {
        if (!enabled) return;
        const node = currentNodeRef.current;
        // 冷却期内不检测：刚切换视图后数据还在加载中
        const cooldownRemaining = viewCooldownMs - (Date.now() - viewEnteredAtRef.current);
        if ((node.kind === 'rm1' || node.kind === 'rm2') && cooldownRemaining > 0) {
            clearEmptyRetry();
            emptyRetryTimerRef.current = window.setTimeout(() => {
                emptyRetryTimerRef.current = null;
                const currentNode = currentNodeRef.current;
                if (currentNode.kind === 'rm1' && rm1GroupCount === 0) {
                    advanceTo(currentNode.next!);
                } else if (currentNode.kind === 'rm2' && rm2GroupCount === 0) {
                    advanceTo(currentNode.next!);
                }
            }, cooldownRemaining);
            return clearEmptyRetry;
        }

        if (node.kind === 'rm1' && rm1GroupCount === 0 && !advancingRef.current) {
            console.info('[GlobalPlayback] RM1 exhausted, advancing to next');
            clearEmptyRetry();
            emptyRetryTimerRef.current = window.setTimeout(() => {
                emptyRetryTimerRef.current = null;
                if (currentNodeRef.current.kind === 'rm1' && rm1GroupCount === 0) {
                    advanceTo(node.next!);
                }
            }, rm1GroupHoldMs > 0 ? rm1GroupHoldMs : emptyViewRetryMs);
        }

        if (node.kind === 'rm2' && rm2GroupCount === 0 && !advancingRef.current) {
            console.info('[GlobalPlayback] RM2 exhausted, advancing to next');
            clearEmptyRetry();
            emptyRetryTimerRef.current = window.setTimeout(() => {
                emptyRetryTimerRef.current = null;
                if (currentNodeRef.current.kind === 'rm2' && rm2GroupCount === 0) {
                    advanceTo(node.next!);
                }
            }, emptyViewRetryMs);
        }
    }, [rm1GroupCount, rm2GroupCount, enabled, advanceTo, clearEmptyRetry, emptyViewRetryMs, rm1GroupHoldMs, viewCooldownMs]);

    // 启动：页面首次加载时，在 ChinaMap 就绪后自动开始链条
    useEffect(() => {
        if (!enabled || !isChinaMapVisualReady) return;
        if (currentNodeRef.current.kind === 'chinaMap' && chinaMapLoopRef.current === 0 && !advancingRef.current) {
            console.info('[GlobalPlayback] initial start: chinaMap is ready, beginning loop');
            // 确保巡游已启动（DashboardPage 的 useEffect 也会启动，但这里兜底）
            chinaMapRef.current?.startWarehouseTour();
        }
    }, [enabled, isChinaMapVisualReady, chinaMapRef]);

    // 清理
    useEffect(() => () => {
        clearEmptyRetry();
        if (advanceTimerRef.current !== null) {
            window.clearTimeout(advanceTimerRef.current);
            advanceTimerRef.current = null;
        }
    }, [clearEmptyRetry]);

    return {
        currentNodeKind,
        advanceToNext,
        jumpToView,
    };
}
