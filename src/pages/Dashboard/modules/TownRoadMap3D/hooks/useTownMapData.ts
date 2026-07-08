import { useCallback } from 'react';
import * as THREE from 'three';
import { loadCitiesByAdcodes, findNearestCity, projection } from '../geo';
import { useTownMapRefs } from './useTownMapRefs';

// 临时：所有地级市坐标（可从配置文件注入）
const ALL_CITIES = [
    { name: '北京', adcode: 110000, lng: 116.4, lat: 39.9 },
    { name: '上海', adcode: 310000, lng: 121.47, lat: 31.23 },
    { name: '广州', adcode: 440100, lng: 113.26, lat: 23.13 },
    { name: '深圳', adcode: 440300, lng: 114.06, lat: 22.54 },
    { name: '成都', adcode: 510100, lng: 104.07, lat: 30.57 },
    // 实际可从 SimulationProperties 或后端城市列表获取
];

export function useTownMapData(refs: ReturnType<typeof useTownMapRefs>) {
    const renderCities = useCallback((geoJson: any) => {
        const scene = refs.sceneRef.current;
        if (!scene) return;

        // 移除旧的城市组
        const oldGroup = scene.getObjectByName('townCities');
        if (oldGroup) scene.remove(oldGroup);

        const group = new THREE.Group();
        group.name = 'townCities';
        geoJson.features.forEach((feature: any) => {
            const { geometry } = feature;
            const color = '#334155';
            let rings: number[][][] = [];
            if (geometry.type === 'Polygon') rings = [geometry.coordinates[0]];
            else if (geometry.type === 'MultiPolygon') rings = geometry.coordinates.map((p: any) => p[0]);

            const cityGroup = new THREE.Group();
            rings.forEach((ring) => {
                const shape = new THREE.Shape();
                ring.forEach(([lng, lat], i) => {
                    const [x, y] = projection([lng, lat])!;
                    if (i === 0) shape.moveTo(-x, -y);
                    else shape.lineTo(-x, -y);
                });
                const geom = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
                const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color, roughness: 0.6, side: THREE.DoubleSide }));
                cityGroup.add(mesh);
            });
            group.add(cityGroup);
        });
        group.rotation.x = Math.PI / 2;
        scene.add(group);
        refs.mapGroupRef.current = group;
    }, [refs]);

    const setRoute = useCallback(async (fromCoords: [number, number], toCoords: [number, number]) => {
        const fromCity = findNearestCity(fromCoords, ALL_CITIES);
        const toCity = findNearestCity(toCoords, ALL_CITIES);
        // 简单处理：只加载起终点城市以及手动添加一个中间城市（济南为例）
        const adcodes = [fromCity.adcode, toCity.adcode, 370100];
        const geoJson = await loadCitiesByAdcodes(adcodes);
        renderCities(geoJson);
    }, [renderCities]);

    return { setRoute };
}