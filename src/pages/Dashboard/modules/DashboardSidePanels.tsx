import Panel from '@/components/Layout/Panel';
import EChart from '@/components/Charts/EChart';
import type { EChartsOption } from 'echarts';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RouteOrder } from '../hooks/useDashboardRealtime';

export type WarehouseFocusState = {
    cityName: string;
    displayData: Record<string, unknown>;
};

export type RoadGroupPanelState = {
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
    roadPanelVariant?: 'aggregate' | 'vehicle';
    isRoadGroupFading?: boolean;
};

type RouteDisplayData = RouteOrder & {
    progress?: unknown;
    pathLength?: unknown;
    calibratedDistance?: unknown;
    routeLengthKm?: unknown;
    speedKmh?: unknown;
    orderId?: unknown;
    orderTotalTons?: unknown;
    orderName?: unknown;
    pathKey?: unknown;
};

function routeDisplayData(route: RouteOrder): RouteDisplayData {
    return route as RouteDisplayData;
}

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

function StatRow({
    label,
    value,
    unit,
    tone = 'text-slate-100',
}: {
    label: string;
    value: number | string;
    unit?: string;
    tone?: string;
}) {
    return (
        <div className="flex items-center justify-between gap-3 rounded border border-white/5 bg-white/[0.025] px-3 py-2">
            <span className="text-xs text-slate-400">{label}</span>
            <span className={`text-right text-sm font-semibold ${tone}`}>
                {typeof value === 'number' ? value.toLocaleString() : value}
                {unit && <span className="ml-1 text-xs font-normal text-slate-400">{unit}</span>}
            </span>
        </div>
    );
}

function routeProgress(route: RouteOrder) {
    const rawProgress = Number(routeDisplayData(route).progress);
    if (Number.isFinite(rawProgress)) {
        return Math.round(Math.min(Math.max(rawProgress, 0), 1) * 100);
    }

    const pathLength = Number(routeDisplayData(route).pathLength);
    const calibratedDistance = Number(routeDisplayData(route).calibratedDistance);
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

    const routeLengthKm = Number(routeDisplayData(route).routeLengthKm);
    const speedKmh = Number(routeDisplayData(route).speedKmh);
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
    const routeLengthKm = Number(routeDisplayData(route).routeLengthKm);
    if (!Number.isFinite(routeLengthKm) || routeLengthKm <= 0) {
        return '-- km';
    }
    const traveledKm = routeLengthKm * Math.min(Math.max(progress, 0), 100) / 100;
    return `${traveledKm.toFixed(0)} / ${routeLengthKm.toFixed(0)} km`;
}

type OrderSummary = {
    id: string;
    name: string;
    totalTons: number;
    dispatchedVehicles: number;
    routeCount: number;
};

