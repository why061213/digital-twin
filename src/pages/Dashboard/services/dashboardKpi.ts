export const DAILY_KPI_EVENT = 'dashboard:daily-kpis';

export type DailyOrderStatistics = {
    businessDate: string;
    deliveryTotalTons: number;
    dispatchedVehicleCount: number;
    totalOrderCount: number;
    arrivedVehicleCount: number;
    revision: number;
    windowStartedAt?: string;
    lastUpdatedAt?: string | null;
};

export function isDailyOrderStatistics(value: unknown): value is DailyOrderStatistics {
    if (!value || typeof value !== 'object') return false;
    const data = value as Partial<DailyOrderStatistics>;
    return typeof data.businessDate === 'string'
        && Number.isFinite(data.deliveryTotalTons)
        && Number.isInteger(data.dispatchedVehicleCount)
        && Number.isInteger(data.totalOrderCount)
        && Number.isInteger(data.arrivedVehicleCount)
        && Number.isInteger(data.revision);
}
