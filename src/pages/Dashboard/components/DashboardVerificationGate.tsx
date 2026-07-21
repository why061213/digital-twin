import { useEffect, useRef, useState } from 'react';
import { fetchBootstrapStatus, type BootstrapStatus } from '../services/bootstrapApi';
import {
    adoptDashboardAccessKey,
    clearDashboardSession,
    ensureFreshDashboardSession,
    getDashboardSession,
    issueDashboardSession,
    type DashboardSession,
} from '../services/dashboardAuth';

type DashboardVerificationGateProps = {
    onVerified: () => void;
    standalone?: boolean;
};

const INITIAL_STATUS: BootstrapStatus = {
    ready: false,
    backendReady: false,
    dataInitialized: false,
    authorized: false,
    phase: 'connecting',
    message: '正在连接后端服务',
    rawCount: 0,
    routeCount: 0,
    serverTime: '',
};

function deniedFeedback(status: BootstrapStatus) {
    switch (status.authorizationCode) {
        case 'mac_whitelist_not_configured':
            return {
                title: '服务器尚未配置设备白名单',
                detail: '当前后端启用了设备验证，但允许访问的 MAC 地址列表为空。',
                action: '请管理员在后端配置 dashboard.access.allowed-mac-addresses 后重启服务。',
            };
        case 'device_mac_unresolved':
            return {
                title: '服务器无法识别当前设备',
                detail: '后端未能从局域网邻居表取得该设备的 MAC 地址，常见原因是设备不在同一网段、尚未产生 ARP 记录或经过了代理。',
                action: '请确认设备与服务器处于同一局域网；跨网段设备请使用已分发的访问密钥或设备令牌。',
            };
        case 'device_not_in_mac_whitelist':
            return {
                title: '当前设备未加入访问白名单',
                detail: `服务器已识别设备${status.deviceIdentity ? `（${status.deviceIdentity}）` : ''}，但该 MAC 地址不在允许列表中。`,
                action: '请管理员根据后端拒绝日志中的完整 MAC 地址更新 dashboard.access.allowed-mac-addresses。',
            };
        default:
            return {
                title: '当前设备被拒绝访问',
                detail: status.message || '后端没有授权当前设备进入数字孪生大屏。',
                action: '请检查设备白名单、访问密钥和局域网连接后重试。',
            };
    }
}

function connectionFailureMessage(error: unknown) {
    if (error instanceof TypeError) {
        return '无法连接验证服务：请确认后端已启动、局域网地址可达且反向代理配置正确。';
    }
    return error instanceof Error ? error.message : '后端验证服务暂未响应';
}

function StatusRow({ label, complete, active }: { label: string; complete: boolean; active: boolean }) {
    return (
        <div className="flex h-11 items-center justify-between border-b border-white/8 last:border-b-0">
            <span className="text-sm text-slate-300">{label}</span>
            <span className={`h-2.5 w-2.5 rounded-full ${
                complete
                    ? 'bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.65)]'
                    : active
                        ? 'animate-pulse bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.55)]'
                        : 'bg-slate-700'
            }`} />
        </div>
    );
}

