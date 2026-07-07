import Panel from '@/components/Layout/Panel';
import EChart from '@/components/Charts/EChart';
import type { EChartsOption } from 'echarts';
import type { RouteOrder } from '../hooks/useDashboardRealtime';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';


type WarehouseFocusState = {
    cityName: string;
    displayData: Record<string, any>;
};

type RoadGroupPanelState = {
    groupId: string | null;
    groupIndex?: number;
    groupCount?: number;
    vehicleCount?: number;
    groupKey?: string;
    groupScenario?: string;
    scenarioReason?: string;
    orderIds?: string[];
    routes: RouteOrder[];
};

type DashboardSidePanelsProps = {
    mode: 'hidden' | 'warehouse_focus' | 'road_group_focus';
    warehouseFocus: WarehouseFocusState | null;
    roadGroup: RoadGroupPanelState | null;
    isRoadGroupFading: boolean;
};

function numberValue(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function buildWarehouseMetrics(focus: WarehouseFocusState | null) {
    const data = focus?.displayData ?? {};
    const seed = Array.from(focus?.cityName ?? '仓库').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const total = numberValue(data.total ?? data.inventory ?? data.stock, 4200 + seed % 3600);
    const todayIn = numberValue(data.todayIn ?? data.inbound, 160 + seed % 120);
    const todayOut = numberValue(data.todayOut ?? data.outbound, 130 + seed % 100);
    const activeVehicles = numberValue(data.activeVehicles ?? data.vehicles, 6 + seed % 12);
    const capacityRate = Math.min(98, Math.round((total / 8200) * 100));

    return {
        total,
        todayIn,
        todayOut,
        activeVehicles,
        capacityRate,
        pendingOrders: numberValue(data.pendingOrders, 4 + seed % 9),
    };
}

function buildTrendOption(metrics: ReturnType<typeof buildWarehouseMetrics>): EChartsOption {
    const base = metrics.todayIn;
    const outBase = metrics.todayOut;
    return {
        grid: { left: 26, right: 12, top: 20, bottom: 22 },
        tooltip: { trigger: 'axis' },
        xAxis: {
            type: 'category',
            data: ['08:00', '10:00', '12:00', '14:00', '16:00'],
            axisLabel: { color: '#94a3b8', fontSize: 10 },
            axisLine: { lineStyle: { color: 'rgba(148,163,184,0.18)' } },
        },
        yAxis: {
            type: 'value',
            axisLabel: { color: '#94a3b8', fontSize: 10 },
            splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } },
        },
        series: [
            {
                name: '入库',
                type: 'line',
                smooth: true,
                symbolSize: 5,
                data: [base * 0.46, base * 0.62, base * 0.75, base * 0.92, base],
                lineStyle: { width: 2, color: '#22d3ee' },
                itemStyle: { color: '#67e8f9' },
                areaStyle: { color: 'rgba(34,211,238,0.12)' },
            },
            {
                name: '出库',
                type: 'line',
                smooth: true,
                symbolSize: 5,
                data: [outBase * 0.5, outBase * 0.7, outBase * 0.66, outBase * 0.88, outBase],
                lineStyle: { width: 2, color: '#f59e0b' },
                itemStyle: { color: '#fbbf24' },
                areaStyle: { color: 'rgba(245,158,11,0.10)' },
            },
        ],
    };
}

function buildCategoryOption(metrics: ReturnType<typeof buildWarehouseMetrics>): EChartsOption {
    const total = Math.max(1, metrics.total);
    return {
        tooltip: { trigger: 'item' },
        legend: {
            bottom: 0,
            textStyle: { color: '#94a3b8', fontSize: 10 },
        },
        series: [
            {
                type: 'pie',
                radius: ['46%', '68%'],
                center: ['50%', '43%'],
                label: { color: '#cbd5e1', fontSize: 10 },
                labelLine: { length: 10, length2: 8 },
                data: [
                    { name: '铝锭', value: Math.round(total * 0.28) },
                    { name: '铜材', value: Math.round(total * 0.22) },
                    { name: '钢材', value: Math.round(total * 0.31) },
                    { name: '其他', value: Math.round(total * 0.19) },
                ],
            },
        ],
        color: ['#22d3ee', '#60a5fa', '#fbbf24', '#34d399'],
    };
}

