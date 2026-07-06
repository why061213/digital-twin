import type { RoadGroupSummary } from '../types';

type RoadGroupQueueProps = {
    groups: RoadGroupSummary[];
    activeGroupId: string | null;
    isLoading: boolean;
    onSelectGroup: (groupId: string) => void;
};

export function RoadGroupQueue({ groups, activeGroupId, isLoading, onSelectGroup }: RoadGroupQueueProps) {
    if (groups.length === 0) return null;

    return (
        <div className="absolute left-4 top-4 z-40 flex max-w-[calc(100%-2rem)] gap-2 overflow-x-auto rounded-md border border-white/10 bg-slate-950/65 p-2 text-xs text-slate-300 shadow-xl backdrop-blur-md pointer-events-auto">
            {groups.map((group) => (
                <button
                    key={group.groupId}
                    onClick={() => onSelectGroup(group.groupId)}
                    disabled={isLoading && activeGroupId === group.groupId}
                    className={`shrink-0 rounded border px-3 py-1.5 transition-all ${
                        activeGroupId === group.groupId
                            ? 'border-cyan-300/50 bg-cyan-400/15 text-cyan-100'
                            : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                    }`}
                >
                    第 {group.index + 1} 组 · {group.count} 条
                </button>
            ))}
        </div>
    );
}