import type { ViewMode } from '../types';

type ViewButtonsProps = {
    view: ViewMode;
    isPreparingChinaMap: boolean;
    isRevealingChinaMap: boolean;
    isPreparingRoadMap: boolean;
    isRevealingRoadMap: boolean;
    onRequestViewChange: (nextView: ViewMode) => void;
};

type ViewItem = {
    key: ViewMode;
    label: string;
    preparingLabel?: string;
};

const viewItems: ViewItem[] = [
    { key: 'chinaMap', label: '仓库巡游', preparingLabel: '仓库巡游准备中...' },
    { key: 'roadMap', label: '全国干线', preparingLabel: '干线地图准备中...' },
    { key: 'townRoadMap', label: '区镇短途' },
];

export function ViewButtons({
    view,
    isPreparingChinaMap,
    isRevealingChinaMap,
    isPreparingRoadMap,
    isRevealingRoadMap,
    onRequestViewChange,
}: ViewButtonsProps) {
    const chinaTransitioning = isPreparingChinaMap || isRevealingChinaMap;
    const roadTransitioning = isPreparingRoadMap || isRevealingRoadMap;
    const isTransitioning = chinaTransitioning || roadTransitioning;

    return (
        <div className="pointer-events-auto fixed left-1/2 top-[92px] z-[9999] flex -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-300/20 bg-slate-950/80 px-2 py-2 shadow-2xl shadow-cyan-950/40 backdrop-blur-md">
            {viewItems.map((item) => {
                const isPreparingThisView =
                    (item.key === 'chinaMap' && chinaTransitioning) ||
                    (item.key === 'roadMap' && roadTransitioning);
                const active = view === item.key || isPreparingThisView;
                const disabled = isTransitioning && !active;
                const label = isPreparingThisView && item.preparingLabel ? item.preparingLabel : item.label;

                return (
                    <button
                        key={item.key}
                        type="button"
                        disabled={disabled}
                        onClick={() => onRequestViewChange(item.key)}
                        className={`pointer-events-auto rounded-full border px-4 py-2 text-xs shadow-lg backdrop-blur-md transition-all ${
                            active
                                ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-200'
                                : 'border-white/10 bg-white/10 text-gray-400 hover:border-cyan-300/30 hover:bg-white/20 hover:text-cyan-100'
                        } ${disabled ? 'cursor-not-allowed opacity-45' : ''}`}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}
