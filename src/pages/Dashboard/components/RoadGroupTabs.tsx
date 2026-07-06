import { ROAD_GROUP_STRATEGIES } from '../constants';
import type { RoadGroupStrategy } from '../types';

type RoadGroupTabsProps = {
    activeStrategy: RoadGroupStrategy;
    onStrategyChange: (strategy: RoadGroupStrategy) => void;
};

export function RoadGroupTabs({ activeStrategy, onStrategyChange }: RoadGroupTabsProps) {
    return (
        <div className="absolute right-[calc(25%+2rem)] top-24 z-50 rounded-full border border-white/10 bg-slate-950/75 p-2 shadow-xl backdrop-blur-md pointer-events-auto">
            <div className="relative flex">
        <span
            className="absolute top-0 h-8 w-16 rounded-full border border-cyan-300/25 bg-cyan-300/15 shadow-[0_0_18px_rgba(34,211,238,0.18)] transition-transform duration-300"
            style={{
                transform: `translateX(${ROAD_GROUP_STRATEGIES.findIndex((s) => s.value === activeStrategy) * 4}rem)`,
            }}
        />
                {ROAD_GROUP_STRATEGIES.map((strategy) => (
                    <button
                        key={strategy.value}
                        onClick={() => onStrategyChange(strategy.value)}
                        className={`relative z-10 flex h-8 w-16 items-center justify-center rounded-full text-xs transition-colors ${
                            activeStrategy === strategy.value
                                ? 'text-cyan-100'
                                : 'text-slate-400 hover:text-slate-100'
                        }`}
                    >
                        {strategy.label}
                        {strategy.badge && (
                            <span className="absolute -right-0.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-300 px-1 text-[9px] text-slate-950">
                {strategy.badge}
              </span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
}