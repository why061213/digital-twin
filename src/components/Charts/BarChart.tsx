import EChart from './EChart';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

const option: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '12%', top: 20, containLabel: true },
    xAxis: {
        type: 'category',
        data: ['1月', '2月', '3月', '4月', '5月', '6月'],
        axisLabel: { color: '#94a3b8', fontSize: 10 },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
    },
    yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
        axisLabel: { color: '#94a3b8', fontSize: 10 },
    },
    series: [
        {
            name: '入库量',
            type: 'bar',
            data: [4200, 3800, 5100, 4600, 5300, 4900],
            itemStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: '#22d3ee' },
                    { offset: 1, color: '#0e7490' },
                ]),
                borderRadius: [4, 4, 0, 0],
            },
            barWidth: '35%',
        },
        {
            name: '出库量',
            type: 'bar',
            data: [3900, 3600, 4800, 4400, 5000, 4700],
            itemStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: '#818cf8' },
                    { offset: 1, color: '#4338ca' },
                ]),
                borderRadius: [4, 4, 0, 0],
            },
            barWidth: '35%',
        },
    ],
    legend: {
        orient: 'horizontal',
        bottom: 0,
        left: 'center',
        textStyle: { color: '#94a3b8', fontSize: 10 },
    },
};

function BarChart() {
    return <EChart option={option} style={{ height: '100%' }} />;
}

export default BarChart;