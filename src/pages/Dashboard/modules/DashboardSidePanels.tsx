import Panel from '@/components/Layout/Panel';
import EChart from '@/components/Charts/EChart';
import type { EChartsOption } from 'echarts';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { RouteOrder, TripStop } from '../hooks/useDashboardRealtime';
import { routeColorKey, routeTone } from './routePresentation';
import { resolveVehicleAlarmSeverity } from './vehicleAlertRipples';
import { tripBusinessStage } from '../playback/rm2RouteIdentity';

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
    onActiveVehicleChange?: (lineId: string | null) => void;
};

type RouteDisplayData = RouteOrder & {
    progress?: unknown;
    pathLength?: unknown;
    calibratedDistance?: unknown;
    routeLengthKm?: unknown;
    fallbackDuration?: unknown;
    speedKmh?: unknown;
    orderId?: unknown;
    orderTotalTons?: unknown;
    orderName?: unknown;
    pathKey?: unknown;
};

const WEIGHT_ONLY_PATTERN = /^\s*\d+(?:\.\d+)?\s*(?:吨|t|kg|千克|公斤)\s*$/i;
const PROVINCE_PREFIX_PATTERN = /^(北京市|天津市|上海市|重庆市|内蒙古自治区|广西壮族自治区|西藏自治区|宁夏回族自治区|新疆维吾尔自治区|香港特别行政区|澳门特别行政区|[^省\s]{2,8}省)/;
const CITY_PREFIX_PATTERN = /^(.{2,12}?(?:自治州|地区|盟|市))/;

function routeDisplayData(route: RouteOrder): RouteDisplayData {
    return route as RouteDisplayData;
}

function compactPositionAddress(address?: string) {
    if (!address) return '--';
    const segments = address.split(/[\s,，]+/).map((part) => part.trim()).filter(Boolean);
    return segments[segments.length - 1] ?? address;
}

function splitAdministrativeAddress(address?: string) {
    const fullAddress = address?.trim() || '--';
    if (fullAddress === '--') return { region: '--', detail: '--', fullAddress };

    let remaining = fullAddress;
    const regionParts: string[] = [];
    const province = remaining.match(PROVINCE_PREFIX_PATTERN)?.[1];
    if (province) {
        regionParts.push(province);
        remaining = remaining.slice(province.length).trim();
    }

    const provinceActsAsCity = province?.endsWith('市') || province?.endsWith('特别行政区');
    const city = provinceActsAsCity ? undefined : remaining.match(CITY_PREFIX_PATTERN)?.[1];
    if (city) {
        regionParts.push(city);
        remaining = remaining.slice(city.length).trim();
    }

    return {
        region: regionParts.join(' · ') || '--',
        detail: remaining || fullAddress,
        fullAddress,
    };
}

function detailedDirection(directionDeg?: number, providerLabel?: string) {
    if (!Number.isFinite(directionDeg)) return providerLabel || '--';
    const normalized = ((Number(directionDeg) % 360) + 360) % 360;
    const labels = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    const nearestIndex = Math.round(normalized / 45) % labels.length;
    const nearestAngle = nearestIndex * 45;
    const deviation = Math.abs(((normalized - nearestAngle + 540) % 360) - 180);
    return `${labels[nearestIndex]} · ${Math.round(normalized)}°（偏差 ${Math.round(deviation)}°）`;
}

function routeCargoContent(route?: RouteOrder) {
    const cargo = route?.cargo?.trim();
    if (!cargo || WEIGHT_ONLY_PATTERN.test(cargo)) return '--';
    return cargo;
}

function routeCargoWeight(route?: RouteOrder) {
    const cargoWeight = Number(route?.cargoWeight);
    if (Number.isFinite(cargoWeight) && cargoWeight > 0) {
        return `${cargoWeight.toLocaleString()} ${route?.cargoUnit?.trim() || '吨'}`;
    }
    const totalTons = Number(route?.orderTotalTons);
    if (Number.isFinite(totalTons) && totalTons > 0) return `${totalTons.toLocaleString()} 吨`;
    const cargo = route?.cargo?.trim();
    return cargo && WEIGHT_ONLY_PATTERN.test(cargo) ? cargo : '--';
}

function coordinateText(position?: [number, number]) {
    if (!position || !position.every(Number.isFinite)) return '--';
    return `${position[0].toFixed(6)}, ${position[1].toFixed(6)}`;
}

