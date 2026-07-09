import { API_BASE_URL } from '../constants';
import type { TownRoadRenderEnvelope } from '../modules/TownRoadMap3D/types';

export async function fetchTownRoadRenderEnvelope(signal?: AbortSignal): Promise<TownRoadRenderEnvelope> {
    const response = await fetch(`${API_BASE_URL}/town-road/mock/provinces`, {
        method: 'POST',
        signal,
    });

    if (!response.ok) {
        throw new Error(`TownRoad request failed: ${response.status}`);
    }

    return await response.json() as TownRoadRenderEnvelope;
}
