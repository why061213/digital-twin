import { useEffect, useState } from 'react';
import DigitalFlop from '@/components/DigitalFlop/DigitalFlop';
import { API_BASE_URL } from '../constants';

type DailyOrderStatistics = {
    businessDate: string;
    deliveryTotalTons: number;
    dispatchedVehicleCount: number;
    totalOrderCount: number;
    completedOrderCount: number;
    windowStartedAt?: string;
    lastUpdatedAt?: string | null;
};

const EMPTY_STATISTICS: DailyOrderStatistics = {
    businessDate: '',
    deliveryTotalTons: 0,
    dispatchedVehicleCount: 0,
    totalOrderCount: 0,
    completedOrderCount: 0,
};

function KpiCards() {
    const [statistics, setStatistics] = useState<DailyOrderStatistics>(EMPTY_STATISTICS);

    useEffect(() => {
        let disposed = false;
        let activeController: AbortController | null = null;
        let midnightTimer: number | null = null;

        const loadStatistics = async () => {
            activeController?.abort();
            const controller = new AbortController();
            activeController = controller;
            try {
                const response = await fetch(`${API_BASE_URL}/dashboard/daily-kpis`, {
                    signal: controller.signal,
                });
                if (!response.ok) {
                    throw new Error(`Daily KPI request failed: ${response.status}`);
                }
                const data = await response.json() as DailyOrderStatistics;
                if (!disposed) setStatistics(data);
            } catch (error) {
                if (!disposed && !controller.signal.aborted) {
                    console.warn('[Dashboard KPI] load failed', error);
                }
            }
        };

        const scheduleMidnightReset = () => {
            const now = new Date();
            const nextMidnight = new Date(now);
            nextMidnight.setHours(24, 0, 1, 0);
            midnightTimer = window.setTimeout(() => {
                setStatistics(EMPTY_STATISTICS);
                void loadStatistics();
                scheduleMidnightReset();
            }, nextMidnight.getTime() - now.getTime());
        };

        void loadStatistics();
        const pollTimer = window.setInterval(() => void loadStatistics(), 30_000);
        scheduleMidnightReset();

        return () => {
            disposed = true;
            activeController?.abort();
            window.clearInterval(pollTimer);
            if (midnightTimer !== null) window.clearTimeout(midnightTimer);
        };
    }, []);

    const kpiData = [
        { label: '当日配送总量', value: statistics.deliveryTotalTons, unit: '吨' },
        { label: '派发车辆数量', value: statistics.dispatchedVehicleCount, unit: '辆' },
        { label: '总订单量', value: statistics.totalOrderCount, unit: '单' },
        { label: '已完成订单', value: statistics.completedOrderCount, unit: '单' },
    ];

    return (
        <div className="flex h-full items-center gap-8">
            {kpiData.map((item) => (
                <div key={item.label} className="flex min-w-[100px] flex-col items-center">
                    <span className="mb-1 text-xs tracking-widest text-cyan-400/60">{item.label}</span>
                    <DigitalFlop value={item.value} unit={item.unit} />
                    <div className="mt-1 h-0.5 w-8 bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
                </div>
            ))}
        </div>
    );
}

export default KpiCards;
