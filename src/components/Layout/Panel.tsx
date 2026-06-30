import type { ReactNode } from 'react';

interface PanelProps {
    title: string;
    children: ReactNode;
    className?: string;
}

function Panel({ title, children, className = '' }: PanelProps) {
    return (
        <section
            className={`
                relative h-full overflow-hidden rounded-md border border-cyan-200/10
                bg-slate-950/58 shadow-[0_18px_48px_rgba(2,8,23,0.42)]
                backdrop-blur-md
                before:pointer-events-none before:absolute before:inset-0 before:rounded-md
                before:bg-[linear-gradient(135deg,rgba(34,211,238,0.12),transparent_32%,rgba(16,185,129,0.06))]
                after:pointer-events-none after:absolute after:inset-x-4 after:top-0 after:h-px
                after:bg-gradient-to-r after:from-transparent after:via-cyan-200/45 after:to-transparent
                ${className}
            `}
        >
            <div className="relative flex h-11 items-center gap-2 border-b border-white/8 px-4">
                <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_16px_rgba(103,232,249,0.9)]" />
                <span className="text-sm font-medium text-cyan-100">{title}</span>
            </div>

            <div className="relative h-[calc(100%-2.75rem)] p-3">
                {children}
            </div>
        </section>
    );
}

export default Panel;
