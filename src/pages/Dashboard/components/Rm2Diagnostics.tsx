import type { Rm2GroupsDiagnostics } from '../services/renderRouteApi';

type Props = { diagnostics: Rm2GroupsDiagnostics | null; isLoading: boolean; onRefresh: () => void };

export function Rm2Diagnostics({ diagnostics, isLoading, onRefresh }: Props) {
    const hasRoutes = diagnostics !== null && diagnostics.acceptedGroupCount > 0;
    return (
        <div className="absolute right-4 top-4 z-40 w-64 border border-white/10 bg-slate-950/75 p-3 text-xs text-slate-300 shadow-xl backdrop-blur-md pointer-events-auto">
            <div className="flex items-center justify-between gap-3">
                <span className={hasRoutes ? 'text-cyan-100' : 'text-amber-200'}>{hasRoutes ? 'RM2 路线诊断' : 'RM2暂无路线'}</span>
                <button type="button" onClick={onRefresh} disabled={isLoading} className="border border-cyan-300/30 px-2 py-1 text-cyan-100 transition hover:bg-cyan-300/10 disabled:opacity-50">
                    {isLoading ? '刷新中' : '刷新'}
                </button>
            </div>
            <div className="mt-2 space-y-1 text-slate-400">
                <div>snapshotVersion: {diagnostics?.snapshotVersion || '-'}</div>
                <div>后端 totalRoutes: {diagnostics?.totalRoutes ?? '-'}</div>
                <div>有效 groups: {diagnostics?.acceptedGroupCount ?? '-'}</div>
                <div>被过滤 groups: {diagnostics?.rejectedGroups.length ?? '-'}</div>
            </div>
            {(diagnostics?.rejectedGroups.length ?? 0) > 0 && <div className="mt-2 max-h-20 overflow-y-auto text-amber-200/80">{diagnostics?.rejectedGroups.join('；')}</div>}
        </div>
    );
}
