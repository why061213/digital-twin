import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ChinaMap3DHandle } from '../modules/ChinaMap3D';
import type { ViewMode } from '../types';
import { buildGlobalChain, type GlobalNode, type GlobalNodeKind } from '../playback/globalChain';
import { LABEL_CONFIG } from '@/config/labelLayout';

type UseGlobalPlaybackControllerOptions = {
    /** 切换视图函数 */
    onViewChange: (nextView: ViewMode) => void;
    /** ChinaMap ref */
    chinaMapRef: RefObject<ChinaMap3DHandle | null>;
    /** RM1 路线组数量（>0 即有可播放内容） */
    rm1GroupCount: number;
    /** RM2 路线组数量 */
    rm2GroupCount: number;
    /** 是否启用全局播放 */
    enabled?: boolean;
};

type UseGlobalPlaybackControllerResult = {
    /** 当前链表节点类型 */
    currentNodeKind: GlobalNodeKind;
    /** 注册 RM1 耗尽回调（由 useRoadGroupsController 调用） */
    registerRm1Exhausted: (callback: (() => void) | null) => void;
    /** 注册 RM2 耗尽回调（由 useRm2PlaybackController 调用） */
    registerRm2Exhausted: (callback: (() => void) | null) => void;
    /** 手动推进到下一个节点 */
    advanceToNext: () => void;
};

export function useGlobalPlaybackController({
    onViewChange,
    chinaMapRef,
    rm1GroupCount,
    rm2GroupCount,
    enabled = true,
}: UseGlobalPlaybackControllerOptions): UseGlobalPlaybackControllerResult {
    const chainRef = useRef<GlobalNode>(buildGlobalChain());
    const currentNodeRef = useRef<GlobalNode>(chainRef.current);
    const [currentNodeKind, setCurrentNodeKind] = useState<GlobalNodeKind>('chinaMap');
    const chinaMapLoopRef = useRef(0);
    const advancingRef = useRef(false);
    const rm1ExhaustedCallbackRef = useRef<(() => void) | null>(null);
    const rm2ExhaustedCallbackRef = useRef<(() => void) | null>(null);
    const emptyRetryTimerRef = useRef<number | null>(null);
    const chinaMapLoopCount = LABEL_CONFIG.globalPlayback.chinaMapLoopCount;
    const emptyViewRetryMs = LABEL_CONFIG.globalPlayback.emptyViewRetryMs;

    const clearEmptyRetry = useCallback(() => {
        if (emptyRetryTimerRef.current !== null) {
            window.clearTimeout(emptyRetryTimerRef.current);
            emptyRetryTimerRef.current = null;
        }
    }, []);

    const advanceTo = useCallback((node: GlobalNode) => {
        if (advancingRef.current) return;
        advancingRef.current = true;
        clearEmptyRetry();
        currentNodeRef.current = node;
        setCurrentNodeKind(node.kind);

        console.info('[GlobalPlayback] entering node:', node.kind, node.label);

        switch (node.kind) {
            case 'chinaMap': {
                chinaMapLoopRef.current = 0;
                // 切换到 ChinaMap 视图
                onViewChange('chinaMap');
                // 启动仓库巡游（等视图就绪后由 ChinaMap 的 onVisualReady 触发 startWarehouseTour）
                advancingRef.current = false;
                break;
            }
            case 'rm1Judge': {
                // Judge 节点不切换视图，保持前一个视图的内容播放
                advancingRef.current = false;
                if (rm1GroupCount > 0) {
                    console.info('[GlobalPlayback] RM1 has content, advancing to RM1');
                    advanceTo(node.next!);
                } else {
                    console.info('[GlobalPlayback] RM1 empty, skipping to RM2_Judge');
                    advanceTo(node.next!.next!); // 跳过 RM1，直接到 RM2_Judge
                }
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
                advancingRef.current = false;
                if (rm2GroupCount > 0) {
                    console.info('[GlobalPlayback] RM2 has content, advancing to RM2');
                    advanceTo(node.next!);
                } else {
                    console.info('[GlobalPlayback] RM2 empty, skipping to End');
                    advanceTo(node.next!.next!); // 跳过 RM2，直接到 End
                }
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
                // End 节点：重置计数，回到 ChinaMap
                advancingRef.current = false;
                console.info('[GlobalPlayback] end node, looping back to ChinaMap');
                advanceTo(node.next!);
                break;
            }
        }
    }, [clearEmptyRetry, onViewChange, rm1GroupCount, rm2GroupCount]);

    const advanceToNext = useCallback(() => {
        const next = currentNodeRef.current.next;
        if (next) advanceTo(next);
    }, [advanceTo]);

    // ChinaMap 巡游循环完成回调
    const handleChinaMapLoopCompleted = useCallback(() => {
        if (currentNodeRef.current.kind !== 'chinaMap') return;
        chinaMapLoopRef.current += 1;
        console.info('[GlobalPlayback] ChinaMap loop completed:', chinaMapLoopRef.current, '/', chinaMapLoopCount);
        if (chinaMapLoopRef.current >= chinaMapLoopCount) {
            const next = currentNodeRef.current.next;
            if (next) advanceTo(next);
        }
    }, [chinaMapLoopCount, advanceTo]);

    // 设置 ChinaMap 的巡游循环回调
    useEffect(() => {
        chinaMapRef.current?.onTourLoopCompleted(handleChinaMapLoopCompleted);
        return () => {
            chinaMapRef.current?.onTourLoopCompleted(null);
        };
    }, [chinaMapRef, handleChinaMapLoopCompleted]);

    // 注册 RM1 耗尽回调
    const registerRm1Exhausted = useCallback((callback: (() => void) | null) => {
        rm1ExhaustedCallbackRef.current = callback;
    }, []);

    // 注册 RM2 耗尽回调
    const registerRm2Exhausted = useCallback((callback: (() => void) | null) => {
        rm2ExhaustedCallbackRef.current = callback;
    }, []);

    // 监听 RM1/RM2 的 groupCount 变化，空时轮询重试
    useEffect(() => {
        if (!enabled) return;
        const node = currentNodeRef.current;

        // RM1 激活时，检查是否有内容
        if (node.kind === 'rm1' && rm1GroupCount === 0 && !advancingRef.current) {
            console.info('[GlobalPlayback] RM1 exhausted, retrying...');
            clearEmptyRetry();
            emptyRetryTimerRef.current = window.setTimeout(() => {
                emptyRetryTimerRef.current = null;
                if (rm1GroupCount === 0 && currentNodeRef.current.kind === 'rm1') {
                    advanceTo(node.next!);
                }
            }, emptyViewRetryMs);
        }

        // RM2 激活时，检查是否有内容
        if (node.kind === 'rm2' && rm2GroupCount === 0 && !advancingRef.current) {
            console.info('[GlobalPlayback] RM2 exhausted, retrying...');
            clearEmptyRetry();
            emptyRetryTimerRef.current = window.setTimeout(() => {
                emptyRetryTimerRef.current = null;
                if (rm2GroupCount === 0 && currentNodeRef.current.kind === 'rm2') {
                    advanceTo(node.next!);
                }
            }, emptyViewRetryMs);
        }
    }, [rm1GroupCount, rm2GroupCount, enabled, advanceTo, clearEmptyRetry, emptyViewRetryMs]);

    // 清理
    useEffect(() => () => clearEmptyRetry(), [clearEmptyRetry]);

    return {
        currentNodeKind,
        registerRm1Exhausted,
        registerRm2Exhausted,
        advanceToNext,
    };
}
