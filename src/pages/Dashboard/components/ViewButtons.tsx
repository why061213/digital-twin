import type { ViewMode } from '../types';

type ViewButtonsProps = {
    view: ViewMode;
    isPreparingChinaMap: boolean;
    isRevealingChinaMap: boolean;
    isPreparingRoadMap: boolean;
    isRevealingRoadMap: boolean;
    onRequestViewChange: (nextView: ViewMode) => void;
};

export function ViewButtons({
                                view,
                                isPreparingChinaMap,
                                isRevealingChinaMap,
                                isPreparingRoadMap,
                                isRevealingRoadMap,
                                onRequestViewChange,
                            }: ViewButtonsProps) {
    const buttons: Array<[ViewMode, string]> = [
        ['warehouse', '仓库视图'],
        ['chinaMap', '数字孪生地图'],
        ['roadMap', '道路级地图'],
    ];

    return (
        <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 gap-2">
            {buttons.map(([mode, label]) => {
                const isActive =
                    view === mode ||
                    (mode === 'chinaMap' && (isPreparingChinaMap || isRevealingChinaMap)) ||
                    (mode === 'roadMap' && (isPreparingRoadMap || isRevealingRoadMap));

                let displayLabel = label;
                if (mode === 'chinaMap' && (isPreparingChinaMap || isRevealingChinaMap)) {
                    displayLabel = '数字孪生准备中...';
                } else if (mode === 'roadMap' && (isPreparingRoadMap || isRevealingRoadMap)) {
                    displayLabel = '道路地图准备中...';
                }

                return (
                    <button
                        key={mode}
                        onClick={() => onRequestViewChange(mode)}
                        className={`rounded-full border px-4 py-2 text-xs shadow-lg backdrop-blur-md transition-all pointer-events-auto ${
                            isActive
                                ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-300'
                                : 'border-white/10 bg-white/10 text-gray-400 hover:bg-white/20'
                        }`}
                    >
                        {displayLabel}
                    </button>
                );
            })}
        </div>
    );
}