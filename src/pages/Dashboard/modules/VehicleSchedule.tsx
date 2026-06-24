import Panel from '@/components/Layout/Panel';

// 模拟排队数据
const queueData = [
    { plate: '粤A·HQ7832', cargo: '铝锭', estimated: '14:20', status: '装载中' },
    { plate: '湘E·LA4512', cargo: '铜材', estimated: '14:35', status: '待装载' },
    { plate: '赣C·TQ1129', cargo: '钢材', estimated: '15:00', status: '待装载' },
    { plate: '粤B·MD5521', cargo: '化工原料', estimated: '15:15', status: '待装载' },
];

function VehicleSchedule() {
    return (
        <Panel title="车辆调度">
            <div className="flex flex-col h-full">
                {/* 表头 */}
                <div
                    className="grid grid-cols-[1.5fr_1fr_1fr_1fr] gap-1 text-xs text-gray-400 pb-1 border-b border-white/5 mb-2">
                    <span>车牌号</span>
                    <span>货物</span>
                    <span>预计完成</span>
                    <span>状态</span>
                </div>

                {/* 列表 */}
                <div className="flex-1 overflow-y-auto space-y-1">
                    {queueData.map((item, idx) => (
                        <div
                            key={idx}
                            className="grid grid-cols-[1.5fr_1fr_1fr_1fr] gap-1 text-xs text-gray-200 py-1.5 border-b border-white/5 last:border-0"
                        >
                            <span className="text-cyan-300/80">{item.plate}</span>
                            <span>{item.cargo}</span>
                            <span>{item.estimated}</span>
                            <span className={item.status === '装载中' ? 'text-green-400' : 'text-orange-400'}>
      {item.status}
    </span>
                        </div>
                    ))}
                </div>

                {/* 底部汇总 */}
                <div className="pt-2 mt-1 border-t border-white/5 text-xs text-gray-400 flex justify-between">
                    <span>已用车辆: 24</span>
                    <span>空闲车辆: 8</span>
                </div>
            </div>
        </Panel>
    );
}

export default VehicleSchedule;