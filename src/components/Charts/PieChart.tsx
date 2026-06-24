import EChart from './EChart';
import type { EChartsOption } from 'echarts';

const mockPieData = [
    { name: '铝锭', value: 3200 },
    { name: '铜材', value: 2800 },
    { name: '钢材', value: 4100 },
    { name: '化工原料', value: 1900 },
    { name: '其他', value: 980 },
];

const option: EChartsOption = {
    tooltip: { trigger: 'item' },
    legend: {
        orient: 'horizontal',     // 水平排列，放在底部
        bottom: 0,
        left: 'center',
        textStyle: { color: '#94a3b8', fontSize: 10 },
        itemWidth: 8,
        itemHeight: 8,
    },
    series: [
        {
            type: 'pie',
            radius: ['50%', '70%'],         // 稍微缩小外半径
            center: ['50%', '45%'],         // 上移，给底部图例留空间
            avoidLabelOverlap: false,
            itemStyle: {
                borderRadius: 2,
                borderColor: 'rgba(0,0,0,0.6)',
                borderWidth: 2,
            },
            label: { show: false },
            emphasis: {
                label: { show: true, color: '#e2e8f0' },
            },
            data: mockPieData,
        },
    ],
    color: ['#22d3ee', '#38bdf8', '#818cf8', '#c084fc', '#fb923c'],
};

function PieChart() {
    return <EChart option={option} style={{ height: '100%', width: '100%' }} />;
}

export default PieChart;