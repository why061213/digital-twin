import type { ReactNode } from 'react'

interface PanelProps {
    title: string
    children: ReactNode
    className?: string
}

function Panel({ title, children, className = '' }: PanelProps) {
    return (
        <div
            className={`
        relative h-full
        bg-gradient-to-b from-[rgba(13,19,33,0.6)] to-[rgba(10,14,23,0.8)]
        backdrop-blur-sm
        rounded-sm
        border border-white/5
        shadow-[inset_0_0_30px_rgba(34,211,238,0.03)]
        before:absolute before:inset-0 before:rounded-sm before:border before:border-cyan-400/10 before:pointer-events-none
        ${className}
      `}
        >
            {/* 标题栏 */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
                <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full shadow-[0_0_8px_#22d3ee]" />
                <span className="text-cyan-300/80 text-sm font-medium tracking-wider">{title}</span>
            </div>

            {/* 内容区 */}
            <div className="p-3 h-[calc(100%-3rem)]">
                {children}
            </div>
        </div>
    )
}

export default Panel