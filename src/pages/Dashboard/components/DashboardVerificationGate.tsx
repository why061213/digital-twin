import { useEffect, useState } from 'react';
import { fetchBootstrapStatus, type BootstrapStatus } from '../services/bootstrapApi';

type DashboardVerificationGateProps = {
    onVerified: () => void;
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

export function DashboardVerificationGate({ onVerified }: DashboardVerificationGateProps) {
    const [status, setStatus] = useState(INITIAL_STATUS);

    useEffect(() => {
        let disposed = false;
        let timer: number | null = null;
        let controller: AbortController | null = null;

        const poll = async () => {
            controller?.abort();
            controller = new AbortController();
            try {
                const next = await fetchBootstrapStatus(controller.signal);
                if (disposed) return;
                setStatus(next);
                if (next.ready) {
                    timer = window.setTimeout(onVerified, 450);
                    return;
                }
                timer = window.setTimeout(poll, Math.max(800, next.retryAfterMs ?? 1500));
            } catch (error) {
                if (disposed || controller.signal.aborted) return;
                setStatus((current) => ({
                    ...current,
                    phase: 'connecting',
                    message: error instanceof Error ? error.message : '后端暂未响应',
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
    }, [onVerified]);

    const unauthorized = status.phase === 'unauthorized';
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
                    <p className={`text-sm ${unauthorized ? 'text-rose-300' : 'text-slate-300'}`}>{status.message}</p>
                    {status.deviceIdentity && <p className="mt-2 text-xs text-slate-500">设备标识 {status.deviceIdentity}</p>}
                    {status.dataInitialized && (
                        <p className="mt-2 text-xs tabular-nums text-slate-500">
                            已接收 {status.rawCount} 条记录，生成 {status.routeCount} 条运输路线
                        </p>
                    )}
                    {status.lastError && <p className="mt-2 text-xs text-amber-300/80">{status.lastError}</p>}
                </div>
            </section>
        </main>
    );
}
