import { geoMercator } from 'd3-geo';
import * as THREE from 'three';
import { DIRECT_CITY_ADCODES } from './constants';
import { loadDetailedGeoJson, loadNationalGeoSource } from '../../services/mapGeoApi';

export const projection = geoMercator()
    .center([104.5, 35])
    .scale(80)
    .translate([0, 0]);

export async function loadCityGeoJson(): Promise<any> {
    const { data: provData } = await loadNationalGeoSource();
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
                const data = await loadDetailedGeoJson(adcode);
                if (data?.features) cityFeatures.push(...data.features);
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
    return new THREE.Vector3(-p[0], lift, -p[1]);
}
