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
    /** 拉取 RM1 数据（触发 refreshRoadGroups） */
    fetchRm1Data: () => Promise<unknown>;
    /** 拉取 RM2 数据（触发 refreshRm2） */
    fetchRm2Data: () => Promise<unknown>;
    /** 是否启用全局播放 */
    enabled?: boolean;
};

type UseGlobalPlaybackControllerResult = {
    /** 当前链表节点类型 */
    currentNodeKind: GlobalNodeKind;
    /** 手动推进到下一个节点 */
    advanceToNext: () => void;
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
    const chainRef = useRef<GlobalNode>(buildGlobalChain());
    const currentNodeRef = useRef<GlobalNode>(chainRef.current);
    const [currentNodeKind, setCurrentNodeKind] = useState<GlobalNodeKind>('chinaMap');
    const chinaMapLoopRef = useRef(0);
    const totalLoopRef = useRef(0);
    const advancingRef = useRef(false);
    const emptyRetryTimerRef = useRef<number | null>(null);
    const loopCallbackInstalledRef = useRef(false);
    const config = LABEL_CONFIG.globalPlayback;
    const chinaMapLoopCount = config.chinaMapLoopCount;
    const totalLoopCount = config.totalLoopCount ?? 0; // 0=无限循环
    const emptyViewRetryMs = config.emptyViewRetryMs;
    const rm1GroupHoldMs = config.rm1GroupHoldMs;

    const clearEmptyRetry = useCallback(() => {
        if (emptyRetryTimerRef.current !== null) {
            window.clearTimeout(emptyRetryTimerRef.current);
            emptyRetryTimerRef.current = null;
        }
    }, []);

    // 安装/卸载 ChinaMap 巡游循环回调。用 isChinaMapVisualReady 触发重装。
    useEffect(() => {
        if (isChinaMapVisualReady && chinaMapRef.current && !loopCallbackInstalledRef.current) {
            chinaMapRef.current.onTourLoopCompleted(handleChinaMapLoopCompleted);
            loopCallbackInstalledRef.current = true;
            console.info('[GlobalPlayback] installed ChinaMap loop callback');
        }
        return () => {
            if (loopCallbackInstalledRef.current && chinaMapRef.current) {
                chinaMapRef.current.onTourLoopCompleted(null);
                loopCallbackInstalledRef.current = false;
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isChinaMapVisualReady]);

    // ChinaMap 巡游循环完成回调（用 ref 避免闭包问题）
    const advanceTimerRef = useRef<number | null>(null);
    const handleChinaMapLoopCompletedRef = useRef<() => void>(() => {});
    handleChinaMapLoopCompletedRef.current = () => {
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
                advanceTo(next);
            }, 300);
        }
    };
    const handleChinaMapLoopCompleted = useCallback(() => {
        handleChinaMapLoopCompletedRef.current();
    }, []);

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
                // Judge 节点：先拉取 RM1 数据，等待结果后再判断
                advancingRef.current = false;
                const nextRm1 = node.next!;
                const nextRm2Judge = nextRm1.next!;
                console.info('[GlobalPlayback] RM1 Judge: fetching data...');
                fetchRm1Data().then(() => {
                    // 数据拉取完成后，等一个微任务让 state 更新
                    setTimeout(() => {
                        if (rm1GroupCount > 0) {
                            console.info('[GlobalPlayback] RM1 has data (' + rm1GroupCount + ' groups), advancing to RM1');
                            advanceTo(nextRm1);
                        } else {
                            console.info('[GlobalPlayback] RM1 still empty, skipping to RM2_Judge');
                            advanceTo(nextRm2Judge);
                        }
                    }, 500);
                }).catch((err: unknown) => {
                    console.warn('[GlobalPlayback] RM1 fetch failed, skipping', err);
                    advanceTo(nextRm2Judge);
                });
                break;
            }
            case 'rm1': {
                if (rm1GroupCount > 0) {
                    onViewChange('roadMap');
                } else {
                    console.info('[GlobalPlayback] RM1 became empty, advancing');
                    advanceTo(node.next!);
                    return;
                }
                advancingRef.current = false;
                break;
            }
            case 'rm2Judge': {
                // Judge 节点：先拉取 RM2 数据，等待结果后再判断
                advancingRef.current = false;
                const nextRm2 = node.next!;
                const nextEnd = nextRm2.next!;
                console.info('[GlobalPlayback] RM2 Judge: fetching data...');
                fetchRm2Data().then(() => {
                    setTimeout(() => {
                        if (rm2GroupCount > 0) {
                            console.info('[GlobalPlayback] RM2 has data (' + rm2GroupCount + ' groups), advancing to RM2');
                            advanceTo(nextRm2);
                        } else {
                            console.info('[GlobalPlayback] RM2 still empty, skipping to End');
                            advanceTo(nextEnd);
                        }
                    }, 500);
                }).catch((err: unknown) => {
                    console.warn('[GlobalPlayback] RM2 fetch failed, skipping', err);
                    advanceTo(nextEnd);
                });
                break;
            }
            case 'rm2': {
                if (rm2GroupCount > 0) {
                    onViewChange('roadMap2');
                } else {
                    console.info('[GlobalPlayback] RM2 became empty, advancing');
                    advanceTo(node.next!);
                    return;
                }
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
                    advanceTo(node.next!);
                    return;
                }
                advanceTo(node.next!);
                break;
            }
        }
    }, [clearEmptyRetry, onViewChange, rm1GroupCount, rm2GroupCount, currentView, chinaMapRef, fetchRm1Data, fetchRm2Data]);

    const advanceToNext = useCallback(() => {
        const next = currentNodeRef.current.next;
        if (next) advanceTo(next);
    }, [advanceTo]);

    // 监听 RM1/RM2 的 groupCount 变化，组耗尽时推进
    useEffect(() => {
        if (!enabled) return;
        const node = currentNodeRef.current;

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
    }, [rm1GroupCount, rm2GroupCount, enabled, advanceTo, clearEmptyRetry, emptyViewRetryMs, rm1GroupHoldMs]);

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
    };
}