function StatRow({ label, value, unit, tone = 'text-slate-100' }: { label: string; value: number | string; unit?: string; tone?: string }) {
    return (
        <div className="flex items-center justify-between gap-3 rounded border border-white/5 bg-white/[0.025] px-3 py-2">
            <span className="text-xs text-slate-400">{label}</span>
            <span className={`text-sm font-semibold ${tone}`}>
                {typeof value === 'number' ? value.toLocaleString() : value}
                {unit && <span className="ml-1 text-xs font-normal text-slate-400">{unit}</span>}
            </span>
        </div>
    );
}

function routeProgress(route: RouteOrder) {
    const rawProgress = Number((route as any).progress);
    if (Number.isFinite(rawProgress)) {
        return Math.round(Math.min(Math.max(rawProgress, 0), 1) * 100);
    }

    const pathLength = Number((route as any).pathLength);
    const calibratedDistance = Number((route as any).calibratedDistance);
    if (Number.isFinite(pathLength) && pathLength > 0 && Number.isFinite(calibratedDistance)) {
        return Math.round(Math.min(Math.max(calibratedDistance / pathLength, 0), 1) * 100);
    }

    if (route.status.includes('完成') || route.status === 'finished') {
        return 100;
    }
    return 0;
}

function routeEtaText(route: RouteOrder, progress: number) {
    if (progress >= 100 || route.status.includes('完成') || route.status === 'finished') {
        return '已到达';
    }

    const routeLengthKm = Number((route as any).routeLengthKm);
    const speedKmh = Number((route as any).speedKmh);
    if (!Number.isFinite(routeLengthKm) || routeLengthKm <= 0 || !Number.isFinite(speedKmh) || speedKmh <= 0) {
        return '预计 --';
    }

    const remainingKm = routeLengthKm * Math.max(0, 1 - progress / 100);
    const minutes = Math.max(1, Math.round((remainingKm / speedKmh) * 60));
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const restMinutes = minutes % 60;
        return `预计 ${hours}h${restMinutes ? `${restMinutes}m` : ''}`;
    }
    return `预计 ${minutes}m`;
}

function routeDistanceText(route: RouteOrder, progress: number) {
    const routeLengthKm = Number((route as any).routeLengthKm);
    if (!Number.isFinite(routeLengthKm) || routeLengthKm <= 0) {
        return '-- km';
    }

    const traveledKm = routeLengthKm * Math.min(Math.max(progress, 0), 100) / 100;
    return `${traveledKm.toFixed(0)} / ${routeLengthKm.toFixed(0)} km`;
}

function buildOrderSummaries(routes: RouteOrder[], fallbackOrderIds: string[] = []) {
    const orderMap = new Map<string, {
        id: string;
        name: string;
        totalTons: number;
        dispatchedVehicles: number;
        routeCount: number;
    }>();

    routes.forEach((route) => {
        const id = String((route as any).orderId || route.lineId);
        const existing = orderMap.get(id);
        const totalTons = Number((route as any).orderTotalTons) || 0;
        if (existing) {
            existing.totalTons = Math.max(existing.totalTons, totalTons);
            existing.routeCount += 1;
            existing.dispatchedVehicles = existing.routeCount; // 已派 = 当前实际路线数
            return;
        }

        orderMap.set(id, {
            id,
            name: String((route as any).orderName || (id.startsWith('BULK-') ? '大宗运输订单' : '运输任务')),
            totalTons,
            routeCount: 1,
            dispatchedVehicles: 1, // 初始 1 辆
        });
    });

    fallbackOrderIds.forEach((id) => {
        if (!orderMap.has(id)) {
            orderMap.set(id, {
                id,
                name: id.startsWith('BULK-') ? '大宗运输订单' : '运输任务',
                totalTons: 0,
                dispatchedVehicles: 0,
                routeCount: 0,
            });
        }
    });

    return Array.from(orderMap.values());
}

