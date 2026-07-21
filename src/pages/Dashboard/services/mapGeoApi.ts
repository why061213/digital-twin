const REMOTE_GEO_BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const LOCAL_CHINA_GEO_URL = '/map/china.json';
const REMOTE_PROBE_TIMEOUT_MS = 2_000;

type GeoJson = {
    type: string;
    features: any[];
};

type NationalGeoSource = {
    data: GeoJson;
    remoteAvailable: boolean;
};

let nationalGeoSourcePromise: Promise<NationalGeoSource> | null = null;

async function fetchJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<GeoJson> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = window.setTimeout(abort, timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Map boundary request failed: ${response.status}`);
        return await response.json() as GeoJson;
    } finally {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

export function loadNationalGeoSource(): Promise<NationalGeoSource> {
    nationalGeoSourcePromise ??= fetchJson(
        `${REMOTE_GEO_BASE_URL}100000_full.json`,
        REMOTE_PROBE_TIMEOUT_MS,
    ).then((data) => ({ data, remoteAvailable: true }))
        .catch(async () => ({
            data: await fetchJson(LOCAL_CHINA_GEO_URL, 5_000),
            remoteAvailable: false,
        }));
    return nationalGeoSourcePromise;
}

export async function loadDetailedGeoJson(adcode: number, signal?: AbortSignal): Promise<GeoJson | null> {
    const source = await loadNationalGeoSource();
    if (!source.remoteAvailable) return null;
    try {
        return await fetchJson(`${REMOTE_GEO_BASE_URL}${adcode}_full.json`, 8_000, signal);
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
}
