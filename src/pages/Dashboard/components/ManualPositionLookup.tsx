type ManualPositionLookupProps = {
    carId: string;
    onCarIdChange: (value: string) => void;
    onQuery: () => void;
    isQuerying: boolean;
    status: string;
};

export function ManualPositionLookup({
                                         carId,
                                         onCarIdChange,
                                         onQuery,
                                         isQuerying,
                                         status,
                                     }: ManualPositionLookupProps) {
    return (
        <div className="absolute bottom-36 left-4 z-40 w-[min(24rem,calc(100%-2rem))] rounded-md border border-white/10 bg-slate-950/75 p-2 text-xs text-slate-300 shadow-xl backdrop-blur-md pointer-events-auto">
            <div className="flex gap-2">
                <input
                    type="text"
                    value={carId}
                    onChange={(e) => onCarIdChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') onQuery();
                    }}
                    placeholder="输入车辆ID"
                    className="min-w-0 flex-1 rounded border border-white/10 bg-slate-900/80 px-3 py-1.5 text-xs text-white outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-300/45"
                />
                <button
                    onClick={onQuery}
                    disabled={isQuerying || !carId.trim()}
                    className="shrink-0 rounded border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {isQuerying ? '查询中' : '查询位置'}
                </button>
            </div>
            {status && (
                <div className="mt-2 truncate text-[11px] text-slate-400" title={status}>
                    {status}
                </div>
            )}
        </div>
    );
}