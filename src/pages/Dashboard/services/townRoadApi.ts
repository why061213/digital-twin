import { API_BASE_URL } from '../constants';
import type { TownRoadRenderEnvelope } from '../modules/TownRoadMap3D/types';

export async function fetchTownRoadRenderEnvelope(signal?: AbortSignal): Promise<TownRoadRenderEnvelope> {
    const url = `${API_BASE_URL}/road/town/latest`;
    console.info('[TownRoad] request backend latest envelope', { url });

    const response = await fetch(url, {
        method: 'GET',
        signal,
    });

    if (!response.ok) {
        throw new Error(`TownRoad latest request failed: ${response.status}`);
    }

    const data = await response.json() as TownRoadRenderEnvelope;
    console.info('[TownRoad] backend latest envelope received', {
        ok: data?.ok,
        type: data?.type,
        rawCount: data?.rawCount,
        normalizedCount: data?.normalizedCount,
        shortHaulCount: data?.shortHaulCount,
        commandCount: data?.commandCount,
        commandsLength: Array.isArray(data?.commands) ? data.commands.length : 0,
    });

    return data;
}
