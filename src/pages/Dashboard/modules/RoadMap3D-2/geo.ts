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
    const provinceAdcodes: number[] = [];

    provData.features.forEach((feature: any) => {
        const adcode = feature.properties.adcode;
        if (DIRECT_CITY_ADCODES.includes(adcode)) {
            municipalityFeatures.push(feature);
        } else if (/^\d+$/.test(String(adcode))) {
            provinceAdcodes.push(adcode);
        }
    });

    const cityFeatures: any[] = [];
    await Promise.all(
        provinceAdcodes.map(async (adcode) => {
            try {
                const resp = await fetch(`${BASE_URL}${adcode}_full.json`);
                const data = await resp.json();
                if (data.features) cityFeatures.push(...data.features);
            } catch {
                // ignore
            }
        })
    );

    return { type: 'FeatureCollection', features: [...municipalityFeatures, ...cityFeatures] };
}

export function mapPosition(coords: [number, number], lift = 0) {
    const p = projection(coords);
    if (!p) return null;
    return new THREE.Vector3(-p[0] * MAP_HORIZONTAL_SCALE, lift, -p[1] * MAP_HORIZONTAL_SCALE);
}