function combinedVehicleState(route?: RouteOrder) {
    const state = route?.stateStr?.trim() || '';
    const alarm = route?.alarmStr?.trim() || '';
    if (!alarm) return state || '--';
    if (state.includes(alarm)) return state;
    return `${state || '状态未知'} · 报警：${alarm}`;
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

function routeRemainingText(route: RouteOrder, progress: number) {
    const totalKm = Number(route.routeLengthKm);
    const distance = Number.isFinite(totalKm)
        ? `${Math.max(0, totalKm * (1 - progress / 100)).toFixed(1)} km`
        : '-- km';
    const totalDurationMs = Number(route.travelDurationMs);
    if (!Number.isFinite(totalDurationMs) || totalDurationMs <= 0) return `剩余 ${distance}`;
    const navigationMinutes = Math.max(1, Math.round(totalDurationMs / 60_000));
    const hours = Math.floor(navigationMinutes / 60);
    const minutes = navigationMinutes % 60;
    const duration = hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
    return `剩余 ${distance} · 导航预计 ${duration}`;
}

function orderedTripStops(route: RouteOrder) {
    const stops = route.tripStops ?? [];
    return [...stops].sort((left, right) => {
        const actionDifference = (left.action === 'PICKUP' ? 0 : 1)
            - (right.action === 'PICKUP' ? 0 : 1);
        return actionDifference || left.sequence - right.sequence || left.stopId.localeCompare(right.stopId);
    });
}

function stopStateLabel(stop: TripStop) {
    if (stop.visitState === 'VISITED') return '已完成';
    if (stop.visitState === 'ARRIVED') return '已到达';
    if (stop.visitState === 'DWELLING') return stop.action === 'PICKUP' ? '装载中' : '卸货中';
    if (stop.currentTarget) return '当前目标';
    return '待执行';
}

function TripMilestoneProgress({
    stops,
    progress,
    accent,
}: {
    stops: TripStop[];
    progress: number;
    accent: string;
}) {
    return (
        <div className="mt-3 rounded border border-white/8 bg-slate-950/45 px-2.5 py-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium tracking-wide text-slate-400">运输里程碑</span>
                <span className="text-[10px] tabular-nums text-slate-300">当前路段 {progress}%</span>
            </div>
            <div className="space-y-0">
                {stops.map((stop, index) => {
                    const completed = stop.visitState === 'VISITED';
                    const active = stop.currentTarget || stop.visitState === 'ARRIVED' || stop.visitState === 'DWELLING';
                    const address = splitAdministrativeAddress(stop.locationName ?? undefined);
                    const dotColor = completed ? '#34d399' : active ? accent : '#475569';
                    return (
                        <div key={stop.stopId} className="relative grid min-h-9 grid-cols-[14px_54px_minmax(0,1fr)_42px] items-start gap-1.5">
                            {index < stops.length - 1 && (
                                <span
                                    aria-hidden="true"
                                    className="absolute left-[5px] top-[13px] h-[calc(100%-2px)] w-px"
                                    style={{ backgroundColor: completed ? '#34d399' : 'rgba(71,85,105,0.7)' }}
                                />
                            )}
                            <span
                                aria-hidden="true"
                                className={`relative z-10 mt-1 h-[11px] w-[11px] rounded-full border-2 ${active ? 'motion-safe:animate-pulse' : ''}`}
                                style={{
                                    borderColor: dotColor,
                                    backgroundColor: completed || active ? dotColor : '#0f172a',
                                    boxShadow: active ? `0 0 9px ${dotColor}` : undefined,
                                }}
                            />
                            <span className={`pt-0.5 text-[10px] ${stop.action === 'PICKUP' ? 'text-sky-300' : 'text-rose-300'}`}>
                                {stop.action === 'PICKUP' ? `装载 ${stop.sequence}` : `送达 ${stop.sequence}`}
                            </span>
                            <span className="min-w-0 truncate pt-0.5 text-[10px] text-slate-300" title={address.fullAddress}>
                                {address.detail || address.region}
                            </span>
                            <span className={`pt-0.5 text-right text-[9px] ${completed ? 'text-emerald-300' : active ? 'text-cyan-200' : 'text-slate-600'}`}>
                                {stopStateLabel(stop)}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function OverflowMarquee({
    value,
    className = '',
}: {
    value: string | number | null | undefined;
    className?: string;
}) {
    const text = String(value ?? '--');
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLSpanElement | null>(null);
    const [scrollDistance, setScrollDistance] = useState(0);

    useLayoutEffect(() => {
        const viewport = viewportRef.current;
        const content = contentRef.current;
        if (!viewport || !content) return;

        const measure = () => {
            const overflow = content.scrollWidth - viewport.clientWidth;
            setScrollDistance(overflow > 1 ? Math.ceil(overflow + 12) : 0);
        };
        measure();

        const observer = new ResizeObserver(measure);
        observer.observe(viewport);
        observer.observe(content);
        return () => observer.disconnect();
    }, [text]);

    const durationSeconds = Math.max(7, Math.min(22, 5 + scrollDistance / 20));
    const style = {
        '--overflow-marquee-distance': `${scrollDistance}px`,
        '--overflow-marquee-duration': `${durationSeconds}s`,
    } as CSSProperties;

    return (
        <div
            ref={viewportRef}
            className={`overflow-marquee ${scrollDistance > 0 ? 'is-overflowing' : ''} ${className}`}
            title={text}
        >
            <span className="overflow-marquee__track" style={style}>
                <span ref={contentRef} className="overflow-marquee__content">{text}</span>
            </span>
        </div>
    );
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
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const shouldLoop = enabled || isOverflowing;

    useLayoutEffect(() => {
        const container = scrollRef.current;
        const content = contentRef.current;
        if (!container || !content) return;

        const updateOverflow = () => {
            setIsOverflowing(content.scrollHeight > container.clientHeight + 1);
        };
        updateOverflow();

        const observer = new ResizeObserver(updateOverflow);
        observer.observe(container);
        observer.observe(content);
        return () => observer.disconnect();
    }, [children, resetKey]);

    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;
        container.scrollTop = 0;
        if (!shouldLoop) return;

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
    }, [resetKey, shouldLoop, speedPxPerSecond]);

    return (
        <div ref={scrollRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
            <div ref={contentRef} className={shouldLoop ? 'pb-2' : undefined}>{children}</div>
            {shouldLoop && <div aria-hidden="true" className="pb-2">{children}</div>}
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

function VehicleTransportDetails({
    roadGroup,
    activeVehicleLineId,
    onVehicleSelect,
    onActiveVehicleChange,
}: {
    roadGroup: RoadGroupPanelState;
    activeVehicleLineId: string | null;
    onVehicleSelect: (lineId: string) => void;
    onActiveVehicleChange?: (lineId: string | null) => void;
}) {
    const { runningRoutes, detailRoutes } = useMemo(() => {
        const running = roadGroup.routes.filter((route) => (
            route.status !== '已完成' && route.status !== 'finished'
        ));
        const finished = roadGroup.routes.filter((route) => (
            route.status === '已完成' || route.status === 'finished'
        ));
        return {
            runningRoutes: running,
            detailRoutes: [...running, ...finished],
        };
    }, [roadGroup.routes]);
    const detailRouteIds = detailRoutes.map((route) => route.lineId).join('\u0000');
    const selectedIndex = detailRoutes.findIndex((route) => route.lineId === activeVehicleLineId);
    const targetIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const targetRoute = detailRoutes[targetIndex];
    const targetTone = routeTone(targetRoute, roadGroup.routes);
    const fromAddress = splitAdministrativeAddress(targetRoute?.from);
    const toAddress = splitAdministrativeAddress(targetRoute?.to);
    const targetSeverity = resolveVehicleAlarmSeverity({
        alarmStr: targetRoute?.alarmStr,
        alarmSeverity: targetRoute?.alarmSeverity,
        stateStr: targetRoute?.stateStr,
        online: targetRoute?.online,
    });
    const stateTone = targetSeverity === 'critical'
        ? 'text-red-300'
        : targetSeverity === 'warning'
            ? 'text-orange-300'
            : 'text-emerald-100';

    useEffect(() => {
        onActiveVehicleChange?.(targetRoute?.lineId ?? null);
    }, [onActiveVehicleChange, targetRoute?.lineId]);

    useEffect(() => () => {
        onActiveVehicleChange?.(null);
    }, [onActiveVehicleChange]);

    useEffect(() => {
        // 组内只有一辆活跃车（或无活跃车）时，不尝试自动切换车辆
        if (runningRoutes.length <= 1) return;
        const timer = window.setInterval(() => {
            const routeLineIds = detailRouteIds.split('\u0000').filter(Boolean);
            const nextIndex = (targetIndex + 1) % routeLineIds.length;
            onVehicleSelect(routeLineIds[nextIndex]);
        }, 15_000);
        return () => window.clearInterval(timer);
    }, [activeVehicleLineId, detailRouteIds, detailRoutes.length, onVehicleSelect, runningRoutes.length, targetIndex]);

    return (
        <Panel title="车辆运输详情" className="h-full min-h-0">
            <div key={targetRoute?.lineId ?? 'empty'} className="vehicle-detail-swap flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
                <div
                    className="flex items-center justify-between gap-3 rounded border border-white/10 border-l-2 px-3 py-3 shadow-lg"
                    style={{
                        borderLeftColor: targetTone.color,
                        backgroundColor: targetTone.surface,
                        boxShadow: `0 10px 20px ${targetTone.glow}`,
                    }}
                >
                    <div className="min-w-0">
                        <div className="text-[10px] text-slate-400">当前展示车辆</div>
                        <div className="mt-1 flex min-w-0 items-center gap-2 truncate text-lg font-semibold" style={{ color: targetTone.color }} title={targetRoute?.plate || '--'}>
                            <span
                                className="h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: targetTone.color, boxShadow: `0 0 10px ${targetTone.color}` }}
                            />
                            <span className="truncate">{targetRoute?.plate || '--'}</span>
                        </div>
                        <OverflowMarquee
                            value={`订单 ${targetRoute?.orderId || '--'}`}
                            className="mt-1 max-w-52 text-[9px] tabular-nums text-slate-500"
                        />
                    </div>
                    <div className="shrink-0 text-right">
                        <div className="text-[10px] tabular-nums text-slate-500">
                            {detailRoutes.length > 0 ? `${targetIndex + 1} / ${detailRoutes.length}` : '0 / 0'}
                        </div>
                        <div className="mt-1 rounded border border-emerald-300/25 bg-emerald-300/8 px-2 py-0.5 text-[10px] text-emerald-200">
                            {targetRoute ? tripBusinessStage(targetRoute) : '等待数据'}
                        </div>
                    </div>
                </div>

                <div className="no-scrollbar mt-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto rounded border border-white/8 bg-slate-900/55 px-3 py-3">
                    <div className="mb-3 grid min-w-0 grid-cols-2 gap-2">
                        <div className="min-w-0 rounded border border-white/8 bg-white/[0.025] px-2.5 py-2">
                            <div className="text-[9px] text-slate-500">始发省市</div>
                            <OverflowMarquee value={fromAddress.region} className="mt-1 text-[11px] font-medium text-slate-300" />
                        </div>
                        <div className="min-w-0 rounded border border-emerald-300/25 bg-emerald-300/[0.07] px-2.5 py-2 shadow-[inset_0_0_18px_rgba(52,211,153,0.04)]">
                            <div className="flex items-center justify-between gap-2 text-[9px] text-emerald-200/65">
                                <span>目的省市</span>
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]" />
                            </div>
                            <OverflowMarquee value={toAddress.region} className="mt-1 text-xs font-semibold text-emerald-100" />
                        </div>
                    </div>
                    <div className="grid min-w-0 shrink-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-3 overflow-hidden">
                        <div className="flex h-[6rem] flex-col items-center py-1">
                            <span className="h-2.5 w-2.5 rounded-full border-2 border-sky-200 bg-sky-500 shadow-[0_0_10px_rgba(56,189,248,0.7)]" />
                            <span className="my-0.5 min-h-2 w-px flex-1 bg-gradient-to-b from-sky-300/70 to-emerald-300/70" />
                            <span className="h-2.5 w-2.5 rounded-full border-2 border-emerald-200 bg-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.65)]" />
                        </div>
                        <div className="grid h-[6rem] min-w-0 grid-rows-2 gap-1 overflow-hidden">
                            <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded border border-sky-300/10 bg-sky-300/[0.025] px-2.5 opacity-80">
                                <div className="shrink-0 text-[10px] text-slate-500">起点</div>
                                <OverflowMarquee value={fromAddress.detail} className="min-w-0 flex-1 text-xs font-medium leading-6 text-slate-300" />
                            </div>
                            <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded border border-emerald-300/15 bg-emerald-300/[0.045] px-2.5">
                                <div className="shrink-0 text-[10px] font-medium text-emerald-300/70">目的地</div>
                                <OverflowMarquee value={toAddress.detail || toAddress.fullAddress} className="min-w-0 flex-1 text-xs font-semibold leading-6 text-emerald-50" />
                            </div>
                        </div>
                    </div>
                    <div className="mt-3 grid min-w-0 grid-cols-[repeat(2,minmax(0,1fr))] gap-2 border-t border-white/8 pt-3 text-xs">
                        <div className="min-w-0 overflow-hidden rounded bg-white/[0.035] px-2.5 py-2">
                            <div className="text-[10px] text-slate-500">速度</div>
                            <div className="mt-1 font-semibold tabular-nums text-amber-100">
                                {Number.isFinite(Number(targetRoute?.speedKmh)) ? `${Math.round(Number(targetRoute?.speedKmh))} km/h` : '--'}
                            </div>
                        </div>
                        <div className="min-w-0 overflow-hidden rounded bg-white/[0.035] px-2.5 py-2">
                            <div className="text-[10px] text-slate-500">驾驶员</div>
                            <OverflowMarquee value={targetRoute?.driverName || '--'} className="mt-1 font-semibold text-sky-100" />
                        </div>
                        <div className="min-w-0 overflow-hidden rounded bg-white/[0.035] px-2.5 py-2">
                            <div className="text-[10px] text-slate-500">路线长度</div>
                            <div className="mt-1 font-semibold tabular-nums text-cyan-100">
                                {Number.isFinite(Number(targetRoute?.routeLengthKm)) ? `${Number(targetRoute?.routeLengthKm).toFixed(1)} km` : '--'}
                            </div>
                        </div>
                        <div className="min-w-0 overflow-hidden rounded bg-white/[0.035] px-2.5 py-2">
                            <div className="text-[10px] text-slate-500">重量</div>
                            <OverflowMarquee value={routeCargoWeight(targetRoute)} className="mt-1 font-semibold tabular-nums text-amber-100" />
                        </div>
                        <div className="min-w-0 overflow-hidden rounded bg-white/[0.035] px-2.5 py-2">
                            <div className="text-[10px] text-slate-500">货物内容</div>
                            <OverflowMarquee value={routeCargoContent(targetRoute)} className="mt-1 font-medium text-sky-100" />
                        </div>
                        <div className="min-w-0 overflow-hidden rounded bg-white/[0.035] px-2.5 py-2">
                            <div className="text-[10px] text-slate-500">经纬度</div>
                            <OverflowMarquee value={coordinateText(targetRoute?.currentPosition)} className="mt-1 font-medium tabular-nums text-slate-200" />
                        </div>
                        <div className="col-span-2 min-w-0 overflow-hidden rounded bg-white/[0.035] px-2.5 py-2">
                            <div className="text-[10px] text-slate-500">方向</div>
                            <OverflowMarquee
                                value={detailedDirection(targetRoute?.directionDeg, targetRoute?.directionLabel)}
                                className="mt-1 font-medium text-cyan-100"
                            />
                        </div>
                        <div className="col-span-2 min-w-0 overflow-hidden rounded bg-white/[0.035] px-2.5 py-2">
                            <div className="text-[10px] text-slate-500">当前位置</div>
                            <OverflowMarquee value={compactPositionAddress(targetRoute?.address)} className="mt-1 text-slate-200" />
                        </div>
                        <div className="col-span-2 min-w-0 overflow-hidden rounded bg-white/[0.035] px-2.5 py-2">
                            <div className="text-[10px] text-slate-500">车辆状态</div>
                            <OverflowMarquee value={combinedVehicleState(targetRoute)} className={`mt-1 leading-5 ${stateTone}`} />
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
    activeVehicleLineId,
    onVehicleSelect,
    onActiveVehicleChange,
}: {
    roadGroup: RoadGroupPanelState;
    variant: 'aggregate' | 'vehicle';
    activeVehicleLineId: string | null;
    onVehicleSelect: (lineId: string) => void;
    onActiveVehicleChange?: (lineId: string | null) => void;
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

    if (variant === 'vehicle') {
        return (
            <VehicleTransportDetails
                roadGroup={roadGroup}
                activeVehicleLineId={activeVehicleLineId}
                onVehicleSelect={onVehicleSelect}
                onActiveVehicleChange={onActiveVehicleChange}
            />
        );
    }

    return (
        <>
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

            <Panel title="组内订单" className="h-[56%] min-h-[320px]">
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

function RoadGroupRightPanels({
    roadGroup,
    variant,
    activeVehicleLineId,
    onVehicleSelect,
}: {
    roadGroup: RoadGroupPanelState;
    variant: 'aggregate' | 'vehicle';
    activeVehicleLineId: string | null;
    onVehicleSelect: (lineId: string) => void;
}) {
    const routes = roadGroup.routes;
    const finishedRoutes = routes.filter((route) => route.status === '已完成' || route.status === 'finished');
    const unfinishedRoutes = routes.filter((route) => !(route.status === '已完成' || route.status === 'finished'));
    const orderKeys = Array.from(new Set(routes.map(routeColorKey)));
    const orderRank = new Map(orderKeys.map((key, index) => [key, index]));
    const sortedUnfinished = [...unfinishedRoutes].sort((a, b) => {
        const orderDifference = (orderRank.get(routeColorKey(a)) ?? Number.MAX_SAFE_INTEGER)
            - (orderRank.get(routeColorKey(b)) ?? Number.MAX_SAFE_INTEGER);
        return orderDifference || routeProgress(b) - routeProgress(a);
    });
    const visibleUnfinished = sortedUnfinished.slice(0, 40);
    const shouldAutoScroll = visibleUnfinished.length >= 4;
    const recentFinished = finishedRoutes.slice(-4);
    const orderSummaries = variant === 'vehicle'
        ? buildOrderSummaries(routes, roadGroup.orderIds ?? []).slice(0, 3)
        : [];

    const renderRouteCard = (route: RouteOrder, keySuffix = '') => {
        const progress = routeProgress(route);
        const tone = routeTone(route, routes);
        const tripStops = orderedTripStops(route);
        const pickupStops = tripStops.filter((stop) => stop.action === 'PICKUP');
        const deliveryStops = tripStops.filter((stop) => stop.action === 'DELIVERY');
        const isCompositeTrip = new Set(tripStops.map((stop) => stop.orderInstanceId)).size > 1;
        const isSelected = variant === 'vehicle' && route.lineId === activeVehicleLineId;
        const fromAddress = splitAdministrativeAddress(route.from);
        const toAddress = splitAdministrativeAddress(route.to);
        const alarmSeverity = resolveVehicleAlarmSeverity({
            alarmStr: route.alarmStr,
            alarmSeverity: route.alarmSeverity,
            stateStr: route.stateStr,
            online: route.online,
        });
        const hasWarning = alarmSeverity === 'warning';
        const hasCriticalAlarm = alarmSeverity === 'critical';
        const alarmColor = hasCriticalAlarm ? '#fb7185' : hasWarning ? '#fb923c' : null;
        const alarmGlow = hasCriticalAlarm
            ? 'rgba(244,63,94,0.24)'
            : hasWarning ? 'rgba(249,115,22,0.18)' : null;
        const statusClass = hasCriticalAlarm
            ? 'border-red-300/35 bg-red-400/10 text-red-200'
            : hasWarning
                ? 'border-orange-300/35 bg-orange-400/10 text-orange-200'
                : 'border-emerald-300/25 bg-emerald-300/8 text-emerald-200';
        const alarmDescription = route.alarmStr || route.stateStr || '';
        return (
            <button
                type="button"
                key={`${route.lineId}${keySuffix}`}
                disabled={variant !== 'vehicle'}
                aria-pressed={variant === 'vehicle' ? isSelected : undefined}
                onClick={() => onVehicleSelect(route.lineId)}
                className={`relative w-full overflow-hidden rounded border border-l-2 px-3 py-3 text-left text-xs transition-[background-color,border-color,box-shadow] duration-200 ${
                    isSelected
                        ? 'border-white/20 bg-white/[0.045]'
                        : 'border-white/10 bg-slate-900/82'
                } ${variant === 'vehicle' ? 'cursor-pointer hover:border-white/20 hover:bg-slate-800/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70' : ''}`}
                style={{
                    borderLeftColor: tone.color,
                    borderTopColor: alarmColor ?? undefined,
                    borderRightColor: alarmColor ?? undefined,
                    borderBottomColor: alarmColor ?? undefined,
                    backgroundImage: alarmGlow
                        ? `linear-gradient(270deg, ${alarmGlow}, transparent 48%)`
                        : undefined,
                    boxShadow: [
                        isSelected ? `inset 0 0 0 1px ${tone.glow}, 0 3px 8px ${tone.glow}` : `0 2px 6px ${tone.glow}`,
                        alarmGlow ? `inset -2px 0 0 ${alarmColor}, 0 0 12px ${alarmGlow}` : '',
                    ].filter(Boolean).join(', '),
                }}
            >
                <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 truncate text-sm font-semibold" style={{ color: tone.color }} title={route.plate}>
                        <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: tone.color, boxShadow: `0 0 9px ${tone.color}` }}
                        />
                        {route.plate}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                        {hasCriticalAlarm && (
                            <span
                                className="flex items-center gap-1 rounded-sm border border-red-300/40 bg-red-400/12 px-1.5 py-0.5 text-[9px] font-semibold text-red-200"
                                title={alarmDescription}
                            >
                                <span className="h-1.5 w-1.5 rounded-full bg-red-300" />
                                严重报警
                            </span>
                        )}
                        {isSelected && (
                            <span
                                className="rounded-sm border px-1.5 py-0.5 text-[9px] font-medium"
                                style={{ borderColor: tone.glow, color: tone.color }}
                            >
                                当前
                            </span>
                        )}
                        <span className={`rounded border px-2 py-0.5 text-[10px] ${statusClass}`}>
                            {tripBusinessStage(route)}
                        </span>
                    </span>
                </div>
                <div className="mt-2 grid grid-cols-[minmax(0,0.8fr)_auto_minmax(0,1.2fr)] items-center gap-1.5 text-[11px]" title={isCompositeTrip ? tripStops.map((stop) => stop.locationName).filter(Boolean).join(' → ') : `${route.from} → ${route.to}`}>
                    <span className="truncate text-slate-500">
                        {isCompositeTrip ? `${pickupStops.length} 个装载点` : fromAddress.region}
                    </span>
                    <span className="text-slate-600">→</span>
                    <span className="truncate font-medium text-emerald-100">
                        {isCompositeTrip ? `${deliveryStops.length} 个目的地` : toAddress.detail || toAddress.region}
                    </span>
                </div>
                {isCompositeTrip ? (
                    <TripMilestoneProgress stops={tripStops} progress={progress} accent={tone.color} />
                ) : (
                    <div className="mt-3 flex items-center gap-2">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-950/90 ring-1 ring-white/5">
                            <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-sky-400 to-emerald-300 shadow-[0_0_10px_rgba(34,211,238,0.45)] transition-all duration-500" style={{ width: `${progress}%` }} />
                        </div>
                        <span className="w-10 text-right text-[10px] font-medium tabular-nums text-slate-300">
                            {progress}%
                        </span>
                    </div>
                )}
                <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-400">
                    <span className="min-w-0 truncate tabular-nums" title={routeRemainingText(route, progress)}>
                        {routeRemainingText(route, progress)}
                    </span>
                    <span className="tabular-nums">
                        {Number.isFinite(Number(routeDisplayData(route).speedKmh))
                            ? `${Math.round(Number(routeDisplayData(route).speedKmh))} km/h`
                            : '-- km/h'}
                    </span>
                </div>
            </button>
        );
    };

    return (
        <Panel title={variant === 'vehicle' ? '组内运输' : '组内车辆'} className="h-full min-h-0">
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

                {variant === 'vehicle' && orderSummaries.length > 0 && (
                    <div className="shrink-0 border-t border-sky-400/20 bg-sky-400/[0.035] px-2 py-2">
                        <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-sky-200">
                            <span>组内订单</span>
                            <span className="text-[10px] font-normal text-slate-500">{orderSummaries.length} 单</span>
                        </div>
                        <div className="space-y-1">
                            {orderSummaries.map((order) => (
                                <div key={`right-order-${order.id}`} className="flex items-center justify-between gap-2 rounded border border-white/8 bg-slate-900/65 px-2 py-1.5 text-[10px]">
                                    <div className="min-w-0">
                                        <div className="truncate text-sky-100" title={order.name}>{order.name}</div>
                                        <div className="truncate text-slate-500" title={order.id}>{order.id}</div>
                                    </div>
                                    <div className="shrink-0 text-right text-slate-400">
                                        <div>{order.totalTons > 0 ? `${order.totalTons} 吨` : '--'}</div>
                                        <div>{order.dispatchedVehicles} 辆</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className="shrink-0 overflow-hidden border-t border-cyan-400/20 bg-cyan-400/5 px-2 py-2">
                    {recentFinished.length > 0 ? (
                        <div className="space-y-1">
                            <div className="mb-1 text-xs font-semibold text-cyan-300">已完成车辆</div>
                            {recentFinished.map((route) => (
                                <button
                                    type="button"
                                    key={`finished-${route.lineId}`}
                                    disabled={variant !== 'vehicle'}
                                    aria-pressed={variant === 'vehicle' ? route.lineId === activeVehicleLineId : undefined}
                                    onClick={() => onVehicleSelect(route.lineId)}
                                    className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70 ${
                                        route.lineId === activeVehicleLineId
                                            ? 'border-white/20 bg-white/[0.045]'
                                            : 'border-emerald-300/10 bg-emerald-300/5'
                                    } ${variant === 'vehicle' ? 'cursor-pointer hover:bg-emerald-300/10' : ''}`}
                                >
                                    <span className="truncate font-medium text-cyan-200" title={route.plate}>{route.plate}</span>
                                    <span className="truncate text-[11px] text-slate-400" title={`${route.from} → ${route.to}`}>
                                        {route.from} → {route.to}
                                    </span>
                                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-300"><span aria-hidden="true">✓</span>完成</span>
                                </button>
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
    onActiveVehicleChange,
}: DashboardSidePanelsProps) {
    const [selectedVehicleLineId, setSelectedVehicleLineId] = useState<string | null>(null);
    const visible = mode !== 'hidden';
    const isWarehouseMode = mode === 'warehouse_focus';
    const {
        displayRoadGroup,
        transitionKey,
        isHoldingPreviousRoadGroup,
    } = useRoadGroupPanelTransition(roadGroup, isRoadGroupFading);
    const firstRunningVehicle = displayRoadGroup?.routes.find((route) => (
        route.status !== '已完成' && route.status !== 'finished'
    ));
    const activeVehicleLineId = displayRoadGroup?.routes.some((route) => route.lineId === selectedVehicleLineId)
        ? selectedVehicleLineId
        : firstRunningVehicle?.lineId ?? displayRoadGroup?.routes[0]?.lineId ?? null;

    const panelWidthClass = isWarehouseMode
        ? 'w-[19%] min-w-[230px] max-w-[320px]'
        : 'w-[23%] min-w-[280px] max-w-[420px]';
    const roadPanelTransitionClass = isHoldingPreviousRoadGroup ? 'translate-y-1 opacity-60' : 'translate-y-0 opacity-100';

    return (
        <div className={`pointer-events-none absolute inset-y-20 left-4 right-4 z-30 hidden justify-between gap-4 transition-all duration-500 lg:flex ${visible ? 'opacity-100' : 'opacity-0'}`}>
            <div className={`${visible ? 'pointer-events-auto translate-x-0' : 'pointer-events-none -translate-x-4'} flex min-h-0 ${panelWidthClass} flex-col gap-3 transition-transform duration-500`}>
                {mode === 'warehouse_focus' && warehouseFocus && <WarehouseLeftPanels focus={warehouseFocus} />}
                {mode === 'road_group_focus' && displayRoadGroup && (
                    <div className={`flex min-h-0 flex-1 flex-col gap-3 transition-all duration-500 ${roadPanelTransitionClass}`}>
                        <div key={`left-${transitionKey}`} className="flex min-h-0 flex-1 flex-col gap-3">
                            <RoadGroupLeftPanels
                                roadGroup={displayRoadGroup}
                                variant={roadPanelVariant}
                                activeVehicleLineId={activeVehicleLineId}
                                onVehicleSelect={setSelectedVehicleLineId}
                                onActiveVehicleChange={onActiveVehicleChange}
                            />
                        </div>
                    </div>
                )}
            </div>
            <div className={`${visible ? 'pointer-events-auto translate-x-0' : 'pointer-events-none translate-x-4'} flex min-h-0 ${panelWidthClass} flex-col gap-3 transition-transform duration-500`}>
                {mode === 'warehouse_focus' && warehouseFocus && <WarehouseRightPanels focus={warehouseFocus} />}
                {mode === 'road_group_focus' && displayRoadGroup && (
                    <div className={`flex min-h-0 flex-1 flex-col transition-all duration-500 ${roadPanelTransitionClass}`}>
                        <div key={`right-${transitionKey}`} className="flex min-h-0 flex-1 flex-col">
                            <RoadGroupRightPanels
                                roadGroup={displayRoadGroup}
                                variant={roadPanelVariant}
                                activeVehicleLineId={activeVehicleLineId}
                                onVehicleSelect={setSelectedVehicleLineId}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default DashboardSidePanels;
