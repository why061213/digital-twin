import Panel from '@/components/Layout/Panel';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RouteOrder } from '../hooks/useDashboardRealtime';

type VehicleScheduleProps = {
    routeOrders: RouteOrder[];
};

const fallbackOrders: RouteOrder[] = [
    {
        lineId: 'preview-1',
        plate: '粤A·HQ7832',
        cargo: '铝锭',
        from: '佛山市',
        to: '上海市',
        fromCoords: [113.121416, 23.021548],
        toCoords: [121.4737, 31.2304],
        status: '装载中',
    },
    {
        lineId: 'preview-2',
        plate: '湘E·LA4512',
        cargo: '铜材',
        from: '北京市',
        to: '深圳市',
        fromCoords: [116.4074, 39.9042],
        toCoords: [114.0579, 22.5431],
        status: '待装载',
    },
];

function RouteCell({ from, to }: { from: string; to: string }) {
    const value = `${from} —— ${to}`;
    const cellRef = useRef<HTMLSpanElement>(null);
    const trackRef = useRef<HTMLSpanElement>(null);
    const [scrollDistance, setScrollDistance] = useState(0);

    useEffect(() => {
        const measure = () => {
            const cell = cellRef.current;
            const track = trackRef.current;
            if (!cell || !track) return;
            setScrollDistance(Math.max(0, track.scrollWidth - cell.clientWidth + 16));
        };

        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [value]);

    return (
        <span ref={cellRef} className="route-cell text-sky-300" title={value}>
            <span
                ref={trackRef}
                className={scrollDistance > 0 ? 'route-cell-track' : ''}
                style={{ '--route-scroll-distance': `${scrollDistance}px` } as CSSProperties}
            >
                {value}
            </span>
        </span>
    );
}

function VehicleSchedule({ routeOrders }: VehicleScheduleProps) {
    const rows = routeOrders.length > 0 ? routeOrders : fallbackOrders;

    return (
        <Panel title="车辆调度">
            <div className="flex flex-col h-full">
                <div className="grid grid-cols-[1.5fr_1fr_1.7fr_1fr] gap-1 text-xs text-gray-400 pb-1 border-b border-white/5 mb-2">
                    <span>车牌号</span>
                    <span>货物</span>
                    <span>起点——目的地</span>
                    <span>状态</span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-1">
                    {rows.map((item) => (
                        <div
                            key={item.lineId}
                            className="grid grid-cols-[1.5fr_1fr_1.7fr_1fr] gap-1 text-xs text-gray-200 py-1.5 px-1 rounded-sm border border-white/0 border-b-white/5 bg-cyan-300/[0.025] hover:border-cyan-300/20 hover:bg-cyan-300/[0.06] transition-colors"
                        >
                            <span className="text-cyan-300/80 truncate" title={item.plate}>{item.plate}</span>
                            <span className="truncate" title={item.cargo}>{item.cargo}</span>
                            <RouteCell from={item.from} to={item.to} />
                            <span className={`inline-flex items-center justify-center rounded-sm border px-1.5 ${
                                item.status === '装载中' || item.status === '运输中'
                                    ? 'text-green-300 bg-green-400/10 border-green-300/20'
                                    : 'text-orange-300 bg-orange-400/10 border-orange-300/20'
                            }`}>
                                {item.status}
                            </span>
                        </div>
                    ))}
                </div>

                <div className="pt-2 mt-1 border-t border-white/5 text-xs text-gray-400 flex justify-between">
                    <span>已用车辆: 24</span>
                    <span>空闲车辆: 8</span>
                </div>
            </div>
        </Panel>
    );
}

export default VehicleSchedule;
