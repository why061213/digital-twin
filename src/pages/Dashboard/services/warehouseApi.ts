import { API_BASE_URL } from '../constants';
import type { WarehouseFocusStyle } from '../hooks/useDashboardRealtime';
import type { PanelData } from '../modules/ChinaMap3D/types';

export type WarehouseSnapshotMessage = {
    cityName: string;
    action: string;
    displayData: Record<string, any>;
};

export type WarehouseFocusMessage = {
    cityName: string;
    panels: PanelData[];
    style?: WarehouseFocusStyle;
};

export async function pushWarehouseSnapshot(): Promise<WarehouseSnapshotMessage[]> {
    const response = await fetch(`${API_BASE_URL}/warehouse/snapshot/push`, { method: 'POST' });
    if (!response.ok) throw new Error(`Warehouse snapshot request failed: ${response.status}`);

    return await response.json() as WarehouseSnapshotMessage[];
}

export async function fetchWarehouseFocus(cityName: string): Promise<WarehouseFocusMessage> {
    const response = await fetch(`${API_BASE_URL}/warehouse/focus/${encodeURIComponent(cityName)}`);
    if (!response.ok) throw new Error(`Warehouse focus request failed: ${response.status}`);

    return await response.json() as WarehouseFocusMessage;
}
