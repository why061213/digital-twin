import { API_BASE_URL } from '../constants';
import type { RoadPathMessage, TruckPositionMessage } from '../hooks/useDashboardRealtime';
import type {
    RoadGroupRoutesResponse,
    RoadGroupsResponse,
    RoadGroupStrategy,
    RoadGroupSummary,
} from '../types';

export async function fetchRoadGroupsByStrategy(strategy: RoadGroupStrategy): Promise<RoadGroupSummary[]> {
    const response = await fetch(`${API_BASE_URL}/road/groups?strategy=${encodeURIComponent(strategy)}`);
    if (!response.ok) throw new Error(`Groups request failed: ${response.status}`);

    const data = await response.json() as RoadGroupsResponse;
    return data.groups ?? [];
}

export async function fetchRoadGroupRoutes(
    groupId: string,
    strategy: RoadGroupStrategy,
): Promise<RoadGroupRoutesResponse> {
    const response = await fetch(
        `${API_BASE_URL}/road/groups/${encodeURIComponent(groupId)}/routes?strategy=${encodeURIComponent(strategy)}`,
    );
    if (!response.ok) throw new Error(`Group routes request failed: ${response.status}`);

    return await response.json() as RoadGroupRoutesResponse;
}

export async function fetchTruckPosition(lineId: string): Promise<TruckPositionMessage> {
    const response = await fetch(`${API_BASE_URL}/road/routes/${encodeURIComponent(lineId)}/position`);
    if (!response.ok) throw new Error(`Position request failed: ${response.status}`);

    return await response.json() as TruckPositionMessage;
}

/** 当前展示组的低频批量校准；不穿透为逐车请求。 */
export async function fetchVehiclePositions(lineIds: string[]): Promise<TruckPositionMessage[]> {
    const uniqueLineIds = [...new Set(lineIds.filter(Boolean))];
    if (uniqueLineIds.length === 0) return [];
    const response = await fetch(`${API_BASE_URL}/road/vehicles/positions/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineIds: uniqueLineIds }),
    });
    if (!response.ok) throw new Error(`Vehicle positions request failed: ${response.status}`);
    const data = await response.json() as { positions?: unknown[] };
    return (data.positions ?? []).filter((value): value is TruckPositionMessage => {
        if (!value || typeof value !== 'object') return false;
        const item = value as Partial<TruckPositionMessage>;
        if (typeof item.lineId !== 'string') return false;
        // 已完成路线可能已经没有可返回的坐标，但完成状态本身必须交给运动层，
        // 否则前端会把到站车辆一直留在道路上。
        if (item.status === 'finished') return true;
        return Array.isArray(item.position)
            && item.position.length >= 2
            && item.position.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
    });
}

export async function dispatchRoute(): Promise<RoadPathMessage> {
    const response = await fetch(`${API_BASE_URL}/road/dispatch`, { method: 'POST' });
    if (!response.ok) throw new Error(`Dispatch failed: ${response.status}`);

    return await response.json() as RoadPathMessage;
}

export async function dispatchBulkRoutes(vehicleCount = 24): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/road/dispatch/bulk?vehicleCount=${vehicleCount}`, {
        method: 'POST',
    });

    if (response.status === 404) {
        // 后端未重启或暂未部署大宗订单接口时，退回普通调度兜底，避免按钮不可用。
        // 注意：兜底模式不具备“同一订单多车”的业务语义，只用于临时演示。
        for (let i = 0; i < 8; i++) {
            await fetch(`${API_BASE_URL}/road/dispatch`, { method: 'POST' });
        }
        return;
    }

    if (!response.ok) throw new Error(`Bulk dispatch failed: ${response.status}`);
    await response.json();
}
