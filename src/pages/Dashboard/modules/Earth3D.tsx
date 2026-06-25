import { useEffect, useRef, useCallback, useState } from 'react';
import * as echarts from 'echarts';
import 'echarts-gl';
import { cityCoords } from '@/data/cityCoords';

const BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';

async function loadCityGeoJson() {
    const provResp = await fetch(`${BASE_URL}100000_full.json`);
    const provData = await provResp.json();
    const adcodes: number[] = provData.features
        .map((f: any) => f.properties.adcode)
        .filter((code: any) => /^\d+$/.test(String(code)));

    const features: any[] = [];
    const tasks = adcodes.map(async (adcode) => {
        try {
            const resp = await fetch(`${BASE_URL}${adcode}_full.json`);
            const data = await resp.json();
            if (data.features) features.push(...data.features);
        } catch (e) { /* ignore */ }
    });
    await Promise.all(tasks);
    return { type: 'FeatureCollection', features };
}

function ChinaMap3D({ onRef }: { onRef?: (ref: any) => void }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const chartRef = useRef<echarts.ECharts | null>(null);
    const cityGeoRef = useRef<any>(null);
    const foShanNameRef = useRef<string>('');
    const currentTargetRef = useRef<string | null>(null);
    const animFrameRef = useRef<number>(0);
    const particlesRef = useRef<{ x: number; y: number; progress: number; speed: number }[]>([]);

    const getScreenCoord = useCallback((cityName: string) => {
        if (!chartRef.current) return null;
        const coords = cityCoords[cityName];
        if (!coords) return null;
        const point = chartRef.current.convertToPixel(
            { seriesIndex: 0 },
            [coords[0], coords[1]]
        ) as number[];
        return point ? { x: point[0], y: point[1] } : null;
    }, []);

    // 更新地图数据
    const updateMapData = useCallback((targetCity: string | null) => {
        if (!chartRef.current || !cityGeoRef.current) return;
        const cityGeo = cityGeoRef.current;
        const foShanName = foShanNameRef.current;
        const newData = cityGeo.features.map((f: any) => {
            const isFoShan = f.properties.name === foShanName;
            const isTarget = targetCity && f.properties.name === targetCity;
            return {
                name: f.properties.name,
                value: (isFoShan || isTarget) ? 1 : 0.5,
                height: (isFoShan || isTarget) ? 1 : 0.5,
                itemStyle: {
                    color: isFoShan ? '#d97706' : isTarget ? '#06b6d4' : '#334155',
                    borderColor: isFoShan ? '#fbbf24' : isTarget ? '#22d3ee' : '#475569',
                    borderWidth: (isFoShan || isTarget) ? 1.5 : 0.5,
                },
                label: {
                    show: isFoShan || isTarget,
                    color: isFoShan ? '#fbbf24' : '#22d3ee',
                    fontSize: 12,
                    fontWeight: 'bold',
                    distance: 3,
                },
            };
        });

        chartRef.current.setOption({
            series: [{
                data: newData,
                animationDurationUpdate: 800,   // 平滑过渡动画 0.8s
            }],
        });
    }, []);

    // 绘制流线
    const drawCurve = useCallback(() => {
        const canvas = canvasRef.current;
        const chart = chartRef.current;
        if (!canvas || !chart) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const foShan = getScreenCoord(foShanNameRef.current);
        const target = currentTargetRef.current ? getScreenCoord(currentTargetRef.current) : null;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!foShan || !target) {
            particlesRef.current = [];
            animFrameRef.current = requestAnimationFrame(drawCurve);
            return;
        }

        const dx = target.x - foShan.x;
        const dy = target.y - foShan.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const midX = (foShan.x + target.x) / 2 - dy * 0.05;
        const midY = (foShan.y + target.y) / 2 + dx * 0.05 - dist * 0.12;

        // 光晕背景
        ctx.beginPath();
        ctx.moveTo(foShan.x, foShan.y);
        ctx.quadraticCurveTo(midX, midY, target.x, target.y);
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.2)';
        ctx.lineWidth = 8;
        ctx.shadowColor = '#06b6d4';
        ctx.shadowBlur = 20;
        ctx.stroke();

        // 主线
        ctx.beginPath();
        ctx.moveTo(foShan.x, foShan.y);
        ctx.quadraticCurveTo(midX, midY, target.x, target.y);
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.8)';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 10;
        ctx.stroke();

        // 粒子
        ctx.fillStyle = '#06b6d4';
        ctx.shadowBlur = 8;
        if (particlesRef.current.length < 20 && Math.random() > 0.6) {
            particlesRef.current.push({
                x: foShan.x, y: foShan.y, progress: 0,
                speed: 0.005 + Math.random() * 0.008,
            });
        }

        particlesRef.current = particlesRef.current.filter(p => {
            p.progress += p.speed;
            if (p.progress >= 1) return false;
            const t = p.progress;
            const x = (1 - t) * (1 - t) * foShan.x + 2 * (1 - t) * t * midX + t * t * target.x;
            const y = (1 - t) * (1 - t) * foShan.y + 2 * (1 - t) * t * midY + t * t * target.y;
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
            return true;
        });

        animFrameRef.current = requestAnimationFrame(drawCurve);
    }, [getScreenCoord]);

    // 动画循环
    useEffect(() => {
        animFrameRef.current = requestAnimationFrame(drawCurve);
        return () => cancelAnimationFrame(animFrameRef.current);
    }, [drawCurve]);

    // Canvas 尺寸自适应
    useEffect(() => {
        const resizeCanvas = () => {
            const canvas = canvasRef.current;
            const container = containerRef.current;
            if (canvas && container) {
                canvas.width = container.clientWidth;
                canvas.height = container.clientHeight;
            }
        };
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        return () => window.removeEventListener('resize', resizeCanvas);
    }, []);

    // 初始化地图
    useEffect(() => {
        if (!containerRef.current) return;
        const initMap = async () => {
            const cityGeo = await loadCityGeoJson();
            cityGeoRef.current = cityGeo;
            const foShanName = cityGeo.features
                .map((f: any) => f.properties.name)
                .find((n: string) => n.includes('佛山'));
            foShanNameRef.current = foShanName || '佛山市';

            echarts.registerMap('china_cities', cityGeo);
            const chart = echarts.init(containerRef.current!);
            chartRef.current = chart;

            updateMapData(null); // 初始只有佛山凸起

            chart.on('viewchange', () => {});

            const handleResize = () => chart.resize();
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
        };
        initMap();
        return () => chartRef.current?.dispose();
    }, []);

    // 核心方法：飞线至某个城市
    const flyToCity = useCallback((cityName: string) => {
        const oldTarget = currentTargetRef.current;
        // 先降下旧目标
        if (oldTarget) {
            updateMapData(null); // 重置为只有佛山凸起
            currentTargetRef.current = null;
            particlesRef.current = [];
        }
        // 延迟升起新目标
        setTimeout(() => {
            currentTargetRef.current = cityName;
            updateMapData(cityName);
        }, oldTarget ? 400 : 100); // 如果有旧目标，等降下动画完成再升
    }, [updateMapData]);

    // 暴露方法给父组件
    useEffect(() => {
        if (onRef) onRef({ flyToCity });
    }, [onRef, flyToCity]);

    return (
        <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
            <canvas
                ref={canvasRef}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    zIndex: 10,
                }}
            />
        </div>
    );
}

export default ChinaMap3D;