import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import type { ViewMode } from '../types';

type TestRoad = {
    lineId: string;
    orderId: string;
    plate: string;
    cargo: string;
    from: string;
    to: string;
    pathKey: string;
    coordinates: [number, number][];
    phase: number;
};

const RM2_TEST_ROADS: readonly TestRoad[] = [
    {
        lineId: 'rm2-fs-gz-01', orderId: 'RM2-FS-GZ', plate: '粤E63962', cargo: '18吨',
        from: '佛山南海', to: '广州白云', pathKey: 'rm2-foshan-guangzhou', phase: 0.08,
        coordinates: [[113.145, 23.045], [113.225, 23.095], [113.315, 23.155], [113.365, 23.245]],
    },
    {
        lineId: 'rm2-fs-gz-02', orderId: 'RM2-FS-GZ', plate: '粤E05619D', cargo: '15吨',
        from: '佛山南海', to: '广州白云', pathKey: 'rm2-foshan-guangzhou', phase: 0.42,
        coordinates: [[113.145, 23.045], [113.225, 23.095], [113.315, 23.155], [113.365, 23.245]],
    },
    {
        lineId: 'rm2-dg-sz-01', orderId: 'RM2-DG-SZ', plate: '粤S88520', cargo: '12吨',
        from: '东莞松山湖', to: '深圳龙华', pathKey: 'rm2-dongguan-shenzhen', phase: 0.19,
        coordinates: [[113.92, 22.91], [113.98, 22.84], [114.055, 22.77], [114.10, 22.71]],
    },
    {
        lineId: 'rm2-dg-sz-02', orderId: 'RM2-DG-SZ', plate: '粤B71208', cargo: '10吨',
        from: '东莞松山湖', to: '深圳龙华', pathKey: 'rm2-dongguan-shenzhen', phase: 0.62,
        coordinates: [[113.92, 22.91], [113.98, 22.84], [114.055, 22.77], [114.10, 22.71]],
    },
    {
        lineId: 'rm2-zs-zh-01', orderId: 'RM2-ZS-ZH', plate: '粤T52601', cargo: '9吨',
        from: '中山坦洲', to: '珠海香洲', pathKey: 'rm2-zhongshan-zhuhai', phase: 0.31,
        coordinates: [[113.49, 22.47], [113.535, 22.42], [113.575, 22.36]],
    },
];

function positionAtProgress(coordinates: [number, number][], progress: number): [number, number] {
    const scaled = Math.min(0.98, Math.max(0.02, progress)) * (coordinates.length - 1);
    const index = Math.min(coordinates.length - 2, Math.floor(scaled));
    const localProgress = scaled - index;
    const start = coordinates[index];
    const end = coordinates[index + 1];
    return [
        start[0] + (end[0] - start[0]) * localProgress,
        start[1] + (end[1] - start[1]) * localProgress,
    ];
}

type UseRm2TestRoadControllerOptions = {
    roadMapRef: RefObject<RoadMap3D2Handle | null>;
    view: ViewMode;
    sceneReady: boolean;
};

export function useRm2TestRoadController({
    roadMapRef,
    view,
    sceneReady,
}: UseRm2TestRoadControllerOptions) {
    const [activeLineId, setActiveLineId] = useState(RM2_TEST_ROADS[0].lineId);
    const animationFrameRef = useRef(0);
    const carouselTimerRef = useRef<number | null>(null);

    useEffect(() => {
        if (view !== 'roadMap2' || !sceneReady || !roadMapRef.current) return;

        const roadMap = roadMapRef.current;
        const startedAt = performance.now();
        let carouselIndex = 0;
        roadMap.clearRoads();
        RM2_TEST_ROADS.forEach((route) => {
            roadMap.addRoadPath(route.lineId, route.coordinates, {
                plate: route.plate,
                cargo: route.cargo,
                from: route.from,
                to: route.to,
                status: '运输中',
                speedKmh: 42,
                routeLengthKm: 36,
                orderId: route.orderId,
                orderName: 'RM2 短途测试订单',
                pathKey: route.pathKey,
            });
        });

        const render = (now: number) => {
            const elapsed = now - startedAt;
            RM2_TEST_ROADS.forEach((route) => {
                const progress = (route.phase + elapsed / 42_000) % 0.96;
                roadMap.updateTruckPosition(route.lineId, positionAtProgress(route.coordinates, progress), {
                    plate: route.plate,
                    cargo: route.cargo,
                    from: route.from,
                    to: route.to,
                    status: '运输中',
                    speedKmh: 42,
                    routeLengthKm: 36,
                    orderId: route.orderId,
                    orderName: 'RM2 短途测试订单',
                    pathKey: route.pathKey,
                });
            });
            animationFrameRef.current = window.requestAnimationFrame(render);
        };
        animationFrameRef.current = window.requestAnimationFrame(render);

        carouselTimerRef.current = window.setInterval(() => {
            carouselIndex = (carouselIndex + 1) % RM2_TEST_ROADS.length;
            setActiveLineId(RM2_TEST_ROADS[carouselIndex].lineId);
        }, 5_000);

        return () => {
            window.cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = 0;
            if (carouselTimerRef.current !== null) {
                window.clearInterval(carouselTimerRef.current);
                carouselTimerRef.current = null;
            }
            roadMap.clearRoads();
        };
    }, [roadMapRef, sceneReady, view]);

    return {
        activeLineId,
        testRouteCount: RM2_TEST_ROADS.length,
    };
}
