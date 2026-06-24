import Clock from '@/components/RealTimeClock/Clock';
import KpiCards from '@/pages/Dashboard/modules/KpiCards';

function Header() {
    return (
        <div className="flex items-center justify-between w-full gap-8 bg-white/[0.03] backdrop-blur-xl rounded-sm px-4 py-2 border border-white/10 shadow-[0_4px_16px_rgba(0,0,0,0.3)]">
            {/* 左侧标题 */}
            <div className="flex-shrink-0">
                <h1 className="text-cyan-300 text-2xl font-bold tracking-wide whitespace-nowrap">
                    炬申智慧物流数字孪生大屏
                </h1>
            </div>

            {/* 中间 KPI 卡片 */}
            <div className="flex-1 flex justify-center">
                <KpiCards />
            </div>

            {/* 右侧时钟 */}
            <div className="flex-shrink-0">
                <Clock />
            </div>
        </div>
    );
}

export default Header;