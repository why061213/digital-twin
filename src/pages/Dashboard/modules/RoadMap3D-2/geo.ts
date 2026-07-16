import { geoMercator } from 'd3-geo';
import * as THREE from 'three';
import { BASE_URL, DIRECT_CITY_ADCODES } from './constants';

// RM2 地图水平缩放系数
export const MAP_HORIZONTAL_SCALE = 100;

export const projection = geoMercator()
    .center([104.5, 35])
    .scale(80)
    .translate([0, 0]);

/** 没有下级区县数据的城市 adcode（AliDataV 无 _full.json），不发无效请求 */
const NO_DISTRICT_CITIES = new Set([
    469001, 469002, 469003, 469004, 469005, 469006, 469007, 469021, 469022, 469023, 469024, 469025, 469026, 469027, 469028, 469029, 469030, // 海南直辖县级
    429004, 429005, 429006, 429021,  // 湖北直辖县级
    659001, 659002, 659003, 659004, 659005, 659006, 659007, 659008, 659009, 659010, 659011, // 新疆直辖县级
    620200, // 嘉峪关
    460400, // 海南直辖
    442000, // 中山（无区县）
    441900, // 东莞（无区县）
    419001, // 河南直辖
]);

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
        .filter((code: number) => code && !DIRECT_CITY_ADCODES.includes(code) && !NO_DISTRICT_CITIES.has(code));
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
