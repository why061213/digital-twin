import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ViewMode } from '../types';
import type { TruckPositionMessage } from './useDashboardRealtime';
import { fetchTownRoadRenderEnvelope } from '../services/townRoadApi';
import { fetchTruckPositions } from '../services/roadApi';
import { POSITION_QUERY_INTERVAL_MS, POSITION_RENDER_TICK_MS, POSITION_BATCH_POLL_MS, POSITION_BATCH_MIN_INTERVAL_MS } from '../constants';
import { townLog } from '../townRoadLogger';
import {
    buildTownAnimationStages,
    buildTownStageRenderCommand,
    CircularAnimationQueue,
    getTownRouteGroupDebugSnapshot,
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

const DEFAULT_STAGE_DURATION_MS = 12000;

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
    const status = (order.status ?? '').trim();
    return Boolean(order.deleted) || status === '已取消';
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
        displayRouteGroups: command.displayRouteGroups ?? [],
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

function buildAnimationStageRenderCommand(command: TownRoadRenderCommand, stage: TownAnimationStage | null | undefined) {
    return {
        ...buildTownStageRenderCommand(command, stage),
        renderLevel: 'province-city' as const,
    };
}

function countTownStagesByKind(stages: TownAnimationStage[]) {
    return stages.reduce<Record<string, number>>((acc, stage) => {
        acc[stage.kind] = (acc[stage.kind] ?? 0) + 1;
        return acc;
    }, {});
}

function summarizeTownStageForGroupDebug(stage: TownAnimationStage) {
    return {
        id: stage.id,
        kind: stage.kind,
        label: stage.label,
        routeGroupId: stage.payload.routeGroupId,
        candidatePathId: stage.payload.candidatePathId,
        edgeKey: stage.payload.edgeKey,
        edgeKeys: stage.payload.edgeKeys,
        provincePath: stage.payload.provincePath,
        renderProvinces: stage.payload.renderProvinces,
        orderLineIds: stage.payload.orderLineIds,
    };
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
    const townPositionRequestsRef = useRef<Set<string>>(new Set());
    const townNextPositionQueryAtRef = useRef<Map<string, number>>(new Map());
    /** 按 lineId 追踪最近已知位置和路径签名，防止进度倒退 */
    const latestProgressByLineId = useRef<Map<string, { coords: [number, number]; updatedAt: string; pathKey?: string }>>(new Map());
    const animationQueueRef = useRef(new CircularAnimationQueue<TownAnimationStage>());
    const animationTimerRef = useRef<number | null>(null);
    const animationRunningRef = useRef(false);
    const currentStageStartedAtRef = useRef<number | null>(null);
    const lastQueueSceneKeyRef = useRef<string | null>(null);
    const queueReadySceneKeyRef = useRef<string | null>(null);
    const townCommandsRef = useRef(townCommands);
    const activeTownCommandIndexRef = useRef(activeTownCommandIndex);
    const [animationQueueRevision, setAnimationQueueRevision] = useState(0);
    const [townDisplayMode, setTownDisplayMode] = useState<'single_source' | 'multi_source_rotation' | null>(null);
    /** 当前 command 已经完整播放的轮次计数，scene_boot 每被 start 一次 +1 */
    const townRoundCountRef = useRef(0);

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

        townLog('info', 'route group diagnostics', {
            sceneKey: nextSceneKey,
            ...getTownRouteGroupDebugSnapshot(command),
        });
        townLog('info', 'animation stage diagnostics', {
            sceneKey: nextSceneKey,
            stageCount: nextStages.length,
            stageCountByKind: countTownStagesByKind(nextStages),
            routeGroupStages: nextStages
                .filter((stage) => stage.kind === 'route_group_focus')
                .map(summarizeTownStageForGroupDebug),
            candidatePathStages: nextStages
                .filter((stage) => stage.kind === 'candidate_path_focus')
                .map(summarizeTownStageForGroupDebug),
            provinceEdgeStages: nextStages
                .filter((stage) => stage.kind === 'province_edge_highlight')
                .map(summarizeTownStageForGroupDebug),
        });

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
        return buildAnimationStageRenderCommand(townCommand, currentRenderableStage);
    }, [currentRenderableStage, townCommand]);

    /** 将 orderMapRef 中最新的车辆坐标/进度回写到 command，确保 stage 切换不丢失位置。 */
    const injectLatestOrderPositions = useCallback((command: TownRoadRenderCommand): TownRoadRenderCommand => {
        const orderMap = orderMapRef.current;
        if (orderMap.size === 0) return command;

        const sourceOrders = commandOrders(command);
        if (sourceOrders.length === 0) return command;

        let patchedCount = 0;
        const patchedOrders = sourceOrders.map((order) => {
            const latest = orderMap.get(order.lineId);
            if (!latest || !latest.vehicle?.currentCoords) return order;

            const oldCoords = order.vehicle?.currentCoords;
            const newCoords = latest.vehicle.currentCoords;
            const oldSpeed = order.vehicle?.speedKmh;
            const newSpeed = latest.vehicle.speedKmh;

            // 进度单调性：更新时间更旧的数据不注入
            const prevProgress = latestProgressByLineId.current.get(order.lineId);
            const latestTime = latest.updatedAt ? new Date(latest.updatedAt).getTime() : 0;
            const prevTime = prevProgress?.updatedAt ? new Date(prevProgress.updatedAt).getTime() : 0;

            if (prevProgress && latestTime <= prevTime) {
                return order;
            }

            // 更新追踪
            latestProgressByLineId.current.set(order.lineId, {
                coords: newCoords,
                updatedAt: latest.updatedAt ?? new Date().toISOString(),
            });

            const hasChanged = (
                (oldCoords?.[0] !== newCoords?.[0] || oldCoords?.[1] !== newCoords?.[1]) ||
                (oldSpeed !== newSpeed) ||
                (order.updatedAt !== latest.updatedAt)
            );

            if (!hasChanged) return order;

            patchedCount += 1;
            townLog('debug', 'inject latest order position', {
                lineId: order.lineId,
                oldCoords,
                newCoords,
                oldSpeed,
                newSpeed,
                oldUpdatedAt: order.updatedAt,
                newUpdatedAt: latest.updatedAt,
                progress: latest.vehicle.currentCoords ? 'has-position' : 'no-position',
            });

            return {
                ...order,
                updatedAt: latest.updatedAt ?? order.updatedAt,
                vehicle: {
                    ...order.vehicle,
                    ...latest.vehicle,
                    currentCoords: latest.vehicle.currentCoords,
                    speedKmh: latest.vehicle.speedKmh,
                },
            };
        });

        if (patchedCount > 0) {
            townLog('info', 'injected latest positions into stage command', {
                stageId: 'pre-sync',
                patchedCount,
                totalOrders: sourceOrders.length,
            });
        }

        return {
            ...command,
            orders: patchedOrders,
            tasks: patchedOrders,
        };
    }, []);

    const syncTownMapWithStage = useCallback((stage: TownAnimationStage, reason: string) => {
        const renderProvinces = stage.payload.renderProvinces ?? [];
        const renderKey = getRenderKey(renderProvinces);

        // 注入 orderMapRef 中最新的车辆位置，避免 stage 切换后车辆回到起点
        const patchedCommand = injectLatestOrderPositions(townCommand);
        const command = buildAnimationStageRenderCommand(patchedCommand, stage);
        const commandRenderProvinces = command.renderProvinces ?? [];
        const commandRenderKey = `${command.renderLevel}:${commandRenderProvinces.slice().sort().join('|')}`;

        // 阶段诊断日志
        const stageOrders = command.orders ?? command.tasks ?? [];
        const routeGroups = command.routeGroups ?? [];
        const requestedLineIds = stage.payload.orderLineIds ?? [];
        const stageLineIdSet = new Set(requestedLineIds);
        const primaryCount = routeGroups.reduce((sum, g) => sum + (g.primaryOrderLineIds?.length ?? 0), 0);
        const alongCount = routeGroups.reduce((sum, g) => sum + (g.alongOrderLineIds?.length ?? 0), 0);
        const matchedLineIds = stageOrders.filter((o) => stageLineIdSet.has(o.lineId)).map((o) => o.lineId);
        const missingLineIds = requestedLineIds.filter((id) => !stageOrders.some((o) => o.lineId === id));
        const vehicleCount = stageOrders.filter((o) => o.vehicle?.currentCoords).length;

        townLog('info', 'current animation stage', {
            reason,
            stageId: stage.id,
            stageKind: stage.kind,
            groupId: stage.payload.routeGroupId,
            pathId: stage.payload.candidatePathId,
            edgeKey: stage.payload.edgeKey,
            renderProvinces,
            status: stage.playbackStatus,
            commandRenderKey,
            primaryCount,
            alongCount,
            requestedLineIdsCount: requestedLineIds.length,
            matchedLineIdsCount: matchedLineIds.length,
            missingLineIdsCount: missingLineIds.length,
            routeCount: routeGroups.length,
            vehicleCount,
            orderCount: stageOrders.length,
        });

        townLog('info', 'stage render command built', {
            stageId: stage.id,
            stageKind: stage.kind,
            renderLevel: command.renderLevel,
            renderProvinces: commandRenderProvinces,
            renderKey: commandRenderKey,
            orderCount: stageOrders.length,
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
    }, [townCommand, townRoadMapRef, injectLatestOrderPositions]);

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

        // 从 envelope 读取后端指定的展示模式
        const envelopeDisplayMode = isEnvelope(payload) ? payload.displayMode : undefined;
        if (envelopeDisplayMode) {
            setTownDisplayMode(envelopeDisplayMode);
            townLog('info', 'display mode updated', { displayMode: envelopeDisplayMode });
        }

        townLog('groupEnd');
    }, []);

    const handleTownTruckPosition = useCallback((message: TruckPositionMessage, forceCalibration = false) => {
        if (!message?.lineId || !Array.isArray(message.position) || message.position.length < 2) return;
        const existing = orderMapRef.current.get(message.lineId);
        if (!existing || existing.deleted) return;
        const status = (existing.status ?? '').trim();
        if (status === '已取消' || status === '已完成') return;

        const updatedAt = new Date().toISOString();
        const nextOrder: TownTransportOrder = {
            ...existing,
            status: message.status === 'finished' ? '已完成' : existing.status,
            updatedAt,
            vehicle: {
                ...existing.vehicle,
                currentCoords: message.position,
                speedKmh: message.speedKmh,
            },
        };
        orderMapRef.current.set(message.lineId, nextOrder);
        townRoadMapRef.current?.updateTruckPosition?.(message.lineId, message.position, {
            speedKmh: message.speedKmh,
            status: nextOrder.status,
            updatedAt,
        });
        townNextPositionQueryAtRef.current.set(message.lineId, performance.now() + POSITION_QUERY_INTERVAL_MS);

        if (forceCalibration) {
            townLog('debug', 'town truck position calibrated', {
                lineId: message.lineId,
                speedKmh: message.speedKmh,
                progress: message.progress,
            });
        }
    }, [townRoadMapRef]);
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

    useEffect(() => {
        if (view !== 'townRoadMap') return;

        let batchController: AbortController | null = null;
        let batchTimer: ReturnType<typeof setInterval> | null = null;
        let batchSeq = 0;
        let lastBatchAt = 0;

        const pollBatchPositions = () => {
            // hidden → 不轮询，abort 并停止
            if (document.visibilityState === 'hidden') {
                if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
                if (batchController) { batchController.abort(); batchController = null; }
                return;
            }

            // 距上次请求太近 → 跳过
            if (performance.now() - lastBatchAt < POSITION_BATCH_MIN_INTERVAL_MS) return;

            // single-flight
            if (batchController) return;

            const currentStage = animationQueueRef.current.current;
            const stageLineIds = currentStage?.payload?.orderLineIds ?? [];
            if (stageLineIds.length === 0) return;

            const activeLineIds = stageLineIds.filter((lineId) => {
                const order = orderMapRef.current.get(lineId);
                if (!order || order.deleted) return false;
                const status = (order.status ?? '').trim();
                return status === '运输中' || status.includes('运输');
            });
            if (activeLineIds.length === 0) return;

            const controller = new AbortController();
            batchController = controller;
            const seq = ++batchSeq;
            const stageId = currentStage?.id ?? '';
            lastBatchAt = performance.now();
            const startedAt = lastBatchAt;

            void fetchTruckPositions(activeLineIds, { signal: controller.signal })
                .then((response) => {
                    if (controller.signal.aborted) return;
                    if (batchController !== controller) return;
                    if (seq !== batchSeq) return;

                    const currentStageNow = animationQueueRef.current.current;
                    if (currentStageNow?.id !== stageId) {
                        townLog('debug', 'batch position response discarded: stage changed', {
                            requestStageId: stageId, currentStageId: currentStageNow?.id,
                        });
                        return;
                    }

                    const costMs = Math.round(performance.now() - startedAt);
                    townLog('info', 'batch position poll', {
                        view: 'townRoadMap', stageId,
                        requestedLineCount: activeLineIds.length,
                        returnedCount: response.positions.length,
                        missingCount: response.missingLineIds.length,
                        staleCount: response.staleLineIds.length,
                        costMs, aborted: false,
                    });

                    const stageLineIdSet = new Set(stageLineIds);
                    response.positions.forEach((item) => {
                        if (!stageLineIdSet.has(item.lineId)) return;
                        if (item.position && item.position.length >= 2) {
                            handleTownTruckPosition({
                                lineId: item.lineId, position: item.position,
                                speedKmh: item.speedKmh, status: item.status ?? '运输中',
                            } as TruckPositionMessage, true);
                        }
                    });
                })
                .catch((error) => {
                    if (error instanceof DOMException && error.name === 'AbortError') return;
                    townLog('warn', 'batch position poll failed', { error });
                })
                .finally(() => {
                    if (batchController === controller) batchController = null;
                });
        };

        pollBatchPositions();
        batchTimer = setInterval(pollBatchPositions, POSITION_BATCH_POLL_MS);

        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                if (batchTimer) clearInterval(batchTimer);
                batchTimer = setInterval(pollBatchPositions, POSITION_BATCH_POLL_MS);
                pollBatchPositions();
            } else {
                if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
                if (batchController) { batchController.abort(); batchController = null; }
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (batchTimer) clearInterval(batchTimer);
            if (batchController) { batchController.abort(); batchController = null; }
        };
    }, [handleTownTruckPosition, view]);
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

            // 追踪 command 轮次：scene_boot 每被 start 一次意味着动画链表的起点又被播放了一次
            if (playing.kind === 'scene_boot') {
                townRoundCountRef.current += 1;
                townLog('info', 'scene_boot boundary reached (no map sync)', {
                    reason,
                    round: townRoundCountRef.current,
                    stageId: playing.id,
                });
                // scene_boot 是循环边界节点，不触发地图/路线渲染
                // 只标记 played 状态并 bump revision 让 UI 感知
                bumpAnimationQueue();
                return playing;
            }

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
            const next = moveNextTownAnimationStage('loop-tick');

            if (next && next.kind === 'scene_boot') {
                // 多始发省自动轮播：当动画链表播完一轮回到 scene_boot 时切换 command
                if (
                    townRoundCountRef.current > 1 &&
                    townDisplayMode === 'multi_source_rotation' &&
                    townCommandsRef.current.length > 1
                ) {
                    townLog('info', 'command rotation triggered at scene_boot', {
                        round: townRoundCountRef.current,
                        activeIndex: activeTownCommandIndexRef.current,
                        totalCommands: townCommandsRef.current.length,
                    });
                    stopTownAnimationLoop('command-rotation');
                    // 重置轮次计数，新 command 从第 0 轮开始
                    townRoundCountRef.current = 0;
                    // 切换到下一个始发省 command
                    setActiveTownCommandIndex((previous) => {
                        const total = townCommandsRef.current.length;
                        if (total <= 1) return 0;
                        const nextIdx = (previous + 1) % total;
                        activeTownCommandIndexRef.current = nextIdx;
                        return nextIdx;
                    });
                    return;
                }

                // 不切换 command：立即跳过 scene_boot 进入下一阶段，避免 12s 空白等待
                townLog('info', 'skipping scene_boot to next real stage', {
                    round: townRoundCountRef.current,
                });
                moveNextTownAnimationStage('skip-boot');
            }

            scheduleNextAnimationTick();
        }, DEFAULT_STAGE_DURATION_MS);
    }, [moveNextTownAnimationStage, townDisplayMode, stopTownAnimationLoop]);

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

        // 如果当前是 scene_boot（队列的第一个节点），立即跳到第一个真正的渲染阶段
        if (animationQueueRef.current.current?.kind === 'scene_boot') {
            townLog('info', 'skipping initial scene_boot on loop start');
            moveNextTownAnimationStage('skip-initial-boot');
        }

        scheduleNextAnimationTick();
    }, [scheduleNextAnimationTick, startCurrentTownAnimationStage, moveNextTownAnimationStage]);

    useEffect(() => {
        if (view !== 'townRoadMap') {
            stopTownAnimationLoop('leave-townRoadMap');
            return;
        }

        if (!hasTownCommands || animationQueueRef.current.size === 0) return;
        if (!queueReadySceneKeyRef.current) return;
        startTownAnimationLoop('queue-ready');
    }, [hasTownCommands, startTownAnimationLoop, stopTownAnimationLoop, view, animationQueueRevision]);

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

    useEffect(() => {
        if (view !== 'townRoadMap') return;

        console.info('[TownRoadPanel] build panel', {
            stageId: currentRenderableStage?.id,
            stageKind: currentRenderableStage?.kind,
            groupId: currentRenderableStage?.payload.routeGroupId,
            pathId: currentRenderableStage?.payload.candidatePathId,
            edgeKey: currentRenderableStage?.payload.edgeKey,
            title: townSummary.title,
            orderLineIds: townTasks.map((task) => task.lineId),
        });
    }, [currentRenderableStage, townSummary.title, townTasks, view]);

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
        handleTownTruckPosition,
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
