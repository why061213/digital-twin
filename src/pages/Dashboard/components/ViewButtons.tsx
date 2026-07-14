import type { ViewMode } from '../types';

type ViewButtonsProps = {
    view: ViewMode;
    onRequestViewChange: (nextView: ViewMode) => void;
};

export function ViewButtons({ view, onRequestViewChange }: ViewButtonsProps) {
    const buttons: Array<[ViewMode, string]> = [
        ['warehouse', '仓库'],
        ['roadMap', 'RM1 长途'],
        ['roadMap2', 'RM2 短途'],
    ];

    return (
        <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 gap-2">
            {buttons.map(([mode, label]) => (
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
            ))}
        </div>
    );
}