function routeIdentity(route: RouteOrder) {
    const pathKey = String((route as any).pathKey ?? '').trim();
    if (pathKey) return pathKey;
    return `${route.from ?? '未知起点'}→${route.to ?? '未知终点'}`;
}

function uniqueRouteCount(routes: RouteOrder[]) {
    return new Set(routes.map(routeIdentity)).size;
}

function AutoScrollList({
                            enabled,
                            resetKey,
                            speedPxPerSecond = 36,
                            children,
                        }: {
    enabled: boolean;
    resetKey: string;
    speedPxPerSecond?: number;
    children: ReactNode;
}) {
    const scrollRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;
        container.scrollTop = 0;
        if (!enabled) return;

        let animationFrame = 0;
        let previousTime = performance.now();

        const tick = (currentTime: number) => {
            const elapsedMs = Math.min(currentTime - previousTime, 64);
            previousTime = currentTime;

            const loopHeight = container.scrollHeight / 2;
            if (loopHeight > container.clientHeight) {
                container.scrollTop += (elapsedMs * speedPxPerSecond) / 1000;
                if (container.scrollTop >= loopHeight) {
                    container.scrollTop -= loopHeight;
                }
            }
            animationFrame = window.requestAnimationFrame(tick);
        };

        animationFrame = window.requestAnimationFrame(tick);
        return () => window.cancelAnimationFrame(animationFrame);
    }, [enabled, resetKey, speedPxPerSecond]);

    return (
        <div ref={scrollRef} className="dashboard-auto-scroll no-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain pr-1">
            <div className="space-y-1.5">
                {children}
            </div>
            {enabled && (
                <div className="mt-1.5 space-y-1.5" aria-hidden="true">
                    {children}
                </div>
            )}
        </div>
    );
}


function WarehouseLeftPanels({ focus }: { focus: WarehouseFocusState }) {
    const metrics = buildWarehouseMetrics(focus);

    return (
        <>
            <Panel title={`${focus.cityName}仓库概览`} className="h-[42%] min-h-[280px]">
                <div className="grid h-full grid-cols-2 gap-2">
                    <StatRow label="总库存" value={metrics.total} unit="吨" tone="text-cyan-200" />
                    <StatRow label="库容占用" value={`${metrics.capacityRate}%`} tone="text-emerald-200" />
                    <StatRow label="今日入库" value={metrics.todayIn} unit="吨" tone="text-sky-200" />
                    <StatRow label="今日出库" value={metrics.todayOut} unit="吨" tone="text-amber-200" />
                    <StatRow label="待处理订单" value={metrics.pendingOrders} unit="单" />
                    <StatRow label="在场车辆" value={metrics.activeVehicles} unit="辆" />
                </div>
            </Panel>

            <Panel title="品类占比" className="h-[58%] min-h-[320px]">
                <EChart option={buildCategoryOption(metrics)} style={{ height: '100%' }} />
            </Panel>
        </>
    );
}