export function DashboardVerificationGate({ onVerified, standalone = false }: DashboardVerificationGateProps) {
    const [status, setStatus] = useState(INITIAL_STATUS);
    const [session, setSession] = useState<DashboardSession | null>(() => getDashboardSession());
    const [manualKey, setManualKey] = useState('');
    const [authError, setAuthError] = useState('');
    const [copyLabel, setCopyLabel] = useState('复制密钥');
    const issuingRef = useRef<Promise<DashboardSession> | null>(null);

    useEffect(() => {
        let disposed = false;
        let timer: number | null = null;
        let controller: AbortController | null = null;

        const poll = async () => {
            controller?.abort();
            controller = new AbortController();
            try {
                let activeSession = getDashboardSession();
                if (activeSession) {
                    try {
                        activeSession = await ensureFreshDashboardSession();
                        if (!disposed) setSession(activeSession);
                    } catch {
                        clearDashboardSession();
                        activeSession = null;
                        if (!disposed) setSession(null);
                    }
                }
                const next = await fetchBootstrapStatus(controller.signal);
                if (disposed) return;
                setStatus(next);
                if (next.authorized && !activeSession) {
                    issuingRef.current ??= issueDashboardSession(controller.signal);
                    try {
                        activeSession = await issuingRef.current;
                        if (!disposed) setSession(activeSession);
                    } finally {
                        issuingRef.current = null;
                    }
                } else if (activeSession && activeSession.accessToken !== session?.accessToken) {
                    setSession(activeSession);
                }
                if (next.ready && activeSession && !standalone) {
                    timer = window.setTimeout(onVerified, 450);
                    return;
                }
                timer = window.setTimeout(poll, Math.max(800, next.retryAfterMs ?? 1500));
            } catch (error) {
                if (disposed || controller.signal.aborted) return;
                setStatus((current) => ({
                    ...current,
                    phase: 'connecting',
                    message: connectionFailureMessage(error),
                }));
                timer = window.setTimeout(poll, 1500);
            }
        };

        void poll();
        return () => {
            disposed = true;
            controller?.abort();
            if (timer !== null) window.clearTimeout(timer);
        };
    }, [onVerified, session?.accessToken, standalone]);

    const applyDistributedKey = async () => {
        setAuthError('');
        try {
            const accepted = await adoptDashboardAccessKey(manualKey);
            setSession(accepted);
            setManualKey('');
        } catch (error) {
            setAuthError(error instanceof Error ? error.message : '访问密钥验证失败');
        }
    };

    const copyKey = async () => {
        if (!session) return;
        await navigator.clipboard.writeText(session.accessToken);
        setCopyLabel('已复制');
        window.setTimeout(() => setCopyLabel('复制密钥'), 1200);
    };

    const unauthorized = status.phase === 'unauthorized';
    const rejection = unauthorized ? deniedFeedback(status) : null;
    return (
        <main className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-[#050914] text-slate-100">
            <div className="pointer-events-none absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(148,163,184,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.5)_1px,transparent_1px)] [background-size:56px_56px]" />
            <section className="relative z-10 w-[min(92vw,460px)] border border-white/12 bg-[#091321]/95 p-7 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
                <div className="mb-6 flex items-start justify-between gap-5">
                    <div>
                        <p className="mb-2 text-xs text-cyan-300/70">炬申智慧物流数字孪生</p>
                        <h1 className="text-xl font-semibold text-slate-100">设备验证</h1>
                    </div>
                    <span className={`mt-1 h-3 w-3 rounded-full ${status.ready ? 'bg-emerald-300' : unauthorized ? 'bg-rose-400' : 'animate-pulse bg-cyan-300'}`} />
                </div>

                <div className="mb-5 border-y border-white/8">
                    <StatusRow label="后端服务" complete={status.backendReady} active={!status.backendReady} />
                    <StatusRow label="局域网设备" complete={status.authorized} active={status.backendReady && !status.authorized} />
                    <StatusRow label="订单与路线数据" complete={status.dataInitialized} active={status.authorized && !status.dataInitialized} />
                </div>

                <div className="min-h-14">
                    <p className={`text-sm ${unauthorized ? 'font-semibold text-rose-200' : 'text-slate-300'}`}>
                        {rejection?.title ?? status.message}
                    </p>
                    {rejection && (
                        <div className="mt-3 border border-rose-300/20 bg-rose-400/[0.065] px-3 py-3">
                            <p className="text-xs leading-5 text-slate-300">{rejection.detail}</p>
                            <p className="mt-2 border-t border-rose-200/10 pt-2 text-xs leading-5 text-rose-200">
                                {rejection.action}
                            </p>
                            <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
                                <dt className="text-slate-500">请求地址</dt>
                                <dd className="truncate font-mono text-slate-300">{status.remoteAddress || '后端未返回'}</dd>
                                <dt className="text-slate-500">设备标识</dt>
                                <dd className="truncate font-mono text-slate-300">{status.deviceIdentity || '未识别'}</dd>
                                <dt className="text-slate-500">拒绝代码</dt>
                                <dd className="truncate font-mono text-rose-300/90">{status.authorizationCode || 'device_not_authorized'}</dd>
                            </dl>
                        </div>
                    )}
                    {!unauthorized && status.deviceIdentity && <p className="mt-2 text-xs text-slate-500">设备标识 {status.deviceIdentity}</p>}
                    {status.dataInitialized && (
                        <p className="mt-2 text-xs tabular-nums text-slate-500">
                            已接收 {status.rawCount} 条记录，生成 {status.routeCount} 条运输路线
                        </p>
                    )}
                    {status.lastError && <p className="mt-2 text-xs text-amber-300/80">{status.lastError}</p>}
                </div>

                {standalone && (
                    <div className="mt-5 border-t border-white/10 pt-5">
                        {session ? (
                            <>
                                <p className="mb-2 text-xs text-slate-400">调试访问密钥</p>
                                <div className="flex gap-2">
                                    <input
                                        readOnly
                                        value={session.accessToken}
                                        className="min-w-0 flex-1 border border-white/10 bg-black/20 px-3 py-2 text-xs text-cyan-200 outline-none"
                                    />
                                    <button type="button" onClick={() => void copyKey()} className="border border-cyan-300/30 px-3 text-xs text-cyan-200 hover:bg-cyan-300/10">
                                        {copyLabel}
                                    </button>
                                </div>
                                <p className="mt-2 text-xs text-slate-500">有效期至 {new Date(session.expiresAt).toLocaleString()}</p>
                                <button
                                    type="button"
                                    disabled={!status.ready}
                                    onClick={onVerified}
                                    className="mt-4 w-full bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    进入数字孪生大屏
                                </button>
                            </>
                        ) : (
                            <>
                                <p className="mb-2 text-xs text-slate-400">使用已分发的访问密钥</p>
                                <div className="flex gap-2">
                                    <input
                                        value={manualKey}
                                        onChange={(event) => setManualKey(event.target.value)}
                                        placeholder="jdt_..."
                                        className="min-w-0 flex-1 border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-100 outline-none focus:border-cyan-300/40"
                                    />
                                    <button type="button" disabled={!manualKey.trim()} onClick={() => void applyDistributedKey()} className="border border-cyan-300/30 px-3 text-xs text-cyan-200 disabled:opacity-40">
                                        验证
                                    </button>
                                </div>
                                {authError && <p className="mt-2 text-xs text-rose-300">{authError}</p>}
                            </>
                        )}
                    </div>
                )}
            </section>
        </main>
    );
}
