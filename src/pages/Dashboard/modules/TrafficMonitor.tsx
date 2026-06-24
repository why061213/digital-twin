import Panel from '@/components/Layout/Panel';
import EChart from '@/components/Charts/EChart';
import type { EChartsOption } from 'echarts';

const trafficOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: {
        orient: 'horizontal',
        bottom: 0,
        left: 'center',
        textStyle: { color: '#94a3b8', fontSize: 10 },
    },
    grid: { left: '3%', right: '4%', bottom: '15%', top: 15, containLabel: true },
    xAxis: {
        type: 'category',
        data: ['06:00', '08:00', '10:00', '12:00', '14:00', '16:00'],
        axisLabel: { color: '#94a3b8', fontSize: 10 },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
    },
    yAxis: {
        type: 'value',
        name: '辆',
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
        axisLabel: { color: '#94a3b8', fontSize: 10 },
    },
    series: [
        {
            name: '进园',
            type: 'line',
            smooth: true,
            data: [42, 78, 115, 130, 98, 67],
            itemStyle: { color: '#22d3ee' },
            lineStyle: { width: 2 },
            symbol: 'circle',
            symbolSize: 4,
        },
        {
            name: '出园',
            type: 'line',
            smooth: true,
            data: [35, 67, 98, 110, 85, 52],
            itemStyle: { color: '#a78bfa' },
            lineStyle: { width: 2 },
            symbol: 'circle',
            symbolSize: 4,
        },
    ],
};

const energyOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: {
        orient: 'horizontal',
        bottom: 0,
        left: 'center',
        textStyle: { color: '#94a3b8', fontSize: 10 },
    },
    grid: { left: '5%', right: '5%', bottom: '15%', top: 15, containLabel: true },
    xAxis: {
        type: 'category',
        data: ['06:00', '08:00', '10:00', '12:00', '14:00', '16:00'],
        axisLabel: { color: '#94a3b8', fontSize: 10 },
    },
    yAxis: {
        type: 'value',
        name: 'kW·h / t',
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
        axisLabel: { color: '#94a3b8', fontSize: 10 },
    },
    series: [
        {
            name: '用电',
            type: 'line',
            smooth: true,
            data: [210, 280, 340, 400, 370, 310],
            itemStyle: { color: '#fbbf24' },
            lineStyle: { width: 2 },
            symbol: 'circle',
            symbolSize: 4,
        },
        {
            name: '用水',
            type: 'line',
            smooth: true,
            data: [5.2, 6.1, 7.8, 8.5, 7.0, 5.8],
            itemStyle: { color: '#38bdf8' },
            lineStyle: { width: 2 },
            symbol: 'circle',
            symbolSize: 4,
        },
    ],
};

function TrafficMonitor() {
    return (
        <Panel title="车流能耗">
            <div className="flex flex-col h-full gap-2">
                <div className="flex-1 min-h-0">
                    <div className="text-xs text-gray-400 mb-1">实时车流量</div>
                    <EChart option={trafficOption} style={{ height: '100%' }} />
                </div>
                <div className="flex-1 min-h-0">
                    <div className="text-xs text-gray-400 mb-1">能耗监测</div>
                    <EChart option={energyOption} style={{ height: '100%' }} />
                </div>
            </div>
        </Panel>
    );
}

export default TrafficMonitor;