function WarehouseRightPanels({ focus }: { focus: WarehouseFocusState }) {
    const metrics = buildWarehouseMetrics(focus);

    return (
        <>
            <Panel title="今日出入库趋势" className="h-[58%] min-h-[340px]">
                <EChart option={buildTrendOption(metrics)} style={{ height: '100%' }} />
            </Panel>

            <Panel title="作业状态" className="h-[42%] min-h-[260px]">
                <div className="space-y-2">
                    <StatRow label="待处理订单" value={metrics.pendingOrders} unit="单" tone="text-cyan-200" />
                    <StatRow label="在场车辆" value={metrics.activeVehicles} unit="辆" tone="text-emerald-200" />
                    <StatRow label="入出库差值" value={metrics.todayIn - metrics.todayOut} unit="吨" tone="text-amber-200" />
                    <div className="rounded border border-white/5 bg-white/[0.025] px-3 py-3 text-xs leading-5 text-slate-400">
                        聚焦仓库时展示当前城市的运营数据；全国俯瞰阶段隐藏面板，避免遮挡仓库分布。
                    </div>
                </div>
            </Panel>
        </>
    );
}

function useRoadGroupPanelTransition(
    roadGroup: RoadGroupPanelState | null,
    isRoadGroupFading: boolean
) {
    const [displayRoadGroup, setDisplayRoadGroup] = useState<RoadGroupPanelState | null>(roadGroup);
    const [transitionKey, setTransitionKey] = useState(0);
    const pendingRoadGroupRef = useRef<RoadGroupPanelState | null | undefined>(undefined);
    const displayGroupId = displayRoadGroup?.groupId ?? null;
    const nextGroupId = roadGroup?.groupId ?? null;

    useLayoutEffect(() => {
        if (isRoadGroupFading && nextGroupId !== displayGroupId) {
            pendingRoadGroupRef.current = roadGroup;
            return;
        }

        const pendingRoadGroup = pendingRoadGroupRef.current;
        if (!isRoadGroupFading && pendingRoadGroup !== undefined) {
            pendingRoadGroupRef.current = undefined;
            setDisplayRoadGroup(pendingRoadGroup);
            setTransitionKey((key) => key + 1);
            return;
        }

        setDisplayRoadGroup(roadGroup);
        if (nextGroupId !== displayGroupId) {
            setTransitionKey((key) => key + 1);
        }
    }, [displayGroupId, isRoadGroupFading, nextGroupId, roadGroup]);

    return {
        displayRoadGroup,
        transitionKey,
        isHoldingPreviousRoadGroup: isRoadGroupFading && nextGroupId !== displayGroupId,
    };
}

