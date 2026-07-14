import { useCallback, useEffect, useRef, useState } from 'react';
import MainLayout from '@/components/Layout/MainLayout';
import Header from '@/components/Layout/Header';
import type { ChinaMap3DHandle } from './modules/ChinaMap3D';
import type { RoadMap3DHandle as RoadMap3D1Handle } from './modules/RoadMap3D-1';
import type { RoadMap3DHandle as RoadMap3D2Handle } from './modules/RoadMap3D-2';
import DashboardSidePanels from './modules/DashboardSidePanels';
import type { RoadGroupPanelState } from './modules/DashboardSidePanels';
import { useDashboardRealtime } from './hooks/useDashboardRealtime';
import { useRoadGroupsController } from './hooks/useRoadGroupsController';
import { useTruckPositionController } from './hooks/useTruckPositionController';
import { useRm2RoadController } from './hooks/useRm2RoadController';
import { useWarehouseController } from './hooks/useWarehouseController';
import type { ViewMode } from './types';
import { DispatchButtons } from './components/DispatchButtons';
import { DashboardCenterPanel } from './components/DashboardCenterPanel';
import { RoadGroupQueue } from './components/RoadGroupQueue';
import { RoadGroupTabs } from './components/RoadGroupTabs';
import { Rm2Diagnostics } from './components/Rm2Diagnostics';
import { ViewButtons } from './components/ViewButtons';
import {
    dispatchBulkRoutes,
    dispatchRoute,
} from './services/roadApi';

