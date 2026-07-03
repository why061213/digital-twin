import type { ReactNode } from 'react';

interface MainLayoutProps {
    header: ReactNode;
    leftPanel: ReactNode;
    centerPanel: ReactNode;
    rightPanel: ReactNode;
}

function MainLayout({ header, leftPanel, centerPanel, rightPanel }: MainLayoutProps) {
    return (
        <div className="relative h-screen w-screen overflow-hidden bg-[#050914] text-slate-100">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(14,165,233,0.16),transparent_34%),linear-gradient(180deg,#06111f_0%,#050914_58%,#030712_100%)]" />
            <div className="pointer-events-none absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(148,163,184,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.5)_1px,transparent_1px)] [background-size:56px_56px]" />

            <div className="absolute inset-0 z-0">
                {centerPanel}
            </div>

            <div className="pointer-events-none absolute left-0 right-0 top-0 z-20 h-20 px-6">
                <div className="pointer-events-auto h-full">{header}</div>
            </div>

            {leftPanel && (
                <aside className="pointer-events-none absolute bottom-4 left-4 top-20 z-20 w-[22%] min-w-[260px]">
                    <div className="pointer-events-auto h-full">{leftPanel}</div>
                </aside>
            )}

            {rightPanel && (
                <aside className="pointer-events-none absolute bottom-4 right-4 top-20 z-20 w-[25%] min-w-[300px]">
                    <div className="pointer-events-auto flex h-full flex-col gap-3">{rightPanel}</div>
                </aside>
            )}
        </div>
    );
}

export default MainLayout;