function RoadGroupLeftPanels({ roadGroup }: { roadGroup: RoadGroupPanelState }) {
    const routes = roadGroup.routes;
    const routeCount = uniqueRouteCount(routes);
    const vehicleCount = roadGroup.vehicleCount ?? routes.length;
    const running = routes.filter((route) => route.status.includes('运输') || route.status === 'running').length;
    const finished = routes.filter((route) => route.status.includes('完成') || route.status === 'finished').length;
    const avgSpeed = routes.length
        ? routes.reduce((sum, route) => sum + (Number((route as any).speedKmh) || 0), 0) / routes.length
        : 0;
    const orderSummaries = buildOrderSummaries(routes, roadGroup.orderIds ?? []);
    const shouldAutoScrollOrders = orderSummaries.length >= 4;

    return (
        <>
            <Panel title="运输聚合详情" className="h-[44%] min-h-[300px]">
                <div className="space-y-2">
                    <StatRow label="当前组" value={roadGroup.groupIndex !== undefined ? `第 ${roadGroup.groupIndex + 1} 组` : roadGroup.groupId ?? '-'} />
                    <StatRow label="组内线路" value={roadGroup.groupCount ?? routeCount} unit="条" tone="text-cyan-200" />
                    <StatRow label="调度车辆" value={vehicleCount} unit="辆" tone="text-sky-200" />
                    <StatRow label="运输中" value={running} unit="辆" tone="text-emerald-200" />
                    <StatRow label="已完成" value={finished} unit="辆" />
                    <StatRow label="平均时速" value={Math.round(avgSpeed)} unit="km/h" tone="text-amber-200" />
                </div>
            </Panel>

            <Panel title="组内订单" className="h-[56%] min-h-[320px]">
                <div className="flex h-full flex-col gap-3">
                    {/* 已移除分组场景调试信息 */}
                    <div className="min-h-0 flex-1">
                        <AutoScrollList
                            enabled={shouldAutoScrollOrders}
                            resetKey={`${roadGroup.groupId ?? 'road-group'}-orders`}
                        >
                            {orderSummaries.map((order, index) => (
                                <div key={`${order.id}-${index}`} className="rounded border border-white/5 bg-white/[0.025] px-3 py-2 text-xs">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="truncate text-cyan-100" title={order.name}>{order.name}</div>
                                            <div className="mt-0.5 truncate text-[10px] text-slate-500" title={order.id}>{order.id}</div>
                                        </div>
                                        <span className="shrink-0 text-[10px] text-slate-500">订单</span>
                                    </div>
                                    <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-slate-400">
                                        <span>总量 {order.totalTons > 0 ? `${order.totalTons} 吨` : '--'}</span>
                                        <span className="text-right">
                                            已派 {order.dispatchedVehicles} 辆
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </AutoScrollList>
                    </div>
                </div>
            </Panel>
        </>
    );
}

function RoadGroupRightPanels({ roadGroup }: { roadGroup: RoadGroupPanelState }) {
    const routes = roadGroup.routes;

    const finishedRoutes = routes.filter(
        (r) => r.status === '已完成' || r.status === 'finished'
    );
    const unfinishedRoutes = routes.filter(
        (r) => !(r.status === '已完成' || r.status === 'finished')
    );

    const sortedUnfinished = [...unfinishedRoutes].sort((a, b) => {
        const aProgress = routeProgress(a);
        const bProgress = routeProgress(b);
        return bProgress - aProgress;
    });
    const visibleUnfinished = sortedUnfinished.slice(0, 40);
    const shouldAutoScroll = visibleUnfinished.length > 5; // 让 AutoScrollList 内部判断溢出再滚动

    const renderRouteCard = (route: RouteOrder, keySuffix = '') => {
        const progress = routeProgress(route);
        return (
            <div key={`${route.lineId}${keySuffix}`} className="rounded border border-white/5 bg-white/[0.025] px-2 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-cyan-200">{route.plate}</span>
                    <span className="rounded border border-emerald-300/20 px-1.5 py-0.5 text-[10px] text-emerald-200">
                        {route.status}
                    </span>
                </div>
                <div className="mt-1 truncate text-slate-400" title={`${route.from} → ${route.to}`}>
                    {route.from} → {route.to}
                </div>
                <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800/80">
                        <div
                            className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-sky-400 to-emerald-300 shadow-[0_0_10px_rgba(34,211,238,0.45)] transition-all duration-500"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                    <span className="w-20 text-right text-[10px] tabular-nums text-slate-400">
                        {routeDistanceText(route, progress)}
                    </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                    <span>{routeEtaText(route, progress)}</span>
                    <span>
                        {Number.isFinite(Number((route as any).speedKmh))
                            ? `${Math.round(Number((route as any).speedKmh))} km/h`
                            : '-- km/h'}
                    </span>
                </div>
            </div>
        );
    };

    const recentFinished = finishedRoutes.slice(-4); // 最新 4 条

    return (
        <Panel title="组内车辆" className="h-full min-h-0">
            {/* 关键：在 Panel 内部建立 flex 列容器，撑满内容区高度 */}
            <div className="h-full flex flex-col">
                {/* 上方：运输中车辆（自动滚动） */}
                <div className="flex-1 min-h-0">
                    <AutoScrollList
                        enabled={shouldAutoScroll}
                        resetKey={`${roadGroup.groupId ?? 'road-group'}-vehicles`}
                    >
                        {visibleUnfinished.map((route) => renderRouteCard(route))}
                    </AutoScrollList>
                </div>

                {/* 下方：已完成车辆（固定高度，始终显示） */}
                <div className="shrink-0 border-t border-cyan-400/20 bg-cyan-400/5 px-2 py-2 overflow-hidden">
                    {recentFinished.length > 0 ? (
                        <>
                            <div className="text-xs text-cyan-300 font-semibold mb-1">已完成车辆</div>
                            {recentFinished.map((route) => (
                                <div
                                    key={route.lineId}
                                    className="flex items-center justify-between gap-2 rounded border border-emerald-300/10 bg-emerald-300/5 px-2 py-1 text-xs"
                                >
                                    <span className="truncate text-cyan-200 font-medium">{route.plate}</span>
                                    <span className="truncate text-slate-400 text-[11px]"
                                          title={`${route.from} → ${route.to}`}>
                                        {route.from} → {route.to}
                                    </span>
                                    <span className="shrink-0 text-emerald-300 flex items-center gap-1 text-[11px]">
                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                                  d="M5 13l4 4L19 7"/>
                                        </svg>
                                        完成
                                    </span>
                                </div>
                            ))}
                        </>
                    ) : (
                        <div className="text-xs text-slate-500 mt-2 text-center">暂无完成车辆</div>
                    )}
                </div>
            </div>
        </Panel>
    );
}

function DashboardSidePanels({mode, warehouseFocus, roadGroup, isRoadGroupFading }: DashboardSidePanelsProps) {
    const visible = mode !== 'hidden';
    const isWarehouseMode = mode === 'warehouse_focus';
    const {
        displayRoadGroup,
        transitionKey,
        isHoldingPreviousRoadGroup,
    } = useRoadGroupPanelTransition(roadGroup, isRoadGroupFading);
    const leftWidthClass = isWarehouseMode
        ? 'w-[18%] min-w-[220px] max-w-[300px]'
        : 'w-[22%] min-w-[280px]';
    const rightWidthClass = isWarehouseMode
        ? 'w-[20%] min-w-[240px] max-w-[320px]'
        : 'w-[25%] min-w-[320px]';
    const roadPanelTransitionClass = isHoldingPreviousRoadGroup
        ? 'translate-y-1 opacity-60'
        : 'translate-y-0 opacity-100';

    return (
        <div
            className={`pointer-events-none absolute inset-y-20 left-4 right-4 z-30 flex justify-between gap-4 transition-all duration-500 ${
                visible ? 'opacity-100' : 'opacity-0'
            }`}
        >
            <div className={`pointer-events-auto flex ${leftWidthClass} flex-col gap-3 transition-transform duration-500 ${visible ? 'translate-x-0' : '-translate-x-4'}`}>
                {mode === 'warehouse_focus' && warehouseFocus && <WarehouseLeftPanels focus={warehouseFocus} />}
                {mode === 'road_group_focus' && displayRoadGroup && (
                    <div
                        className={`flex min-h-0 flex-1 flex-col gap-3 transition-all duration-500 ease-out ${roadPanelTransitionClass}`}
                    >
                        <div key={`road-left-${transitionKey}`} className="flex min-h-0 flex-1 flex-col gap-3">
                            <RoadGroupLeftPanels roadGroup={displayRoadGroup} />
                        </div>
                    </div>
                )}
            </div>
            <div className={`pointer-events-auto flex ${rightWidthClass} flex-col gap-3 transition-transform duration-500 ${visible ? 'translate-x-0' : 'translate-x-4'}`}>
                {mode === 'warehouse_focus' && warehouseFocus && <WarehouseRightPanels focus={warehouseFocus} />}
                {mode === 'road_group_focus' && displayRoadGroup && (
                    <div
                        className={`flex min-h-0 flex-1 flex-col transition-all duration-500 ease-out ${roadPanelTransitionClass}`}
                    >
                        <div key={`road-right-${transitionKey}`} className="flex min-h-0 flex-1 flex-col">
                            <RoadGroupRightPanels roadGroup={displayRoadGroup} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default DashboardSidePanels;
export type { WarehouseFocusState, RoadGroupPanelState };
