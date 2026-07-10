import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ViewMode } from '../types';
import { fetchTownRoadRenderEnvelope } from '../services/townRoadApi';
import { townLog } from '../townRoadLogger';
import {
    buildTownAnimationStages,
    buildTownStageRenderCommand,
    CircularAnimationQueue,
    getTownCommandKey,
    mergeTownRenderCommandSnapshot,
    scoreTownScene,
    type TownAnimationStage,
    type TownProvinceEdge,
    type TownRoadDiffSummary,
    type TownRoadMap3DHandle,
    type TownRoadRenderCommand,
    type TownRoadRenderEnvelope,
    type TownRoadRenderIncoming,
    type TownRouteGroup,
    type TownTransportOrder,
    type TownTransportTask,
} from '../modules/TownRoadMap3D';
import { mockTownProvinceRenderCommand } from '../mock/townRenderCommand';

type UseTownRoadControllerParams = {
    view: ViewMode;
    townRoadMapRef: RefObject<TownRoadMap3DHandle | null>;
};

type ExtractedTownRenderPacket = {
    commands: TownRoadRenderCommand[];
    primaryCommandId?: string;
    diff?: TownRoadDiffSummary;
};

type TownOrderMergeResult = {
    added: string[];
    updated: string[];
    unchanged: string[];
    deleted: string[];
};

const DEFAULT_STAGE_DURATION_MS = 5000;

function commandOrders(command: TownRoadRenderCommand): TownTransportTask[] {
    return command.orders?.length ? command.orders : (command.tasks ?? []);
}

function commandRenderProvinces(command: TownRoadRenderCommand): string[] {
    return command.renderProvinces?.length ? command.renderProvinces : (command.renderAdcodes ?? []);
}

function getRenderKey(provinces: string[]) {
    return provinces.slice().sort().join('|');
}

function isDeletedTownOrder(order: TownTransportOrder) {
    return Boolean(order.deleted) || order.status === '已取消';
}

function mergeOrders(
    oldMap: Map<string, TownTransportOrder>,
    incomingOrders: TownTransportOrder[],
): TownOrderMergeResult {
    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const deleted: string[] = [];

    incomingOrders.forEach((order) => {
        if (!order.lineId) return;

        if (isDeletedTownOrder(order)) {
            if (oldMap.delete(order.lineId)) deleted.push(order.lineId);
            return;
        }

        const old = oldMap.get(order.lineId);
        if (!old) {
            oldMap.set(order.lineId, order);
            added.push(order.lineId);
            return;
        }

        if (old.updatedAt === order.updatedAt && old.status === order.status) {
            unchanged.push(order.lineId);
            return;
        }

        oldMap.set(order.lineId, {
            ...old,
            ...order,
            from: order.from ?? old.from,
            to: order.to ?? old.to,
            vehicle: {
                ...old.vehicle,
                ...order.vehicle,
            },
        });
        updated.push(order.lineId);
    });

    return { added, updated, unchanged, deleted };
}

function isEnvelope(payload: TownRoadRenderIncoming): payload is TownRoadRenderEnvelope {
    return !Array.isArray(payload) && Array.isArray((payload as TownRoadRenderEnvelope).commands);
}

function normalizeCommand(command: TownRoadRenderCommand): TownRoadRenderCommand {
    const orders = command.orders ?? command.tasks ?? [];
    const renderProvinces = command.renderProvinces ?? command.renderAdcodes ?? [];

    return {
        ...command,
        type: 'town_road_render',
        renderLevel: command.renderLevel ?? 'province-district',
        renderProvinces,
        orders,
        // 保留旧字段，避免当前版本其他组件还读 tasks/renderAdcodes 时空掉。
        renderAdcodes: command.renderAdcodes ?? renderProvinces,
        tasks: command.tasks ?? orders,
        routeGroups: command.routeGroups ?? [],
        provinceEdges: command.provinceEdges ?? [],
        issuedAt: command.issuedAt ?? new Date().toISOString(),
    };
}

