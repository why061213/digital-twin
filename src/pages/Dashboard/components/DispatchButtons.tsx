type DispatchButtonsProps = {
    isDispatching: boolean;
    onDispatch: () => void;
    onBulkDispatch: () => void;
};

export function DispatchButtons({ isDispatching, onDispatch, onBulkDispatch }: DispatchButtonsProps) {
    return (
        <>
            <button
                onClick={onDispatch}
                disabled={isDispatching}
                className="absolute bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-200 shadow-lg backdrop-blur-md transition-all pointer-events-auto hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
                {isDispatching ? '调度中...' : '发起车辆调度'}
            </button>

            <button
                onClick={onBulkDispatch}
                disabled={isDispatching}
                className="absolute bottom-20 left-[calc(50%+5.8rem)] z-40 rounded-full border border-cyan-300/30 bg-cyan-400/10 px-4 py-2 text-xs text-cyan-100 shadow-lg backdrop-blur-md transition-all pointer-events-auto hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
                模拟大宗订单
            </button>
        </>
    );
}