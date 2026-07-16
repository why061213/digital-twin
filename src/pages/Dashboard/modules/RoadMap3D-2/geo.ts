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
    469001, 429005, 659009, 469022, 469029, 429004, 469005, 469024,
    659004, 429006, 469030, 469007, 469026, 469027, 469025, 469028,
    469006, 659003, 620200, 460400, 659006, 659010, 429021, 442000,
    659007, 469023, 469021, 659008, 441900, 419001,
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

async function fetchBoundaryFeatures(adcode: number): Promise<any[]> {
    try {
        const response = await fetch(`${BASE_URL}${adcode}_full.json`);
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data.features) ? data.features : [];
    } catch {
        return [];
    }
}

export async function loadCityGeoJson(): Promise<any> {
    const provResp = await fetch(`${BASE_URL}100000_full.json`);
    if (!provResp.ok) throw new Error(`Failed to load China boundary: ${provResp.status}`);
    const provData = await provResp.json();
    const provinceSourceByAdcode = new Map<number, any>(
        provData.features.map((feature: any) => [Number(feature.properties.adcode), feature])
    );
    const provinceAdcodes: number[] = [];
    const municipalityAdcodes: number[] = [];

    provData.features.forEach((feature: any) => {
        const adcode = Number(feature.properties.adcode);
        if (!Number.isFinite(adcode)) return;
        if (DIRECT_CITY_ADCODES.includes(adcode)) {
            municipalityAdcodes.push(adcode);
        } else {
            provinceAdcodes.push(adcode);
        }
    });

    const cityFeatureGroups = await Promise.all(
        provinceAdcodes.map(async (adcode) =>
            (await fetchBoundaryFeatures(adcode)).map((feature) =>
                withBoundaryLevel(feature, 'city')
            )
        )
    );
    const cityFeatures = cityFeatureGroups.flat();

    const cityAdcodes = cityFeatures
        .map((feature: any) => Number(feature.properties.adcode))
        .filter((adcode: number) => Number.isFinite(adcode) && !NO_DISTRICT_CITIES.has(adcode));

    const [cityDistrictGroups, municipalityDistrictGroups] = await Promise.all([
        Promise.all(cityAdcodes.map(async (adcode: number) =>
            (await fetchBoundaryFeatures(adcode)).map((feature) =>
                withBoundaryLevel(feature, 'district')
            )
        )),
        // 直辖市的 _full 文件直接包含区县，不能从普通省份的城市列表中推导。
        Promise.all(municipalityAdcodes.map(async (adcode) =>
            (await fetchBoundaryFeatures(adcode)).map((feature) =>
                withBoundaryLevel(feature, 'district')
            )
        )),
    ]);

    const districtFeatures = [...cityDistrictGroups.flat(), ...municipalityDistrictGroups.flat()];
    const provinceFeatures = [
        ...provinceAdcodes.map((adcode, index) =>
            buildOuterBoundary(adcode, cityFeatureGroups[index], provinceSourceByAdcode.get(adcode))
        ),
        ...municipalityAdcodes.map((adcode, index) =>
            buildOuterBoundary(adcode, municipalityDistrictGroups[index], provinceSourceByAdcode.get(adcode))
        ),
    ];

    return {
        type: 'FeatureCollection',
        features: [...provinceFeatures, ...cityFeatures, ...districtFeatures],
    };
}

export function mapPosition(coords: [number, number], lift = 0) {
    const p = projection(coords);
    if (!p) return null;
    return new THREE.Vector3(-p[0] * MAP_HORIZONTAL_SCALE, lift, -p[1] * MAP_HORIZONTAL_SCALE);
}