function DashboardPage() {
    const [isDispatching, setIsDispatching] = useState(false);
    const [view, setView] = useState<ViewMode>('warehouse');
    const [isRoadMapVisualReady, setIsRoadMapVisualReady] = useState(false);
    const [isRoadMap2VisualReady, setIsRoadMap2VisualReady] = useState(false);
    const mapRef = useRef<ChinaMap3DHandle>(null);
    const roadMapRef = useRef<RoadMap3D1Handle>(null);
    const roadMap2Ref = useRef<RoadMap3D2Handle>(null);
    const skipNextRoadMapRefreshRef = useRef(false);
    const pendingRoadMapRefreshGroupIdRef = useRef<string | null | undefined>(undefined);
    const roadGroupFinishedHandlerRef = useRef<(lineId: string) => void>(() => {});
    const bulkRoadGroupRefreshTimerRef = useRef<number | null>(null);
    const requestViewChange = useCallback((nextView: ViewMode) => {
        if (view === nextView) return;
        setIsRoadMapVisualReady(false);
        setIsRoadMap2VisualReady(false);
        setView(nextView);
    }, [view]);
    const handleChinaMapVisualReady = useCallback(() => {}, []);
    const handleRoadMapVisualReady = useCallback(() => setIsRoadMapVisualReady(true), []);
    const handleRoadMap2VisualReady = useCallback(() => setIsRoadMap2VisualReady(true), []);
    const handleRoadGroupRouteFinished = useCallback((lineId: string) => {
        roadGroupFinishedHandlerRef.current(lineId);
    }, []);
    const {
        warehouseFocus,
        handleCityRaise,
        handleCityFall,
        handleWarehouseUpdate,
        handleWarehouseTourStateChange,
        handleCameraControl,
        handleWarehouseFocus,
    } = useWarehouseController({
        mapRef,
    });
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
        onRouteFinished: handleRoadGroupRouteFinished,
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
        handleRoadGroupRouteFinished: advanceCompletedRoadGroup,
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
    useEffect(() => {
        roadGroupFinishedHandlerRef.current = advanceCompletedRoadGroup;
    }, [advanceCompletedRoadGroup]);
    const {
        groups: rm2Groups,
        activeGroupId: activeRm2GroupId,
        isLoading: isLoadingRm2Group,
        diagnostics: rm2Diagnostics,
        loadGroup: loadRm2Group,
        refreshRm2,
    } = useRm2RoadController({
        roadMapRef: roadMap2Ref,
        view,
        sceneReady: isRoadMap2VisualReady,
    });
    const handleRouteRaise = useCallback(() => {
        // 城市飞线事件由 ChinaMap3D 处理；道路级地图只加载后端分组后的路线。
    }, []);

    const requestDispatch = useCallback(async () => {
        if (isDispatching) return;
        setIsDispatching(true);
        try {
            const route = await dispatchRoute();
            const preferredGroupId = route.groupId ?? undefined;
            if (view === 'roadMap' && isRoadMapVisualReady) {
                await refreshRoadGroups(preferredGroupId);
            } else {
                pendingRoadMapRefreshGroupIdRef.current = preferredGroupId;
                requestViewChange('roadMap');
            }
        } catch (error) {
            console.warn('Route dispatch failed', error);
        } finally {
            setIsDispatching(false);
        }
    }, [isDispatching, isRoadMapVisualReady, refreshRoadGroups, requestViewChange, view]);

    const requestBulkDispatch = useCallback(async () => {
        if (isDispatching) return;
        setIsDispatching(true);
        try {
            await dispatchBulkRoutes(24);
            if (bulkRoadGroupRefreshTimerRef.current !== null) {
                window.clearTimeout(bulkRoadGroupRefreshTimerRef.current);
            }
            bulkRoadGroupRefreshTimerRef.current = window.setTimeout(() => {
                bulkRoadGroupRefreshTimerRef.current = null;
                if (view === 'roadMap' && isRoadMapVisualReady) {
                    void refreshRoadGroups(activeRoadGroupIdRef.current ?? undefined);
                    return;
                }
                pendingRoadMapRefreshGroupIdRef.current = activeRoadGroupIdRef.current ?? undefined;
                requestViewChange('roadMap');
            }, 180);
        } catch (error) {
            console.warn('Bulk route dispatch failed', error);
        } finally {
            setIsDispatching(false);
        }
    }, [activeRoadGroupIdRef, isDispatching, isRoadMapVisualReady, refreshRoadGroups, requestViewChange, view]);


    const requestRoadMapSnapshot = useCallback(async () => {
        const pendingGroupId = pendingRoadMapRefreshGroupIdRef.current;
        pendingRoadMapRefreshGroupIdRef.current = undefined;
        try {
            await refreshRoadGroups(pendingGroupId ?? activeRoadGroupIdRef.current ?? undefined);
        } catch (error) {
            console.warn('Road map prepare failed', error);
        }
    }, [activeRoadGroupIdRef, refreshRoadGroups]);

    useEffect(() => () => {
        if (bulkRoadGroupRefreshTimerRef.current !== null) {
            window.clearTimeout(bulkRoadGroupRefreshTimerRef.current);
            bulkRoadGroupRefreshTimerRef.current = null;
        }
    }, []);

    useDashboardRealtime({
        onCityRaise: handleCityRaise,
        onCityFall: handleCityFall,
        onRouteRaise: handleRouteRaise,
        onRouteFall: finishRoute,
        onRoadPath: handleRoadPath,
        onTruckPosition: handleTruckPosition,
        onWarehouseUpdate: handleWarehouseUpdate,
        onWarehouseFocus: handleWarehouseFocus,
        onCameraControl: handleCameraControl,
    });

    useEffect(() => {
        if (view !== 'roadMap' || !isRoadMapVisualReady) return;
        void requestRoadMapSnapshot();
    }, [isRoadMapVisualReady, requestRoadMapSnapshot, view]);

    const renderCenterPanel = () => (
        <DashboardCenterPanel
            view={view}
            mapRef={mapRef}
            roadMapRef={roadMapRef}
            roadMap2Ref={roadMap2Ref}
            onChinaMapVisualReady={handleChinaMapVisualReady}
            onRoadMapVisualReady={handleRoadMapVisualReady}
            onRoadMap2VisualReady={handleRoadMap2VisualReady}
            onWarehouseTourStateChange={handleWarehouseTourStateChange}
        />
    );

    const viewButtons = (
        <ViewButtons
            view={view}
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
    const rm2GroupQueue = view === 'roadMap2' && rm2Groups.length > 0 && (
        <RoadGroupQueue
            groups={rm2Groups}
            activeGroupId={activeRm2GroupId}
            isLoading={isLoadingRm2Group}
            onSelectGroup={(groupId) => void loadRm2Group(groupId)}
        />
    );
    const rm2DiagnosticsPanel = view === 'roadMap2' && (
        <Rm2Diagnostics
            diagnostics={rm2Diagnostics}
            isLoading={isLoadingRm2Group}
            onRefresh={() => void refreshRm2()}
        />
    );

    const dispatchControls = view === 'roadMap' && (
        <DispatchButtons
            isDispatching={isDispatching}
            onDispatch={requestDispatch}
            onBulkDispatch={requestBulkDispatch}
        />
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
            vehicleCount: activeRoadGroup.vehicleCount,
            groupKey: activeRoadGroup.groupKey,
            groupScenario: activeRoadGroup.groupScenario,
            scenarioReason: activeRoadGroup.scenarioReason,
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
                    {rm2GroupQueue}
                    {rm2DiagnosticsPanel}
                    {roadStrategyTabs}
                    {viewButtons}
                    {dispatchControls}
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
