export const LABEL_CONFIG = {
    /** 标签排斥影响半径（像素） */
    neighborRadius: 128,
    /** 标签距锚点的最小距离（像素） */
    minDistance: 50,
    /** 标签距锚点的最大距离（像素） */
    maxDistance: 140,
    /** 卡片宽度（像素） */
    cardWidth: 132,
    /** 卡片高度（像素） */
    cardHeight: 56,
    /** 城市锚点安全边距（像素） */
    citySafeMargin: 22,
    /** 局部排斥权重（同簇内） */
    localWeightMultiplier: 4.0,
    /** 重叠排斥权重 */
    overlapWeightMultiplier: 1.5,
    /** 全局排斥权重 */
    globalWeightMultiplier: 0.2,
    /** 屏幕中心向外推力权重 */
    outwardWeight: -1.5,
    /** 簇外向推力权重（多城市时） */
    clusterOutwardStrong: 1.6,
    /** 簇外向推力权重（单城市时） */
    clusterOutwardWeak: 0.45,
    /** 垂直方向压缩系数 */
    verticalCompression: 0.78,
    /** 垂直偏差范围（像素） */
    verticalBiasRange: 14,
    /** 安全边距迭代次数 */
    safeMarginPasses: 3,
    /** 水平推移最大值 */
    maxHorizontalPush: 30,
    /** 垂直推移最大值 */
    maxVerticalPush: 34,
    /** 相机距离缩放系数 */
    zoomScaleFactor: 0.5,
    overlapDirectionScale: 1.15,
    /** 密度系数 (原 18) */
    densityFactor: 18,
    /** 最近距离惩罚系数 (原 0.22) */
    nearestDistanceFactor: 0.22,
    /** 缩放后的标签距离下限 (原 46) */
    zoomClampMin: 46,
    /** 垂直推移系数 (原 0.8) */
    verticalPushFactor: 0.8,
    /** 水平推移系数 (原 0.45) */
    horizontalPushFactor: 0.45,

    panels: {
        /** 面板宽度（像素） */
        width: 180,
        /** 面板最小宽度（像素） */
        minWidth: 240,
        /** 面板最小高度（像素） */
        minHeight: 200,
        /** 面板最大高度（像素） */
        maxHeight: 240,
        /** 是否显示面板引导线和端点 */
        showLeaderLines: false,
        /** 面板背景色 */
        backgroundColor: 'rgba(2,6,23,0.92)',
        /** 面板边框 */
        border: '1px solid rgba(103,232,249,0.32)',
        /** 面板圆角 */
        borderRadius: 8,
        /** 面板内边距 */
        padding: 10,
        /** 面板与标签之间的间距（像素） */
        gapFromLabel: 16,
        /** 面板布局方向：'right' | 'bottom' */
        direction: 'right' as 'right' | 'bottom',
        /** 面板内部的表格行高（像素） */
        rowHeight: 28,
        /** 面板标题字体大小 */
        titleFontSize: 12,
        /** 面板正文字体大小 */
        bodyFontSize: 10,
    },
    warehouseTour: {
        focusHold: 4000,     // 聚焦单个仓库的停留时间
        overviewHold: 900,   // 俯瞰所有仓库的停留时间
        loopHold: 900,       // 每轮巡游结束后的等待时间
        startDelay: 3000,     // 开始到镜头爬升的等待时间
    },
    globalPlayback: {
        /** 是否启用 ChinaMap → RM1 → RM2 的全局环形播放链。 */
        enabled: true,
        /** ChinaMap 仓库巡游循环次数，达到后进入 RM1 */
        chinaMapLoopCount: 2,
        /** RM2 内部分组完整巡游次数，达到后进入大循环 End；0 表示无限循环。 */
        rm2LoopCount: 2,
        /** 整个大循环 (ChinaMap→RM1→RM2→End) 的总次数，0=无限循环 */
        totalLoopCount: 2,
        /** RM1 每个路线组展示完毕后停留（ms），0 表示立即切换下一个 */
        rm1GroupHoldMs: 0,
        /** RM2 视图中无内容时等待后重试的间隔（ms） */
        emptyViewRetryMs: 5000,
        /** 进入 RM1/RM2 后暂停耗尽检测，等待首批分组加载完成。 */
        viewCooldownMs: 5000,
        /** 底部直达按钮；false 时不渲染，也不会占据点击区域。 */
        directViewButtons: {
            chinaMap: false,
            roadMap: false,
            roadMap2: false,
        },
        /** 顶部路线组直达按钮；仅隐藏人工切组入口，不影响自动组轮播。 */
        directGroupButtons: {
            rm1: false,
            rm2: true,
        },
    },
};