function extractRenderPacket(payload: TownRoadRenderIncoming): ExtractedTownRenderPacket {
    const source = isEnvelope(payload) ? payload.commands : Array.isArray(payload) ? payload : [payload];
    const commands = source
        .filter((command): command is TownRoadRenderCommand => Boolean(command && command.type === 'town_road_render'))
        .map(normalizeCommand);

    return {
        commands,
        primaryCommandId: isEnvelope(payload)
            ? payload.primaryCommandId ?? payload.activeCommandId
            : undefined,
        diff: isEnvelope(payload) ? payload.diff : undefined,
    };
}

function choosePrimaryCommandIndex(commands: TownRoadRenderCommand[], primaryCommandId?: string) {
    if (commands.length === 0) return 0;

    if (primaryCommandId) {
        const exactIndex = commands.findIndex((command) => command.commandId === primaryCommandId);
        if (exactIndex >= 0) return exactIndex;
    }

    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    commands.forEach((command, index) => {
        const score = scoreTownScene(command);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    });
    return bestIndex;
}

function markStageStatus(stage: TownAnimationStage, playbackStatus: TownAnimationStage['playbackStatus'], locked?: boolean) {
    return {
        ...stage,
        playbackStatus,
        locked: locked ?? stage.locked,
    };
}

function getPreferredRenderableStageFromStages(stages: TownAnimationStage[]) {
    return stages.find((stage) => stage.kind === 'route_group_focus')
        ?? stages.find((stage) => stage.kind !== 'scene_boot' && Boolean(stage.payload.renderProvinces?.length))
        ?? stages[0]
        ?? null;
}

function getPreferredRenderableStage(queue: CircularAnimationQueue<TownAnimationStage>, command: TownRoadRenderCommand) {
    const current = queue.current;
    if (current && current.kind !== 'scene_boot') return current;

    const firstQueuedRenderable = queue.find((stage) => stage.kind === 'route_group_focus')
        ?? queue.find((stage) => stage.kind !== 'scene_boot' && Boolean(stage.payload.renderProvinces?.length));
    if (firstQueuedRenderable) return firstQueuedRenderable;

    return getPreferredRenderableStageFromStages(buildTownAnimationStages(command));
}

