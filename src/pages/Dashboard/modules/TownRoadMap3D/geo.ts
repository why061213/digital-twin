import { geoMercator } from 'd3-geo';
import { BASE_URL, DIRECT_CITY_ADCODES } from './constants';

// 保留投影函数，地图渲染时使用
export const projection = geoMercator()
    .center([104.5, 35])
    .scale(80)
    .translate([0, 0]);

// 加载指定 adcode 数组对应的 GeoJSON
export async function loadCitiesByAdcodes(adcodes: number[]): Promise<any> {
    const features: any[] = [];
    for (const code of adcodes) {
        if (DIRECT_CITY_ADCODES.includes(code)) {
            // 直辖市的处理（后面可能需要细化）
            const resp = await fetch(`${BASE_URL}${code}_full.json`);
            const data = await resp.json();
            if (data.features) features.push(...data.features);
        } else {
            // 普通地级市
            const resp = await fetch(`${BASE_URL}${code}_full.json`);
            const data = await resp.json();
            if (data.features) features.push(...data.features);
        }
    }
    return { type: 'FeatureCollection', features };
}

// 根据坐标查找最近的城市 adcode（临时方案，后续会改成真实的路径裁剪）
export function findNearestCity(coords: [number, number], allCities: Array<{ name: string; adcode: number; lng: number; lat: number }>) {
    let min = Infinity;
    let city = allCities[0];
    for (const c of allCities) {
        const d = Math.hypot(c.lng - coords[0], c.lat - coords[1]);
        if (d < min) {
            min = d;
            city = c;
        }
    }
    return city;
}