import DigitalFlop from '@/components/DigitalFlop/DigitalFlop';

// 暂时使用静态数据，后续对接 API
const kpiData = [
    { label: '今日产值', value: 128.5, unit: '万元' },
    { label: '运输单量', value: 387, unit: '单' },
    { label: '完成率', value: 94.2, unit: '%' },
    { label: '准点率', value: 97.8, unit: '%' },
];

function KpiCards() {
    return (
        <div className="flex gap-8 items-center h-full">
            {kpiData.map((item) => (
                <div key={item.label} className="flex flex-col items-center min-w-[100px]">
                    <span className="text-xs text-cyan-400/60 tracking-widest mb-1">{item.label}</span>
                    <DigitalFlop value={item.value} unit={item.unit} />
                    {/* 底部发光短线 */}
                    <div className="w-8 h-0.5 mt-1 bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
                </div>
            ))}
        </div>
    );
}

export default KpiCards;