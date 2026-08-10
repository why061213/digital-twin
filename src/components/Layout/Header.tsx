import Clock from '@/components/RealTimeClock/Clock';
import KpiCards from '@/pages/Dashboard/modules/KpiCards';

function Header() {
    return (
        <header className="relative grid h-full w-full grid-cols-1 items-center gap-6 overflow-hidden rounded border border-cyan-100/10 bg-slate-950/68 px-4 shadow-[0_12px_34px_rgba(2,8,23,0.38)] backdrop-blur-xl after:pointer-events-none after:absolute after:inset-x-6 after:bottom-0 after:h-px after:bg-gradient-to-r after:from-transparent after:via-cyan-300/45 after:to-transparent lg:grid-cols-[minmax(18rem,1fr)_auto_minmax(15rem,1fr)]">
            <div className="flex min-w-0 items-center gap-3">
                <span className="h-7 w-1 shrink-0 bg-gradient-to-b from-cyan-300 to-emerald-300 shadow-[0_0_14px_rgba(34,211,238,0.45)]" />
                <h1 className="truncate text-base font-bold text-cyan-200 lg:text-xl">
                    炬申智慧物流数字孪生大屏
                </h1>
            </div>

            <div className="hidden justify-center lg:flex">
                <KpiCards />
            </div>

            <div className="hidden shrink-0 justify-end border-l border-white/8 pl-6 lg:flex">
                <Clock />
            </div>
        </header>
    );
}

export default Header;
