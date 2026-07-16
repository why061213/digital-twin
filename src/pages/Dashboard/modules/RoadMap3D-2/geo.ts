import { geoMercator } from 'd3-geo';
import * as THREE from 'three';
import { BASE_URL, DIRECT_CITY_ADCODES } from './constants';

// RM2 地图水平缩放系数
export const MAP_HORIZONTAL_SCALE = 100;

export const projection = geoMercator()
    .center([104.5, 35])
    .scale(80)
    .translate([0, 0]);

export async function loadCityGeoJson(): Promise<any> {
    const provResp = await fetch(`${BASE_URL}100000_full.json`);
    const provData = await provResp.json();
    const municipalityFeatures: any[] = [];
    const provinceFeatures: any[] = [];
    const provinceAdcodes: number[] = [];

    provData.features.forEach((feature: any) => {
        const adcode = feature.properties.adcode;
        if (DIRECT_CITY_ADCODES.includes(adcode)) {
            municipalityFeatures.push(feature);
        } else if (/^\d+$/.test(String(adcode))) {
            provinceAdcodes.push(adcode);
            // 保存省边界（用自定义标记区分，避免和直辖市冲突）
            provinceFeatures.push({ ...feature, properties: { ...feature.properties, _boundaryOnly: true } });
        }
    });

    const cityFeatures: any[] = [];
    await Promise.all(
        provinceAdcodes.map(async (adcode) => {
            try {
                const resp = await fetch(`${BASE_URL}${adcode}_full.json`);
                if (!resp.ok) return;
                const data = await resp.json();
                if (data.features) cityFeatures.push(...data.features);
            } catch { /* ignore */ }
        })
    );

    // 加载区县数据：对每个城市，加载其区县级 GeoJSON
    const districtFeatures: any[] = [];
    const cityAdcodes = cityFeatures
        .map((f) => f.properties.adcode)
        .filter((code: number) => code && !DIRECT_CITY_ADCODES.includes(code));
    await Promise.all(
        cityAdcodes.map(async (adcode: number) => {
            try {
                const resp = await fetch(`${BASE_URL}${adcode}_full.json`);
                if (!resp.ok) return;
                const data = await resp.json();
                if (data.features) districtFeatures.push(...data.features);
            } catch { /* ignore */ }
        })
    );

    return {
        type: 'FeatureCollection',
        features: [...provinceFeatures, ...municipalityFeatures, ...cityFeatures, ...districtFeatures],
    };
}

export function mapPosition(coords: [number, number], lift = 0) {
    const p = projection(coords);
    if (!p) return null;
    return new THREE.Vector3(-p[0] * MAP_HORIZONTAL_SCALE, lift, -p[1] * MAP_HORIZONTAL_SCALE);
}
