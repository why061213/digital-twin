import Panel from '@/components/Layout/Panel';
import PieChart from '@/components/Charts/PieChart';
import BarChart from '@/components/Charts/BarChart';

const summary = {
    total: 12980,
    todayIn: 345,
    todayOut: 278,
};

function InventoryStats() {
    return (
        <Panel title="仓储库存">
            <div className="flex flex-col h-full gap-2">
                <div className="grid grid-cols-3 gap-2 flex-shrink-0">
                    <div className="text-center">
                        <div className="text-xs text-gray-400">总库存</div>
                        <div className="text-cyan-300 font-bold text-lg">{summary.total.toLocaleString()}</div>
                        <div className="text-xs text-gray-500">吨</div>
                    </div>
                    <div className="text-center">
                        <div className="text-xs text-gray-400">今日入库</div>
                        <div className="text-green-400 font-bold text-lg">{summary.todayIn}</div>
                        <div className="text-xs text-gray-500">吨</div>
                    </div>
                    <div className="text-center">
                        <div className="text-xs text-gray-400">今日出库</div>
                        <div className="text-orange-400 font-bold text-lg">{summary.todayOut}</div>
                        <div className="text-xs text-gray-500">吨</div>
                    </div>
                </div>

                <div className="w-full flex-1 min-h-0">
                    <PieChart />
                </div>
                <div className="w-full flex-1 min-h-0">
                    <BarChart />
                </div>
            </div>
        </Panel>
    );
}

export default InventoryStats;