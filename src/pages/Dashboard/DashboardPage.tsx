import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MainLayout from '@/components/Layout/MainLayout';
import Header from '@/components/Layout/Header';
import type { ChinaMap3DHandle } from './modules/ChinaMap3D';
import type { RoadMap3DHandle } from './modules/RoadMap3D';
import type { TownRoadMap3DHandle } from './modules/TownRoadMap3D';
import DashboardSidePanels from './modules/DashboardSidePanels';
import type { RoadGroupPanelState } from './modules/DashboardSidePanels';
import { useDashboardRealtime } from './hooks/useDashboardRealtime';
import { useDashboardViewTransition } from './hooks/useDashboardViewTransition';
import { useRoadGroupsController } from './hooks/useRoadGroupsController';
import { useTruckPositionController } from './hooks/useTruckPositionController';
import { useWarehouseController } from './hooks/useWarehouseController';
import { useTownRoadController } from './hooks/useTownRoadController';
import type { RouteOrder } from './hooks/useDashboardRealtime';
import { DispatchButtons } from './components/DispatchButtons';
import { DashboardCenterPanel } from './components/DashboardCenterPanel';
import { RoadGroupQueue } from './components/RoadGroupQueue';
import { RoadGroupTabs } from './components/RoadGroupTabs';
import { ViewButtons } from './components/ViewButtons';
import {
    dispatchBulkRoutes,
    dispatchRoute,
} from './services/roadApi';
import { townLog } from './townRoadLogger';
import type { ViewMode } from './types';

