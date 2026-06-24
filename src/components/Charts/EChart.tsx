import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

interface EChartProps {
    option: EChartsOption;
    style?: React.CSSProperties;
}

function EChart({ option, style = {} }: EChartProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<echarts.ECharts | null>(null);

    useEffect(() => {
        // 如果容器还没挂载，直接返回
        if (!containerRef.current) return;

        // 如果已有实例，直接更新选项（不重建）
        if (chartRef.current) {
            chartRef.current.setOption(option, true);
            return;
        }

        // 首次初始化
        chartRef.current = echarts.init(containerRef.current);
        chartRef.current.setOption(option);

        // 窗口 resize 时自动调整
        const handleResize = () => {
            chartRef.current?.resize();
        };
        window.addEventListener('resize', handleResize);

        // 组件卸载时销毁实例
        return () => {
            window.removeEventListener('resize', handleResize);
            chartRef.current?.dispose();
            chartRef.current = null;
        };
    }, [option]);

    return (
        <div
            ref={containerRef}
            style={{ width: '100%', height: '100%', ...style }}
        />
    );
}

export default EChart;