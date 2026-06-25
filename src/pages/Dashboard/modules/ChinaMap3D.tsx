import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import * as echarts from 'echarts';
import 'echarts-gl';

const BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const DIRECT_CITY_ADCODES = [110000, 120000, 310000, 500000];

async function loadCityGeoJson() {
    const provResp = await fetch(`${BASE_URL}100000_full.json`);
    const provData = await provResp.json();
    const municipalityFeatures: any[] = [];
    const provinceAdcodes: number[] = [];
    provData.features.forEach((f: any) => {
        const adcode = f.properties.adcode;
        if (DIRECT_CITY_ADCODES.includes(adcode)) municipalityFeatures.push(f);
        else if (/^\d+$/.test(String(adcode))) provinceAdcodes.push(adcode);
    });
    const cityFeatures: any[] = [];
    await Promise.all(provinceAdcodes.map(async (adcode) => {
        try {
            const resp = await fetch(`${BASE_URL}${adcode}_full.json`);
            const data = await resp.json();
            if (data.features) cityFeatures.push(...data.features);
        } catch (e) {}
    }));
    return { type: 'FeatureCollection', features: [...municipalityFeatures, ...cityFeatures] };
}

const ChinaMap3D = forwardRef((props: {}, ref: any) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<echarts.ECharts | null>(null);
    const cityGeoRef = useRef<any>(null);
    const foShanNameRef = useRef<string>('');
    const initializedRef = useRef(false);
    const currentTargetRef = useRef<string | null>(null);

    // 存储每个城市当前的高度（用于动画）
    const heightsRef = useRef<Record<string, number>>({});

    const easeInOutCubic = (t: number) => {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    };

    const animateHeight = useCallback((
        cityName: string,
        targetHeight: number,
        duration: number = 2000
    ) => {
        if (!chartRef.current || !cityGeoRef.current) return;

        const startHeights = { ...heightsRef.current };
        const startTime = performance.now();

        const step = (currentTime: number) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easedProgress = easeInOutCubic(progress);

            const newData = cityGeoRef.current!.features.map((f: any) => {
                const name = f.properties.name;
                const startH = startHeights[name] ?? 0.5;
                const targetH = name === cityName ? targetHeight : (name === foShanNameRef.current ? 1 : 0.5);
                const currentH = startH + (targetH - startH) * easedProgress;
                heightsRef.current[name] = currentH;

                return {
                    name,
                    value: currentH,
                    height: currentH,
                    itemStyle: {
                        color: name === foShanNameRef.current ? '#d97706' : (name === cityName ? '#06b6d4' : '#334155'),
                        borderColor: name === foShanNameRef.current ? '#fbbf24' : (name === cityName ? '#22d3ee' : '#475569'),
                        borderWidth: (name === foShanNameRef.current || name === cityName) ? 1.5 : 0.5,
                    },
                    label: {
                        show: name === foShanNameRef.current || name === cityName,
                        color: name === foShanNameRef.current ? '#ffffff' : '#e2e8f0',
                        fontSize: 12,
                        fontWeight: 'bold',
                        distance: 3,
                    },
                };
            });

            chartRef.current?.setOption({
                series: [{ data: newData }],
            });

            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                heightsRef.current[cityName] = targetHeight;
            }
        };

        requestAnimationFrame(step);
    }, []);

    // 初始化地图
    useEffect(() => {
        if (!containerRef.current || initializedRef.current) return;
        initializedRef.current = true;

        const initMap = async () => {
            const cityGeo = await loadCityGeoJson();
            cityGeoRef.current = cityGeo;
            const allNames = cityGeo.features.map((f: any) => f.properties.name);
            const foShanName = allNames.find((n: string) => n.includes('佛山'));
            foShanNameRef.current = foShanName || '佛山市';

            const initHeights: Record<string, number> = {};
            const mapData = allNames.map((name: string) => {
                const h = name === foShanName ? 1 : 0.5;
                initHeights[name] = h;
                return {
                    name,
                    value: h,
                    height: h,
                    itemStyle: {
                        color: name === foShanName ? '#d97706' : '#334155',
                        borderColor: name === foShanName ? '#fbbf24' : '#475569',
                        borderWidth: name === foShanName ? 1.5 : 0.5,
                    },
                    label: {
                        show: name === foShanName,
                        color: '#ffffff',
                        fontSize: 12,
                        fontWeight: 'bold',
                        distance: 3,
                    },
                };
            });
            heightsRef.current = initHeights;

            echarts.registerMap('china_cities', cityGeo);

            const existing = echarts.getInstanceByDom(containerRef.current!);
            if (existing) existing.dispose();

            const chart = echarts.init(containerRef.current!);
            chartRef.current = chart;

            chart.setOption({
                backgroundColor: 'transparent',
                series: [{
                    type: 'map3D',
                    map: 'china_cities',
                    data: mapData,
                    shading: 'realistic',
                    realisticMaterial: { roughness: 0.6, metalness: 0.2 },
                    regionHeight: 0.5,
                    label: { show: false },
                    emphasis: {
                        label: { show: true, color: '#fff', fontSize: 12 },
                        itemStyle: { color: '#2dd4bf' },
                    },
                    light: {
                        main: { intensity: 1.2, shadow: true },
                        ambient: { intensity: 0.7 },
                    },
                    viewControl: {
                        autoRotate: false,
                        distance: 80,
                        alpha: 35,
                        beta: 25,
                    },
                }],
                
            });

            window.addEventListener('resize', () => chart.resize());
        };
        initMap();
    }, []);

    const flyToCity = useCallback((cityName: string) => {
        if (!cityGeoRef.current) return;
        const allNames = cityGeoRef.current.features.map((f: any) => f.properties.name);
        const matched = allNames.find((n: string) => n.includes(cityName));
        if (!matched) return;

        const oldTarget = currentTargetRef.current;
        if (oldTarget && oldTarget !== matched) {
            animateHeight(oldTarget, 0.5, 800);
            setTimeout(() => {
                currentTargetRef.current = matched;
                animateHeight(matched, 4, 1600);
            }, 800);
        } else {
            currentTargetRef.current = matched;
            animateHeight(matched, 4, 1600);
        }
    }, [animateHeight]);

    useImperativeHandle(ref, () => ({ flyToCity }), [flyToCity]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
});

export default ChinaMap3D;