export function useTownRoadController({ view, townRoadMapRef }: UseTownRoadControllerParams) {
    const [townCommands, setTownCommands] = useState<TownRoadRenderCommand[]>([]);
    const [activeTownCommandIndex, setActiveTownCommandIndex] = useState(0);
    const [lastTownDiff, setLastTownDiff] = useState<TownRoadDiffSummary | null>(null);
    const sceneMapRef = useRef<Map<string, TownRoadRenderCommand>>(new Map());
    const orderMapRef = useRef<Map<string, TownTransportOrder>>(new Map());
    const activeSceneKeyRef = useRef<string | null>(null);
    const activeRenderKeyRef = useRef<string | null>(null);
    const loadingRef = useRef(false);
    const loadedOnceRef = useRef(false);
    const suppressTownWsUntilRef = useRef(0);
    const animationQueueRef = useRef(new CircularAnimationQueue<TownAnimationStage>());
    const animationTimerRef = useRef<number | null>(null);
    const animationRunningRef = useRef(false);
    const currentStageStartedAtRef = useRef<number | null>(null);
    const lastQueueSceneKeyRef = useRef<string | null>(null);
    const queueReadySceneKeyRef = useRef<string | null>(null);
    const townCommandsRef = useRef(townCommands);
    const activeTownCommandIndexRef = useRef(activeTownCommandIndex);
    const [animationQueueRevision, setAnimationQueueRevision] = useState(0);

    useEffect(() => {
        townCommandsRef.current = townCommands;
    }, [townCommands]);

    useEffect(() => {
        activeTownCommandIndexRef.current = activeTownCommandIndex;
    }, [activeTownCommandIndex]);

    const hasTownCommands = townCommands.length > 0;
    const townCommand = townCommands[activeTownCommandIndex] ?? townCommands[0] ?? normalizeCommand(mockTownProvinceRenderCommand);

    const bumpAnimationQueue = useCallback(() => {
        setAnimationQueueRevision((version) => version + 1);
    }, []);

    const syncAnimationQueueForCommand = useCallback((command: TownRoadRenderCommand) => {
        const nextStages = buildTownAnimationStages(command);
        const nextSceneKey = getTownCommandKey(command);
        const queue = animationQueueRef.current;
        const isSceneChanged = lastQueueSceneKeyRef.current !== nextSceneKey;

        if (isSceneChanged) {
            queue.replaceAll(nextStages, { keepCurrent: false });
            lastQueueSceneKeyRef.current = nextSceneKey;

            const preferredStage = getPreferredRenderableStageFromStages(nextStages);
            if (preferredStage) {
                queue.setCurrent(preferredStage.id);
            }

            activeRenderKeyRef.current = null;

            townLog('info', 'animation queue replaced for new scene', {
                sceneKey: nextSceneKey,
                currentStage: queue.current?.id,
            });
        } else {
            // 同一个主场景的新完整快照：只同步差异，不强制打断 current。
            // locked/playing 节点默认不被覆盖，保证当前动画连续。
            queue.sync(nextStages, { skipLocked: true, removeMissing: true });

            townLog('info', 'animation queue synced for same scene', {
                sceneKey: nextSceneKey,
                currentStage: queue.current?.id,
            });
        }

        queueReadySceneKeyRef.current = nextSceneKey;

        townLog('info', 'animation queue rebuilt', {
            sceneKey: nextSceneKey,
            stageCount: nextStages.length,
            firstStage: nextStages[0]?.id,
            currentStage: queue.current?.id,
            groupCount: command.routeGroups?.length ?? 0,
        });
        const queueSnapshot = queue.toDebugSnapshot();
        townLog('info', 'animation queue snapshot', {
            count: queueSnapshot.length,
            stages: queueSnapshot,
        });
        bumpAnimationQueue();
    }, [bumpAnimationQueue]);

    useEffect(() => {
        if (!hasTownCommands) return;
        syncAnimationQueueForCommand(townCommand);
    }, [hasTownCommands, syncAnimationQueueForCommand, townCommand]);

    const currentRenderableStage = useMemo(() => {
        // 地图加载范围不按整个主 command，而按当前可渲染组别/路径阶段的 renderProvinces。
        return getPreferredRenderableStage(animationQueueRef.current, townCommand);
    }, [animationQueueRevision, townCommand]);

    const activeTownRenderCommand = useMemo(() => {
        return buildTownStageRenderCommand(townCommand, currentRenderableStage);
    }, [currentRenderableStage, townCommand]);

    const syncTownMapWithStage = useCallback((stage: TownAnimationStage, reason: string) => {
        const renderProvinces = stage.payload.renderProvinces ?? [];
        const renderKey = getRenderKey(renderProvinces);
        const command = buildTownStageRenderCommand(townCommand, stage);

        townLog('info', 'current animation stage', {
            reason,
            stageId: stage.id,
            stageKind: stage.kind,
            groupId: stage.payload.routeGroupId,
            pathId: stage.payload.candidatePathId,
            edgeKey: stage.payload.edgeKey,
            renderProvinces,
            status: stage.playbackStatus,
        });

        if (activeRenderKeyRef.current === renderKey) {
            townLog('debug', 'map reload skipped: same render key', {
                reason,
                renderKey,
                stageId: stage.id,
                stageKind: stage.kind,
            });
            townRoadMapRef.current?.setRenderCommand?.(command);
            return;
        }

        activeRenderKeyRef.current = renderKey;
        townLog('info', 'map reload required', {
            reason,
            renderProvinces,
            renderKey,
            stageId: stage.id,
            stageKind: stage.kind,
        });
        townRoadMapRef.current?.setRenderCommand?.(command);
    }, [townCommand, townRoadMapRef]);

    const applyTownRoadEnvelope = useCallback((payload: TownRoadRenderIncoming, source = 'unknown') => {
        const packet = extractRenderPacket(payload);
        if (packet.commands.length === 0) {
            townLog('warn', 'apply envelope skipped: no commands', { source });
            return;
        }

        townLog('group', 'apply envelope', {
            source,
            commandCount: packet.commands.length,
            backendDiff: packet.diff,
        });

        const allIncomingOrders = packet.commands.flatMap((command) => command.orders ?? command.tasks ?? []);
        const orderDiff = mergeOrders(orderMapRef.current, allIncomingOrders);
        townLog('info', 'orders merged', {
            added: orderDiff.added.length,
            updated: orderDiff.updated.length,
            unchanged: orderDiff.unchanged.length,
            deleted: orderDiff.deleted.length,
        });

        const previousCommands = townCommandsRef.current;
        const previousActiveCommand = previousCommands[activeTownCommandIndexRef.current];
        const previousActiveKey = previousActiveCommand ? getTownCommandKey(previousActiveCommand) : null;
        const merged = mergeTownRenderCommandSnapshot(previousCommands, packet.commands, packet.diff);
        const primaryIndex = choosePrimaryCommandIndex(merged.commands, packet.primaryCommandId);
        const preservedIndex = previousActiveKey
            ? merged.commands.findIndex((command) => getTownCommandKey(command) === previousActiveKey)
            : -1;
        const shouldPreserveActiveScene = !packet.primaryCommandId && !source.startsWith('http:');
        const nextActiveIndex = packet.primaryCommandId
            ? primaryIndex
            : shouldPreserveActiveScene && preservedIndex >= 0
                ? preservedIndex
                : primaryIndex;
        const primaryScene = merged.commands[nextActiveIndex] ?? merged.commands[primaryIndex] ?? merged.commands[0];
        const primarySceneKey = primaryScene ? getTownCommandKey(primaryScene) : null;

        sceneMapRef.current.clear();
        merged.commands.forEach((command) => {
            sceneMapRef.current.set(getTownCommandKey(command), command);
        });
        activeSceneKeyRef.current = primarySceneKey;

        if (primaryScene) {
            townLog('info', 'primary scene selected', {
                sceneKey: primarySceneKey,
                title: primaryScene.title,
                sourceProvince: primaryScene.sourceProvince,
                routeGroups: primaryScene.routeGroups?.length ?? 0,
                orders: commandOrders(primaryScene).length,
            });
        }

        townCommandsRef.current = merged.commands;
        activeTownCommandIndexRef.current = nextActiveIndex;
        setTownCommands(merged.commands);
        setActiveTownCommandIndex(nextActiveIndex);
        setLastTownDiff(merged.diff);
        townLog('groupEnd');
    }, []);

    const handleTownRoadRenderCommand = useCallback((payload: TownRoadRenderIncoming) => {
        const now = performance.now();

        if (now < suppressTownWsUntilRef.current) {
            townLog('warn', 'town websocket payload ignored during http latest load', {
                now,
                suppressUntil: suppressTownWsUntilRef.current,
            });
            return;
        }

        applyTownRoadEnvelope(payload, 'websocket');
    }, [applyTownRoadEnvelope]);

    const loadTownRoadData = useCallback(async (reason = 'manual') => {
        if (loadingRef.current) {
            townLog('warn', 'skip load: already loading', { reason });
            return;
        }

        loadingRef.current = true;
        const startedAt = performance.now();
        suppressTownWsUntilRef.current = startedAt + 1500;
        const controller = new AbortController();

        townLog('info', 'load start', {
            reason,
            loadedOnce: loadedOnceRef.current,
            suppressWsUntil: suppressTownWsUntilRef.current,
        });

        try {
            const envelope = await fetchTownRoadRenderEnvelope(controller.signal);
            townLog('info', 'load success', {
                reason,
                rawCount: envelope.rawCount,
                normalizedCount: envelope.normalizedCount,
                shortHaulCount: envelope.shortHaulCount,
                commandCount: envelope.commandCount,
                diff: envelope.diff,
            });
            applyTownRoadEnvelope(envelope, `http:${reason}`);
            loadedOnceRef.current = true;
        } catch (error) {
            townLog('error', 'load failed', { reason, error });
        } finally {
            loadingRef.current = false;
            townLog('info', 'load end', {
                reason,
                costMs: Math.round(performance.now() - startedAt),
            });
        }
    }, [applyTownRoadEnvelope]);

    const animationQueueSnapshot = useMemo(() => {
        // 从 current 开始展开，更接近后面实际播放顺序。
        return animationQueueRef.current.toSnapshot(true);
    }, [animationQueueRevision]);

    const getTownAnimationStage = useCallback((id: string) => {
        return animationQueueRef.current.get(id);
    }, []);

    const hasTownAnimationStage = useCallback((id: string) => {
        return animationQueueRef.current.has(id);
    }, []);

    const findTownAnimationStage = useCallback((predicate: (stage: TownAnimationStage, index: number) => boolean) => {
        return animationQueueRef.current.find(predicate);
    }, []);

    const appendTownAnimationStage = useCallback((stage: TownAnimationStage) => {
        animationQueueRef.current.append(stage);
        bumpAnimationQueue();
    }, [bumpAnimationQueue]);

    const insertTownAnimationStageAfter = useCallback((anchorId: string, stage: TownAnimationStage) => {
        const inserted = animationQueueRef.current.insertAfter(anchorId, stage);
        if (inserted) bumpAnimationQueue();
        return inserted;
    }, [bumpAnimationQueue]);

    const updateTownAnimationStage = useCallback((id: string, patch: Partial<TownAnimationStage> | ((stage: TownAnimationStage) => TownAnimationStage | Partial<TownAnimationStage> | null | undefined)) => {
        const updated = animationQueueRef.current.update(id, patch, { skipLocked: true });
        if (updated) bumpAnimationQueue();
        return updated;
    }, [bumpAnimationQueue]);

    const removeTownAnimationStage = useCallback((id: string) => {
        const removed = animationQueueRef.current.remove(id);
        if (removed) bumpAnimationQueue();
        return removed;
    }, [bumpAnimationQueue]);

    const startCurrentTownAnimationStage = useCallback((reason = 'manual') => {
        const current = animationQueueRef.current.current;
        if (!current) {
            townLog('warn', 'start stage skipped: empty queue', { reason });
            return null;
        }

        const playing = animationQueueRef.current.update(
            current.id,
            (stage) => markStageStatus(stage, 'playing', true),
            { skipLocked: false }
        );
        if (playing) {
            currentStageStartedAtRef.current = performance.now();
            townLog('info', 'stage start', {
                reason,
                stageId: playing.id,
                stageKind: playing.kind,
                groupId: playing.payload.routeGroupId,
                pathId: playing.payload.candidatePathId,
                edgeKey: playing.payload.edgeKey,
                renderProvinces: playing.payload.renderProvinces,
            });
            if (playing.kind === 'order_batch_focus') {
                townLog('info', 'order batch stage placeholder', {
                    groupId: playing.payload.routeGroupId,
                    orderLineIds: playing.payload.orderLineIds,
                    renderProvinces: playing.payload.renderProvinces,
                });
            }
            syncTownMapWithStage(playing, `stage-start:${reason}`);
            townRoadMapRef.current?.startAnimationStage?.(playing);
            townRoadMapRef.current?.playAnimationStage?.(playing);
            bumpAnimationQueue();
        }
        return playing;
    }, [bumpAnimationQueue, syncTownMapWithStage, townRoadMapRef]);

    const moveNextTownAnimationStage = useCallback((reason = 'timer') => {
        const previous = animationQueueRef.current.current;
        if (previous) {
            animationQueueRef.current.update(
                previous.id,
                (stage) => markStageStatus(stage, 'played', false),
                { skipLocked: false }
            );
        }
        const next = animationQueueRef.current.moveNext();
        if (!next) {
            townLog('warn', 'move next skipped: no next stage', { reason });
            return null;
        }

        townLog('info', 'stage move next', {
            reason,
            from: previous?.id,
            to: next.id,
            nextKind: next.kind,
            nextGroupId: next.payload.routeGroupId,
            nextPathId: next.payload.candidatePathId,
            nextEdgeKey: next.payload.edgeKey,
        });

        const playing = startCurrentTownAnimationStage(`move-next:${reason}`);
        bumpAnimationQueue();
        return playing;
    }, [bumpAnimationQueue, startCurrentTownAnimationStage]);

    const stopTownAnimationLoop = useCallback((reason = 'manual') => {
        if (!animationRunningRef.current && animationTimerRef.current === null) {
            return;
        }

        animationRunningRef.current = false;

        if (animationTimerRef.current !== null) {
            window.clearTimeout(animationTimerRef.current);
            animationTimerRef.current = null;
        }

        townLog('info', 'animation loop stopped', { reason });
    }, []);

    const scheduleNextAnimationTick = useCallback(() => {
        if (!animationRunningRef.current) return;

        animationTimerRef.current = window.setTimeout(() => {
            moveNextTownAnimationStage('loop-tick');
            scheduleNextAnimationTick();
        }, DEFAULT_STAGE_DURATION_MS);
    }, [moveNextTownAnimationStage]);

    const startTownAnimationLoop = useCallback((reason = 'manual') => {
        if (animationRunningRef.current) {
            townLog('debug', 'animation loop already running', { reason });
            return;
        }

        if (animationQueueRef.current.size === 0) {
            townLog('warn', 'animation loop start skipped: empty queue', { reason });
            return;
        }

        animationRunningRef.current = true;
        townLog('info', 'animation loop started', {
            reason,
            queueSize: animationQueueRef.current.size,
            currentStage: animationQueueRef.current.current?.id,
        });

        startCurrentTownAnimationStage(`loop-start:${reason}`);
        scheduleNextAnimationTick();
    }, [scheduleNextAnimationTick, startCurrentTownAnimationStage]);

    useEffect(() => {
        if (view !== 'townRoadMap') {
            stopTownAnimationLoop('leave-townRoadMap');
            return;
        }

        if (!hasTownCommands || animationQueueRef.current.size === 0) return;
        if (!queueReadySceneKeyRef.current) return;
        startTownAnimationLoop('queue-ready');
    }, [hasTownCommands, startTownAnimationLoop, stopTownAnimationLoop, view]);

    useEffect(() => {
        return () => {
            stopTownAnimationLoop('controller-unmount');
        };
    }, [stopTownAnimationLoop]);

    const townTasks = useMemo<TownTransportTask[]>(() => commandOrders(activeTownRenderCommand), [activeTownRenderCommand]);

    const townRouteGroups = useMemo<TownRouteGroup[]>(() => activeTownRenderCommand.routeGroups ?? [], [activeTownRenderCommand]);

    const townProvinceEdges = useMemo<TownProvinceEdge[]>(() => activeTownRenderCommand.provinceEdges ?? [], [activeTownRenderCommand]);

    const townSummary = useMemo(() => {
        const activeTasks = townTasks.filter((task) => !task.deleted && task.status !== '已取消');
        const destinationNames = new Set(activeTasks.map((task) => task.to.name));
        const sourceNames = new Set(activeTasks.map((task) => task.from.name));
        const transporting = activeTasks.filter((task) => task.status.includes('运输')).length;
        const loading = activeTasks.filter((task) => task.status.includes('装载')).length;
        const finished = activeTasks.filter((task) => task.status.includes('完成')).length;
        const provinces = commandRenderProvinces(activeTownRenderCommand);
        const sourceProvinceName = townCommand.sourceProvince?.provinceName;

        return {
            title: activeTownRenderCommand.title ?? activeTasks[0]?.groupName ?? '区镇短途配送',
            description: activeTownRenderCommand.description ?? townCommand.description ?? '后端命令指定省份和订单批次',
            sourceProvinceName,
            commandCount: townCommands.length,
            activeCommandIndex: activeTownCommandIndex,
            renderCount: provinces.length,
            renderProvinces: provinces,
            renderLevel: activeTownRenderCommand.renderLevel ?? 'province-district',
            taskCount: activeTasks.length,
            routeGroupCount: townRouteGroups.length,
            provinceEdgeCount: townProvinceEdges.length,
            animationQueueSize: animationQueueSnapshot.size,
            currentAnimationStageId: animationQueueSnapshot.currentId,
            currentRenderableStageId: currentRenderableStage?.id ?? null,
            currentRenderableStageKind: currentRenderableStage?.kind ?? null,
            sourceCount: sourceNames.size,
            destinationCount: destinationNames.size,
            transporting,
            loading,
            finished,
            lastDiff: lastTownDiff,
        };
    }, [activeTownCommandIndex, activeTownRenderCommand, animationQueueSnapshot.currentId, animationQueueSnapshot.size, currentRenderableStage, lastTownDiff, townCommand.description, townCommand.sourceProvince?.provinceName, townCommands.length, townProvinceEdges.length, townRouteGroups.length, townTasks]);

    const reloadMockTownCommand = useCallback(() => {
        const command = normalizeCommand({
            ...mockTownProvinceRenderCommand,
            commandId: `mock-province-orders-${Date.now()}`,
            issuedAt: new Date().toISOString(),
        });
        townCommandsRef.current = [command];
        activeTownCommandIndexRef.current = 0;
        sceneMapRef.current.clear();
        sceneMapRef.current.set(getTownCommandKey(command), command);
        orderMapRef.current.clear();
        commandOrders(command).forEach((order) => {
            if (order.lineId && !isDeletedTownOrder(order)) orderMapRef.current.set(order.lineId, order);
        });
        activeSceneKeyRef.current = getTownCommandKey(command);
        activeRenderKeyRef.current = null;
        setTownCommands([command]);
        setActiveTownCommandIndex(0);
        setLastTownDiff(null);
    }, []);

    const showTownCommandAt = useCallback((index: number) => {
        setActiveTownCommandIndex((previous) => {
            if (townCommands.length === 0) return 0;
            if (!Number.isFinite(index)) return previous;
            const next = Math.min(Math.max(Math.trunc(index), 0), townCommands.length - 1);
            activeTownCommandIndexRef.current = next;
            return next;
        });
    }, [townCommands.length]);

    const showNextTownCommand = useCallback(() => {
        setActiveTownCommandIndex((previous) => {
            if (townCommands.length <= 1) return 0;
            const next = (previous + 1) % townCommands.length;
            activeTownCommandIndexRef.current = next;
            return next;
        });
    }, [townCommands.length]);

    return {
        townCommand,
        activeTownRenderCommand,
        currentRenderableStage,
        townCommands,
        activeTownCommandIndex,
        townTasks,
        townRouteGroups,
        townProvinceEdges,
        townSummary,
        lastTownDiff,
        animationQueueSnapshot,
        loadTownRoadData,
        applyTownRoadEnvelope,
        handleTownRoadRenderCommand,
        reloadMockTownCommand,
        showTownCommandAt,
        showNextTownCommand,
        getTownAnimationStage,
        hasTownAnimationStage,
        findTownAnimationStage,
        appendTownAnimationStage,
        insertTownAnimationStageAfter,
        updateTownAnimationStage,
        removeTownAnimationStage,
        startCurrentTownAnimationStage,
        moveNextTownAnimationStage,
        startTownAnimationLoop,
        stopTownAnimationLoop,
    };
}
