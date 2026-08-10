import type { ViewMode } from '../types';
import { LABEL_CONFIG } from '@/config/labelLayout';

type ViewButtonsProps = {
    view: ViewMode;
    onRequestViewChange: (nextView: ViewMode) => void;
};

export function ViewButtons({ view, onRequestViewChange }: ViewButtonsProps) {
    const allButtons: Array<[ViewMode, string]> = [
        ['chinaMap', '全国地图'],
        ['roadMap', 'RM1 长途'],
        ['roadMap2', 'RM2 短途'],
    ];
    const buttons = allButtons.filter(
        ([mode]) => LABEL_CONFIG.globalPlayback.directViewButtons[mode],
    );

    if (buttons.length === 0) return null;

    return (
        <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 gap-2">
            {buttons.map(([mode, label]) => {
                return (
                    <button
                        key={mode}
                        onClick={() => onRequestViewChange(mode)}
                        className={`rounded-full border px-4 py-2 text-xs shadow-lg backdrop-blur-md transition-all pointer-events-auto ${
                            view === mode
                                ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-300'
                                : 'border-white/10 bg-white/10 text-gray-400 hover:bg-white/20'
                        }`}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}