function DashboardPage() {
    const [isDispatching, setIsDispatching] = useState(false);
    const mapRef = useRef<ChinaMap3DHandle>(null);
    const roadMapRef = useRef<RoadMap3DHandle>(null);
    const townRoadMapRef = useRef<TownRoadMap3DHandle>(null);
    const {
        warehouseFocus,
        clearWarehouseFocus,
        handleCityRaise,
        handleCityFall,
        handleWarehouseUpdate,
        handleWarehouseTourStateChange,
        handleCameraControl,
        handleWarehouseFocus,
        requestWarehouseSnapshot,
    } = useWarehouseController({
        mapRef,
    });
    const handleViewCommitted = useCallback((committedView: ViewMode) => {
        if (committedView !== 'chinaMap') {
            clearWarehouseFocus();
        }
    }, [clearWarehouseFocus]);

    const {
        view,
        requestViewChange,
        chinaMapSession,
        isPreparingChinaMap,
        isRevealingChinaMap,
        roadMapSession,
        isPreparingRoadMap,
        isRevealingRoadMap,
        isRoadMapVisualReady,
        chinaMapPrepareRunRef,
        roadMapPrepareRunRef,
        skipNextRoadMapRefreshRef,
        handleChinaMapVisualReady,
        handleRoadMapVisualReady,
        markChinaMapDataReady,
        markRoadMapDataReady,
        failChinaMapPrepare,
        failRoadMapPrepare,
    } = useDashboardViewTransition({
        onViewCommitted: handleViewCommitted,
    });
    const wsLastPositionAtRef = useRef<number | null>(null);

    const {
        routeOrders,
        setRouteOrders,
        activeRoutesRef,
        routeOrdersRef,
        completedRouteIdsRef,
        createActiveRoute,
        showRoutes,
        prefetchRoutePositions,
        finishRoute,
        handleTruckPosition,
        syncRoadRoute,
        renderTruckPosition,
    } = useTruckPositionController({
        roadMapRef,
        view,
        activeRoadGroupId,
        activeRoadGroupLineIds: useMemo(() => [...activeRoutesRef.current.keys()], [activeRoutesRef]),
        wsLastPositionAt: wsLastPositionAtRef.current,
    });
    const {
        roadGroups,
        activeRoadGroupId,
        activeRoadGroupIdRef,
        roadGroupStrategy,
        isLoadingRoadGroup,
        isRoadGroupFading,
        loadRoadGroup,
        refreshRoadGroups,
        handleRoadPath,
        resetRoadGroupStrategy,
    } = useRoadGroupsController({
        roadMapRef,
        view,
        activeRoutesRef,
        routeOrdersRef,
        completedRouteIdsRef,
        skipNextRoadMapRefreshRef,
        createActiveRoute,
        showRoutes,
        prefetchRoutePositions,
        syncRoadRoute,
        renderTruckPosition,
        setRouteOrders,
    });
    const {
        townTasks,
        townSummary,
        loadTownRoadData,
        stopTownAnimationLoop,
        handleTownRoadRenderCommand,
    handleTownTruckPosition,
    } = useTownRoadController({
        view,
        townRoadMapRef,
    });


    const handleTownRoadRender = useCallback((command: Parameters<typeof handleTownRoadRenderCommand>[0]) => {
        handleTownRoadRenderCommand(command);
        requestViewChange('townRoadMap');
    }, [handleTownRoadRenderCommand, requestViewChange]);

    const handleRealtimeTruckPosition = useCallback((message: Parameters<typeof handleTruckPosition>[0]) => {
        wsLastPositionAtRef.current = performance.now();
        handleTruckPosition(message);
        handleTownTruckPosition(message);
    }, [handleTownTruckPosition, handleTruckPosition]);
    const handleTownRoadMapVisualReady = useCallback(() => undefined, []);

    const handleRouteRaise = useCallback((_order: RouteOrder) => {
        // 城市飞线事件由 ChinaMap3D 处理；道路级地图只加载后端分组后的路线。
    }, []);

    const requestDispatch = useCallback(async () => {
        if (isDispatching) return;
        setIsDispatching(true);
        requestViewChange('roadMap');
        try {
            const route = await dispatchRoute();
            await refreshRoadGroups(activeRoadGroupIdRef.current ?? route.groupId);
        } catch (error) {
            console.warn('Route dispatch failed', error);
        } finally {
            setIsDispatching(false);
        }
    }, [isDispatching, refreshRoadGroups, requestViewChange]);

    const requestBulkDispatch = useCallback(async () => {
        if (isDispatching) return;
        setIsDispatching(true);
        try {
            await dispatchBulkRoutes(24);
            // 大宗订单只是向后端追加一批路线；只有当前已经在道路地图时才刷新显示，不主动切换视图。
            if (view === 'roadMap') {
            }
        } catch (error) {
            console.warn('Bulk route dispatch failed', error);
        } finally {
            setIsDispatching(false);
        }
    }, [isDispatching]);


    const requestRoadMapSnapshot = useCallback(async (prepareRunId: number) => {
        try {
            await refreshRoadGroups(activeRoadGroupIdRef.current ?? undefined);
            if (roadMapPrepareRunRef.current !== prepareRunId) return;
            markRoadMapDataReady();
        } catch (error) {
            console.warn('Road map prepare failed', error);
            if (roadMapPrepareRunRef.current === prepareRunId) {
                failRoadMapPrepare();
            }
        }
    }, [failRoadMapPrepare, markRoadMapDataReady, refreshRoadGroups]);

    useDashboardRealtime({
        onCityRaise: handleCityRaise,
        onCityFall: handleCityFall,
        onRouteRaise: handleRouteRaise,
        onRouteFall: finishRoute,
        onRoadPath: handleRoadPath,
        onTruckPosition: handleRealtimeTruckPosition,
        onWarehouseUpdate: handleWarehouseUpdate,
        onWarehouseFocus: handleWarehouseFocus,
        onCameraControl: handleCameraControl,
        onTownRoadRender: handleTownRoadRender,
    });

    useEffect(() => {
        if (!isPreparingChinaMap) return;
        if (chinaMapSession <= 0) return;

        const prepareRunId = chinaMapPrepareRunRef.current;
        void requestWarehouseSnapshot({
            isCurrentPrepareRun: () => chinaMapPrepareRunRef.current === prepareRunId,
            onDataReady: markChinaMapDataReady,
            onPrepareFailed: failChinaMapPrepare,
        });
    }, [
        chinaMapPrepareRunRef,
        chinaMapSession,
        failChinaMapPrepare,
        isPreparingChinaMap,
        markChinaMapDataReady,
        requestWarehouseSnapshot,
    ]);

    useEffect(() => {
        if (!isPreparingRoadMap || !isRoadMapVisualReady || roadMapSession <= 0) return;
        void requestRoadMapSnapshot(roadMapPrepareRunRef.current);
    }, [isPreparingRoadMap, isRoadMapVisualReady, requestRoadMapSnapshot, roadMapSession]);

    useEffect(() => {
        if (view !== 'townRoadMap') {
            stopTownAnimationLoop('leave-townRoadMap');
            return;
        }
        townLog('info', 'view enter townRoadMap');
        void loadTownRoadData('view-enter-townRoadMap');
    }, [loadTownRoadData, stopTownAnimationLoop, view]);

    const renderCenterPanel = () => (
        <DashboardCenterPanel
            view={view}
            isPreparingChinaMap={isPreparingChinaMap}
            isRevealingChinaMap={isRevealingChinaMap}
            isPreparingRoadMap={isPreparingRoadMap}
            isRevealingRoadMap={isRevealingRoadMap}
            isRoadGroupFading={isRoadGroupFading}
            chinaMapSession={chinaMapSession}
            roadMapSession={roadMapSession}
            mapRef={mapRef}
            roadMapRef={roadMapRef}
            townRoadMapRef={townRoadMapRef}
            onChinaMapVisualReady={handleChinaMapVisualReady}
            onRoadMapVisualReady={handleRoadMapVisualReady}
            onTownRoadMapVisualReady={handleTownRoadMapVisualReady}
            onWarehouseTourStateChange={handleWarehouseTourStateChange}
        />
    );

    const viewButtons = (
        <ViewButtons
            view={view}
            isPreparingChinaMap={isPreparingChinaMap}
            isRevealingChinaMap={isRevealingChinaMap}
            isPreparingRoadMap={isPreparingRoadMap}
            isRevealingRoadMap={isRevealingRoadMap}
            onRequestViewChange={requestViewChange}
        />
    );

    const roadGroupQueue = view === 'roadMap' && roadGroups.length > 0 && (
        <RoadGroupQueue
            groups={roadGroups}
            activeGroupId={activeRoadGroupId}
            isLoading={isLoadingRoadGroup}
            onSelectGroup={(groupId) => void loadRoadGroup(groupId)}
        />
    );

    const dispatchControls = view === 'roadMap' && (
        <DispatchButtons
            isDispatching={isDispatching}
            onDispatch={requestDispatch}
            onBulkDispatch={requestBulkDispatch}
        />
    );
    const townRoadSummary = view === 'townRoadMap' && (
        <div className="pointer-events-auto absolute right-5 top-24 z-50 w-[310px] rounded-lg border border-cyan-300/20 bg-slate-950/72 px-4 py-3 text-xs text-slate-300 shadow-2xl shadow-cyan-950/25 backdrop-blur-md">
            <div className="mb-2 flex items-start justify-between gap-3 border-b border-white/10 pb-2">
                <div>
                    <div className="text-sm font-semibold text-cyan-100">{townSummary.title}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{townSummary.description}</div>
                </div>
                <span className="rounded border border-cyan-300/20 bg-cyan-400/10 px-2 py-0.5 text-[10px] text-cyan-200">{townSummary.renderCount} 块 / {townSummary.taskCount} 线</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded border border-white/5 bg-white/[0.035] px-2 py-2">
                    <div className="text-cyan-100">{townSummary.sourceCount}</div>
                    <div className="mt-0.5 text-[10px] text-slate-500">起点</div>
                </div>
                <div className="rounded border border-white/5 bg-white/[0.035] px-2 py-2">
                    <div className="text-amber-100">{townSummary.destinationCount}</div>
                    <div className="mt-0.5 text-[10px] text-slate-500">目的地</div>
                </div>
                <div className="rounded border border-white/5 bg-white/[0.035] px-2 py-2">
                    <div className="text-emerald-100">{townSummary.transporting}</div>
                    <div className="mt-0.5 text-[10px] text-slate-500">运输中</div>
                </div>
            </div>
            <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1 no-scrollbar">
                {townTasks.map((task) => (
                    <div key={task.lineId} className="rounded border border-white/5 bg-white/[0.03] px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-cyan-100">{task.vehicle.plate}</span>
                            <span className="shrink-0 text-[10px] text-slate-400">{task.status}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-slate-500">{task.from.name} → {task.to.name}</div>
                    </div>
                ))}
            </div>
        </div>
    );

    const roadStrategyTabs = view === 'roadMap' && (
        <RoadGroupTabs
            activeStrategy={roadGroupStrategy}
            onStrategyChange={resetRoadGroupStrategy}
        />
    );

    const activeRoadGroup = activeRoadGroupId
        ? roadGroups.find((group) => group.groupId === activeRoadGroupId) ?? null
        : null;
    const shouldShowRoadPanel = view === 'roadMap' && Boolean(activeRoadGroup);
    const sidePanelMode: 'hidden' | 'warehouse_focus' | 'road_group_focus' =
        view === 'chinaMap' && warehouseFocus
            ? 'warehouse_focus'
            : shouldShowRoadPanel
                ? 'road_group_focus'
                : 'hidden';
    const roadPanelState: RoadGroupPanelState | null = activeRoadGroup
        ? {
            groupId: activeRoadGroup.groupId,
            groupIndex: activeRoadGroup.index,
            groupCount: activeRoadGroup.count,
            groupKey: activeRoadGroup.groupKey,
            groupScenario: activeRoadGroup.groupScenario,
            scenarioReason: activeRoadGroup.scenarioReason,
            vehicleCount: activeRoadGroup.vehicleCount,
            orderIds: activeRoadGroup.orderIds,
            routes: routeOrders,
        }
        : null;

    return (
        <MainLayout
            header={<Header/>}
            // leftPanel={<InventoryStats />}
            leftPanel={null}
            centerPanel={
                <div className="relative h-full w-full">
                    {renderCenterPanel()}
                    <DashboardSidePanels
                        mode={sidePanelMode}
                        warehouseFocus={warehouseFocus}
                        roadGroup={roadPanelState}
                        isRoadGroupFading={isRoadGroupFading}
                    />
                    {roadGroupQueue}
                    {roadStrategyTabs}
                    {viewButtons}
                    {dispatchControls}
                    {townRoadSummary}
                </div>
            }
            rightPanel={null}
            // rightPanel={
            //     <>
            //         <VehicleSchedule routeOrders={routeOrders} />
            //         <TrafficMonitor />
            //     </>
            // }
        />
    );
}

export default DashboardPage;
