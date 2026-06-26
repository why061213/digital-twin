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
        plate: '\u7ca4A\u00b7HQ7832',
        cargo: '\u94dd\u952d',
        from: '\u4f5b\u5c71\u5e02',
        to: '\u4e0a\u6d77\u5e02',
        status: '\u88c5\u8f7d\u4e2d',
    },
    {
        lineId: 'preview-2',
        plate: '\u6e58E\u00b7LA4512',
        cargo: '\u94dc\u6750',
        from: '\u5317\u4eac\u5e02',
        to: '\u6df1\u5733\u5e02',
        status: '\u5f85\u88c5\u8f7d',
    },
];

function RouteCell({ from, to }: { from: string; to: string }) {
    const value = `${from} \u2014\u2014 ${to}`;
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
        <Panel title="\u8f66\u8f86\u8c03\u5ea6">
            <div className="flex flex-col h-full">
                <div className="grid grid-cols-[1.5fr_1fr_1.7fr_1fr] gap-1 text-xs text-gray-400 pb-1 border-b border-white/5 mb-2">
                    <span>\u8f66\u724c\u53f7</span>
                    <span>\u8d27\u7269</span>
                    <span>\u8d77\u70b9\u2014\u2014\u76ee\u7684\u5730</span>
                    <span>\u72b6\u6001</span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-1">
                    {rows.map((item) => (
                        <div
                            key={item.lineId}
                            className="grid grid-cols-[1.5fr_1fr_1.7fr_1fr] gap-1 text-xs text-gray-200 py-1.5 border-b border-white/5 last:border-0"
                        >
                            <span className="text-cyan-300/80 truncate" title={item.plate}>{item.plate}</span>
                            <span className="truncate" title={item.cargo}>{item.cargo}</span>
                            <RouteCell from={item.from} to={item.to} />
                            <span className={item.status === '\u88c5\u8f7d\u4e2d' || item.status === '\u8fd0\u8f93\u4e2d' ? 'text-green-400' : 'text-orange-400'}>
                                {item.status}
                            </span>
                        </div>
                    ))}
                </div>

                <div className="pt-2 mt-1 border-t border-white/5 text-xs text-gray-400 flex justify-between">
                    <span>\u5df2\u7528\u8f66\u8f86: 24</span>
                    <span>\u7a7a\u95f2\u8f66\u8f86: 8</span>
                </div>
            </div>
        </Panel>
    );
}

export default VehicleSchedule;
