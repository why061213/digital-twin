import { geoMercator } from 'd3-geo';
import * as THREE from 'three';
import { union, type MultiPolygon, type Polygon } from 'polygon-clipping';
import { BASE_URL, DIRECT_CITY_ADCODES } from './constants';

// RM2 地图水平缩放系数
export const MAP_HORIZONTAL_SCALE = 100;

export const projection = geoMercator()
    .center([104.5, 35])
    .scale(80)
    .translate([0, 0]);

type BoundaryLevel = 'province' | 'city' | 'district';

/** 已确认没有下级区县数据的城市 adcode（AliDataV 无 _full.json） */
const NO_DISTRICT_CITIES = new Set([
    469001, 469002, 429005, 659002, 659005, 659009, 469022, 469029,
    429004, 469005, 469024,
    659004, 429006, 469030, 469007, 469026, 469027, 469025, 469028,
    469006, 659003, 620200, 460400, 659006, 659010, 429021, 442000,
    659007, 469023, 469021, 659008, 441900, 419001, 710000,
]);

function withBoundaryLevel(feature: any, level: BoundaryLevel, boundaryOnly = false) {
    return {
        ...feature,
        properties: { ...feature.properties, _boundaryLevel: level, _boundaryOnly: boundaryOnly },
    };
}

function polygonGeometry(feature: any): MultiPolygon {
    if (feature.geometry?.type === 'Polygon') return [feature.geometry.coordinates as Polygon];
    if (feature.geometry?.type === 'MultiPolygon') return feature.geometry.coordinates as MultiPolygon;
    return [];
}

/** 合并同级子行政区得到父级外轮廓，确保省界和市界来自同一套高精度数据。 */
function buildOuterBoundary(adcode: number, children: any[], fallback: any) {
    const geometries = children.flatMap(polygonGeometry);
    if (geometries.length === 0) return withBoundaryLevel(fallback, 'province', true);
    const merged = union(geometries[0], ...geometries.slice(1));

    return withBoundaryLevel({
        type: 'Feature',
        properties: { ...fallback.properties, adcode },
        geometry: { type: 'MultiPolygon', coordinates: merged },
    }, 'province', true);
}

let provinceSourcesPromise: Promise<Map<number, any>> | null = null;

async function loadProvinceSources() {
    if (!provinceSourcesPromise) {
        provinceSourcesPromise = fetch(`${BASE_URL}100000_full.json`)
            .then(async (response) => {
                if (!response.ok) throw new Error(`Failed to load China boundary: ${response.status}`);
                const data = await response.json();
                return new Map<number, any>(
                    data.features.map((feature: any) => [Number(feature.properties.adcode), feature])
                );
            })
            .catch((error) => {
                provinceSourcesPromise = null;
                throw error;
            });
    }
    return provinceSourcesPromise;
}

async function fetchBoundaryFeatures(adcode: number, signal?: AbortSignal): Promise<any[]> {
    try {
        const response = await fetch(`${BASE_URL}${adcode}_full.json`, { signal });
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data.features) ? data.features : [];
    } catch (error) {
        if ((error as DOMException).name === 'AbortError') throw error;
        return [];
    }
}

export async function loadProvinceGeoJson(
    mapKeys: readonly string[],
    signal?: AbortSignal,
): Promise<any> {
    const provinceSourceByAdcode = await loadProvinceSources();
    if (signal?.aborted) throw new DOMException('Map load aborted', 'AbortError');
    const provinceAdcodes = [...new Set(mapKeys
        .map((key) => Number(key))
        .filter((adcode) => Number.isFinite(adcode) && provinceSourceByAdcode.has(adcode)))];

    const regionFeatureGroups = await Promise.all(provinceAdcodes.map(async (adcode) => {
        const provinceSource = provinceSourceByAdcode.get(adcode);
        const isDirectCity = DIRECT_CITY_ADCODES.includes(adcode);
        const children = NO_DISTRICT_CITIES.has(adcode) ? [] : await fetchBoundaryFeatures(adcode, signal);

        if (isDirectCity) {
            const districtFeatures = children.map((feature) => withBoundaryLevel(feature, 'district'));
            const leafFeatures = districtFeatures.length === 0
                ? [withBoundaryLevel(provinceSource, 'city')]
                : [];
            return [
                buildOuterBoundary(adcode, children, provinceSource),
                ...leafFeatures,
                ...districtFeatures,
            ];
        }

        const cityFeatures = children.map((feature) => withBoundaryLevel(feature, 'city'));
        const cityAdcodes = cityFeatures
            .map((feature: any) => Number(feature.properties.adcode))
            .filter((cityAdcode: number) => Number.isFinite(cityAdcode) && !NO_DISTRICT_CITIES.has(cityAdcode));
        const districtFeatures = (await Promise.all(cityAdcodes.map(async (cityAdcode) =>
            (await fetchBoundaryFeatures(cityAdcode, signal)).map((feature) => withBoundaryLevel(feature, 'district'))
        ))).flat();
        const leafFeatures = cityFeatures.length === 0
            ? [withBoundaryLevel(provinceSource, 'city')]
            : [];
        return [
            buildOuterBoundary(adcode, children, provinceSource),
            ...leafFeatures,
            ...cityFeatures,
            ...districtFeatures,
        ];
    }));

    return {
        type: 'FeatureCollection',
        features: regionFeatureGroups.flat(),
    };
}

export function mapPosition(coords: [number, number], lift = 0) {
    const p = projection(coords);
    if (!p) return null;
    return new THREE.Vector3(-p[0] * MAP_HORIZONTAL_SCALE, lift, -p[1] * MAP_HORIZONTAL_SCALE);
}