function buildOrderSummaries(routes: RouteOrder[], fallbackOrderIds: string[] = []): OrderSummary[] {
    const orderMap = new Map<string, OrderSummary>();

    routes.forEach((route) => {
        const id = String(routeDisplayData(route).orderId || route.lineId);
        const existing = orderMap.get(id);
        const totalTons = Number(routeDisplayData(route).orderTotalTons) || 0;

        if (existing) {
            existing.totalTons = Math.max(existing.totalTons, totalTons);
            existing.routeCount += 1;
            existing.dispatchedVehicles = existing.routeCount;
            return;
        }

        orderMap.set(id, {
            id,
            name: String(routeDisplayData(route).orderName || (id.startsWith('BULK-') ? '大宗运输订单' : '运输任务')),
            totalTons,
            routeCount: 1,
            dispatchedVehicles: 1,
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
    const pathKey = String(routeDisplayData(route).pathKey ?? '').trim();
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
        <div ref={scrollRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
            {children}
            {enabled && <div aria-hidden="true">{children}</div>}
        </div>
    );
}

const WarehouseLeftPanels = memo(function WarehouseLeftPanels({ focus }: { focus: WarehouseFocusState }) {
    const metrics = useMemo(() => buildWarehouseMetrics(focus), [focus]);
    const categoryOption = useMemo(() => buildCategoryOption(metrics), [metrics]);

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
                <EChart option={categoryOption} style={{ height: '100%' }} />
            </Panel>
        </>
    );
});

const WarehouseRightPanels = memo(function WarehouseRightPanels({ focus }: { focus: WarehouseFocusState }) {
    const metrics = useMemo(() => buildWarehouseMetrics(focus), [focus]);
    const trendOption = useMemo(() => buildTrendOption(metrics), [metrics]);

    return (
        <>
            <Panel title="今日出入库趋势" className="h-[58%] min-h-[340px]">
                <EChart option={trendOption} style={{ height: '100%' }} />
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
});

function useRoadGroupPanelTransition(
    roadGroup: RoadGroupPanelState | null,
    isRoadGroupFading: boolean
) {
    const [displayRoadGroup, setDisplayRoadGroup] = useState(roadGroup);
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

function VehicleTransportDetails({ roadGroup }: { roadGroup: RoadGroupPanelState }) {
    const [cycleIndex, setCycleIndex] = useState(0);
    const detailRoutes = useMemo(() => {
        const running = roadGroup.routes.filter((route) => (
            route.status !== '已完成' && route.status !== 'finished'
        ));
        const finished = roadGroup.routes.filter((route) => (
            route.status === '已完成' || route.status === 'finished'
        ));
        return [...running, ...finished];
    }, [roadGroup.routes]);
    const targetRoute = detailRoutes.length > 0
        ? detailRoutes[cycleIndex % detailRoutes.length]
        : undefined;

    useEffect(() => {
        if (detailRoutes.length <= 1) return;
        const intervalMs = Math.max(900, Math.min(2800, Math.floor(12_000 / detailRoutes.length)));
        const timer = window.setInterval(() => {
            setCycleIndex((index) => index + 1);
        }, intervalMs);
        return () => window.clearInterval(timer);
    }, [detailRoutes.length, roadGroup.groupId]);

    return (
        <Panel title="车辆运输详情" className="h-[64%] min-h-0">
            <div key={targetRoute?.lineId ?? 'empty'} className="vehicle-detail-swap flex h-full min-h-0 flex-col">
                <div className="flex items-center justify-between gap-3 rounded border border-sky-300/20 bg-sky-400/8 px-3 py-3 shadow-[inset_3px_0_0_rgba(125,211,252,0.8)]">
                    <div className="min-w-0">
                        <div className="text-[10px] text-slate-400">当前展示车辆</div>
                        <div className="mt-1 truncate text-lg font-semibold text-sky-100" title={targetRoute?.plate || '--'}>
                            {targetRoute?.plate || '--'}
                        </div>
                    </div>
                    <div className="shrink-0 text-right">
                        <div className="text-[10px] tabular-nums text-slate-500">
                            {detailRoutes.length > 0 ? `${cycleIndex % detailRoutes.length + 1} / ${detailRoutes.length}` : '0 / 0'}
                        </div>
                        <div className="mt-1 rounded border border-emerald-300/25 bg-emerald-300/8 px-2 py-0.5 text-[10px] text-emerald-200">
                            {targetRoute?.status || '等待数据'}
                        </div>
                    </div>
                </div>

                <div className="mt-3 flex min-h-0 flex-1 flex-col rounded border border-white/8 bg-slate-900/55 px-3 py-3">
                    <div className="grid min-h-0 flex-1 grid-cols-[1rem_1fr] gap-x-3">
                        <div className="flex flex-col items-center py-1">
                            <span className="h-2.5 w-2.5 rounded-full border-2 border-sky-200 bg-sky-500 shadow-[0_0_10px_rgba(56,189,248,0.7)]" />
                            <span className="my-1 min-h-5 w-px flex-1 bg-gradient-to-b from-sky-300/70 to-emerald-300/70" />
                            <span className="h-2.5 w-2.5 rounded-full border-2 border-emerald-200 bg-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.65)]" />
                        </div>
                        <div className="flex min-h-0 flex-col justify-between gap-3">
                            <div>
                                <div className="text-[10px] text-slate-500">起点</div>
                                <div className="mt-1 line-clamp-3 text-sm font-medium leading-5 text-sky-100" title={targetRoute?.from || '--'}>
                                    {targetRoute?.from || '--'}
                                </div>
                            </div>
                            <div>
                                <div className="text-[10px] text-slate-500">目的地</div>
                                <div className="mt-1 line-clamp-3 text-sm font-medium leading-5 text-emerald-100" title={targetRoute?.to || '--'}>
                                    {targetRoute?.to || '--'}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Panel>
    );
}

function RoadGroupLeftPanels({
    roadGroup,
    variant,
}: {
    roadGroup: RoadGroupPanelState;
    variant: 'aggregate' | 'vehicle';
}) {
    const routes = roadGroup.routes;
    const routeCount = uniqueRouteCount(routes);
    const vehicleCount = roadGroup.vehicleCount ?? routes.length;
    const running = routes.filter((route) => route.status.includes('运输') || route.status === 'running').length;
    const finished = routes.filter((route) => route.status.includes('完成') || route.status === 'finished').length;
    const avgSpeed = routes.length
        ? routes.reduce((sum, route) => sum + (Number(routeDisplayData(route).speedKmh) || 0), 0) / routes.length
        : 0;
    const orderSummaries = buildOrderSummaries(routes, roadGroup.orderIds ?? []);
    const visibleOrderSummaries = variant === 'vehicle' ? orderSummaries.slice(0, 3) : orderSummaries;
    const shouldAutoScrollOrders = variant === 'aggregate' && visibleOrderSummaries.length >= 4;

    return (
        <>
            {variant === 'vehicle' ? (
                <VehicleTransportDetails roadGroup={roadGroup} />
            ) : (
                <Panel title="运输聚合详情" className="h-[44%] min-h-[300px]">
                    <div className="space-y-2">
                        <StatRow label="当前组" value={roadGroup.groupIndex !== undefined ? `第 ${roadGroup.groupIndex + 1} 组` : roadGroup.groupId ?? '-'} />
                        <StatRow label="组内线路" value={roadGroup.groupCount ?? routeCount} unit="条" tone="text-cyan-200" />
                        <StatRow label="调度车辆" value={vehicleCount} unit="辆" tone="text-sky-200" />
                        <StatRow label="运输中" value={running} unit="辆" tone="text-emerald-200" />
                        <StatRow label="已完成" value={finished} unit="辆" />
                        <StatRow label="平均时速" value={avgSpeed > 0 ? Math.round(avgSpeed) : '--'} unit="km/h" tone="text-amber-200" />
                    </div>
                </Panel>
            )}

            <Panel title="组内订单" className={variant === 'vehicle' ? 'h-[36%] min-h-0' : 'h-[56%] min-h-[320px]'}>
                <div className="flex h-full min-h-0 flex-col">
                    <AutoScrollList
                        enabled={shouldAutoScrollOrders}
                        resetKey={`${roadGroup.groupId ?? 'none'}-${visibleOrderSummaries.length}`}
                        speedPxPerSecond={30}
                    >
                        <div className="space-y-2">
                        {visibleOrderSummaries.map((order, index) => (
                            <div
                                key={`${order.id}-${index}`}
                                className="rounded border border-white/5 bg-white/[0.025] px-3 py-2 text-xs"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="truncate text-cyan-100" title={order.name}>
                                            {order.name}
                                        </div>
                                        <div className="mt-0.5 truncate text-[10px] text-slate-500" title={order.id}>
                                            {order.id}
                                        </div>
                                    </div>
                                    <span className="shrink-0 text-[10px] text-slate-500">
                                        订单
                                    </span>
                                </div>
                                <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-slate-400">
                                    <span>总量 {order.totalTons > 0 ? `${order.totalTons} 吨` : '--'}</span>
                                    <span className="text-right">已派 {order.dispatchedVehicles} 辆</span>
                                </div>
                            </div>
                        ))}
                        </div>
                    </AutoScrollList>
                </div>
            </Panel>
        </>
    );
}

function RoadGroupRightPanels({ roadGroup }: { roadGroup: RoadGroupPanelState }) {
    const routes = roadGroup.routes;
    const finishedRoutes = routes.filter((route) => route.status === '已完成' || route.status === 'finished');
    const unfinishedRoutes = routes.filter((route) => !(route.status === '已完成' || route.status === 'finished'));
    const sortedUnfinished = [...unfinishedRoutes].sort((a, b) => routeProgress(b) - routeProgress(a));
    const visibleUnfinished = sortedUnfinished.slice(0, 40);
    const shouldAutoScroll = visibleUnfinished.length > 4;
    const recentFinished = finishedRoutes.slice(-4);

    const renderRouteCard = (route: RouteOrder, keySuffix = '') => {
        const progress = routeProgress(route);
        const tones = [
            { border: 'border-l-sky-300', plate: 'text-sky-100', dot: 'bg-sky-300', glow: 'shadow-sky-950/30' },
            { border: 'border-l-amber-300', plate: 'text-amber-100', dot: 'bg-amber-300', glow: 'shadow-amber-950/30' },
            { border: 'border-l-emerald-300', plate: 'text-emerald-100', dot: 'bg-emerald-300', glow: 'shadow-emerald-950/30' },
            { border: 'border-l-rose-300', plate: 'text-rose-100', dot: 'bg-rose-300', glow: 'shadow-rose-950/30' },
        ];
        const toneIndex = Array.from(route.lineId).reduce((sum, char) => sum + char.charCodeAt(0), 0) % tones.length;
        const tone = tones[toneIndex];
        return (
            <div
                key={`${route.lineId}${keySuffix}`}
                className={`rounded border border-white/10 border-l-2 ${tone.border} bg-slate-900/82 px-3 py-3 text-xs shadow-lg ${tone.glow}`}
            >
                <div className="flex items-center justify-between gap-2">
                    <span className={`flex min-w-0 items-center gap-2 truncate text-sm font-semibold ${tone.plate}`} title={route.plate}>
                        <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot} shadow-[0_0_9px_currentColor]`} />
                        {route.plate}
                    </span>
                    <span className="rounded border border-emerald-300/25 bg-emerald-300/8 px-2 py-0.5 text-[10px] text-emerald-200">
                        {route.status}
                    </span>
                </div>
                <div className="mt-2 truncate text-[11px] text-slate-300" title={`${route.from} → ${route.to}`}>
                    {route.from} → {route.to}
                </div>
                <div className="mt-3 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-950/90 ring-1 ring-white/5">
                        <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-sky-400 to-emerald-300 shadow-[0_0_10px_rgba(34,211,238,0.45)] transition-all duration-500" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="w-20 text-right text-[10px] tabular-nums text-slate-400">
                        {routeDistanceText(route, progress)}
                    </span>
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
                    <span>{routeEtaText(route, progress)}</span>
                    <span>
                        {Number.isFinite(Number(routeDisplayData(route).speedKmh))
                            ? `${Math.round(Number(routeDisplayData(route).speedKmh))} km/h`
                            : '-- km/h'}
                    </span>
                </div>
            </div>
        );
    };

    return (
        <Panel title="组内车辆" className="h-full min-h-0">
            <div className="flex h-full min-h-0 flex-col">
                <div className="flex min-h-0 flex-1 flex-col">
                    <AutoScrollList
                        enabled={shouldAutoScroll}
                        resetKey={`${roadGroup.groupId ?? 'none'}-${visibleUnfinished.length}`}
                    >
                        <div className="space-y-2">
                            {visibleUnfinished.map((route) => renderRouteCard(route))}
                        </div>
                    </AutoScrollList>
                </div>

                <div className="shrink-0 overflow-hidden border-t border-cyan-400/20 bg-cyan-400/5 px-2 py-2">
                    {recentFinished.length > 0 ? (
                        <div className="space-y-1">
                            <div className="mb-1 text-xs font-semibold text-cyan-300">已完成车辆</div>
                            {recentFinished.map((route) => (
                                <div
                                    key={`finished-${route.lineId}`}
                                    className="flex items-center justify-between gap-2 rounded border border-emerald-300/10 bg-emerald-300/5 px-2 py-1 text-xs"
                                >
                                    <span className="truncate font-medium text-cyan-200" title={route.plate}>{route.plate}</span>
                                    <span className="truncate text-[11px] text-slate-400" title={`${route.from} → ${route.to}`}>
                                        {route.from} → {route.to}
                                    </span>
                                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-300"><span aria-hidden="true">✓</span>完成</span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="mt-2 text-center text-xs text-slate-500">
                            暂无完成车辆
                        </div>
                    )}
                </div>
            </div>
        </Panel>
    );
}

function DashboardSidePanels({
    mode,
    warehouseFocus,
    roadGroup,
    roadPanelVariant = 'aggregate',
    isRoadGroupFading = false,
}: DashboardSidePanelsProps) {
    const visible = mode !== 'hidden';
    const isWarehouseMode = mode === 'warehouse_focus';
    const {
        displayRoadGroup,
        transitionKey,
        isHoldingPreviousRoadGroup,
    } = useRoadGroupPanelTransition(roadGroup, isRoadGroupFading);

    const panelWidthClass = isWarehouseMode
        ? 'w-[19%] min-w-[230px] max-w-[320px]'
        : 'w-[23%] min-w-[280px] max-w-[420px]';
    const roadPanelTransitionClass = isHoldingPreviousRoadGroup ? 'translate-y-1 opacity-60' : 'translate-y-0 opacity-100';

    return (
        <div className={`pointer-events-none absolute inset-y-20 left-4 right-4 z-30 flex justify-between gap-4 transition-all duration-500 ${visible ? 'opacity-100' : 'opacity-0'}`}>
            <div className={`${visible ? 'pointer-events-auto translate-x-0' : 'pointer-events-none -translate-x-4'} flex min-h-0 ${panelWidthClass} flex-col gap-3 transition-transform duration-500`}>
                {mode === 'warehouse_focus' && warehouseFocus && <WarehouseLeftPanels focus={warehouseFocus} />}
                {mode === 'road_group_focus' && displayRoadGroup && (
                    <div className={`flex min-h-0 flex-1 flex-col gap-3 transition-all duration-500 ${roadPanelTransitionClass}`}>
                        <div key={`left-${transitionKey}`} className="flex min-h-0 flex-1 flex-col gap-3">
                            <RoadGroupLeftPanels roadGroup={displayRoadGroup} variant={roadPanelVariant} />
                        </div>
                    </div>
                )}
            </div>
            <div className={`${visible ? 'pointer-events-auto translate-x-0' : 'pointer-events-none translate-x-4'} flex min-h-0 ${panelWidthClass} flex-col gap-3 transition-transform duration-500`}>
                {mode === 'warehouse_focus' && warehouseFocus && <WarehouseRightPanels focus={warehouseFocus} />}
                {mode === 'road_group_focus' && displayRoadGroup && (
                    <div className={`flex min-h-0 flex-1 flex-col transition-all duration-500 ${roadPanelTransitionClass}`}>
                        <div key={`right-${transitionKey}`} className="flex min-h-0 flex-1 flex-col">
                            <RoadGroupRightPanels roadGroup={displayRoadGroup} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default DashboardSidePanels;
