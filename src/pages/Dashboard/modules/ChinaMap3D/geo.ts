import { geoMercator } from 'd3-geo';
import { DIRECT_CITY_ADCODES, MAP_ROTATION_Z } from './constants';
import * as THREE from 'three';
import { loadDetailedGeoJson, loadNationalGeoSource } from '../../services/mapGeoApi';

export const projection = geoMercator().center([104.5, 35]).scale(80).translate([0, 0]);

export async function loadCityGeoJson(): Promise<any> {
    const { data: provData, remoteAvailable } = await loadNationalGeoSource();
    if (!remoteAvailable) return provData;
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
                // Keep the map usable if one province fails to load.
            }
        })
    );

    return { type: 'FeatureCollection', features: [...municipalityFeatures, ...cityFeatures] };
}

export function mapPosition(coords: [number, number], lift = 1.8) {
    const projected = projection(coords);
    if (!projected) return null;
    const x = -projected[0];
    const z = -projected[1];
    const cos = Math.cos(MAP_ROTATION_Z);
    const sin = Math.sin(MAP_ROTATION_Z);
    return new THREE.Vector3(x * cos - z * sin, lift, x * sin + z * cos);
}
