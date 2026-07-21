const REMOTE_GEO_BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const LOCAL_CHINA_GEO_URL = '/map/china.json';
const LOCAL_GEO_BASE_URL = '/map/bound/';
const REMOTE_PROBE_TIMEOUT_MS = 2_000;

type GeoJson = {
    type: string;
    features: any[];
};

type NationalGeoSource = {
    data: GeoJson;
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
    nationalGeoSourcePromise ??= fetchJson(LOCAL_CHINA_GEO_URL, 5_000)
        .then((data) => ({ data }))
        .catch(async () => ({
            data: await fetchJson(`${REMOTE_GEO_BASE_URL}100000_full.json`, REMOTE_PROBE_TIMEOUT_MS),
        }));
    return nationalGeoSourcePromise;
}

export async function loadDetailedGeoJson(adcode: number, signal?: AbortSignal): Promise<GeoJson | null> {
    try {
        return await fetchJson(`${LOCAL_GEO_BASE_URL}${adcode}_full.json`, 5_000, signal);
    } catch (error) {
        if (signal?.aborted) throw error;
        try {
            return await fetchJson(`${REMOTE_GEO_BASE_URL}${adcode}_full.json`, 8_000, signal);
        } catch (remoteError) {
            if (signal?.aborted) throw remoteError;
            return null;
        }
    }
}
