import type { ReactNode } from 'react'

interface MainLayoutProps {
    header: ReactNode
    leftPanel: ReactNode
    centerPanel: ReactNode
    rightPanel: ReactNode
}

function MainLayout({ header, leftPanel, centerPanel, rightPanel }: MainLayoutProps) {
    return (
        <div className="relative w-screen h-screen bg-[#0a0e17] overflow-hidden">
            {/* 全屏 3D 场景容器（铺满整个屏幕） */}
            <div className="absolute inset-0 z-0">
                {centerPanel}
            </div>

            {/* 顶部标题与 KPI - 悬浮在上方 */}
            <div className="absolute top-0 left-0 right-0 z-20 h-20 px-6 flex items-center pointer-events-none">
                <div className="pointer-events-auto w-full">{header}</div>
            </div>

            {/* 左侧面板 - 悬浮在左侧 */}
            <div className="absolute left-0 top-20 bottom-0 z-20 w-[22%] p-4 pointer-events-none">
                <div className="pointer-events-auto h-full">{leftPanel}</div>
            </div>

            {/* 右侧面板 - 悬浮在右侧 */}
            <div className="absolute right-0 top-20 bottom-0 z-20 w-[25%] p-4 flex flex-col gap-3 pointer-events-none">
                <div className="pointer-events-auto flex-1 flex flex-col gap-3 h-full">{rightPanel}</div>
            </div>
        </div>
    )
}

export default MainLayout