export type LonLat = [number, number];

export type TownBoundaryLayerName = 'province' | 'city' | 'district';

export type TownBoundaryLayers = Partial<Record<TownBoundaryLayerName, any[]>>;

export type TownAnimationStageKind =
    | 'scene_boot'
    | 'route_group_focus'
    | 'candidate_path_focus'
    | 'province_edge_highlight'
    | 'order_batch_focus';

export type TownAnimationPlaybackStatus = 'pending' | 'playing' | 'played' | 'skipped';

export type TownAnimationStage = {
    id: string;
    kind: TownAnimationStageKind;
    sceneKey: string;
    commandId?: string;
    label: string;
    version: string;
    playbackStatus: TownAnimationPlaybackStatus;
    /** 当前正在播放或准备播放的节点可以锁住，后端增量更新默认不覆盖 locked 节点。 */
    locked?: boolean;
    payload: {
        routeGroupId?: string;
        candidatePathId?: string;
        edgeKey?: string;
        edgeKeys?: string[];
        provincePath?: string[];
        orderLineIds?: string[];
        renderProvinces?: string[];
    };
};

export type TownGeoFeatureCollection = {
    type: 'FeatureCollection';
    features: any[];
    boundaryFeatures?: TownBoundaryLayers;
};

export type TownRouteEndpoint = {
    name: string;
    province?: string;
    city?: string;
    district?: string;
    town?: string;
    adcode?: string;
    /**
     * from/to 坐标建议后端清洗后都传。
     * 如果某条订单缺坐标，前端仍保留订单数据，只是不画该订单线路。
     */
    coords?: LonLat;
};

/**
 * 后端已经筛选好的短途订单/车辆任务。
 * 前端不做长短途判断，只消费后端给到 TownRoadMap 的 orders。
 */
export type TownTransportOrder = {
    orderId: string | null;
    lineId: string;
    groupId?: string;
    groupName?: string;
    from: TownRouteEndpoint;
    to: TownRouteEndpoint;
    vehicle: {
        plate: string;
        carId: string;
        cargoWeight?: number;
        cargoUnit?: string;
        currentCoords?: LonLat | null;
        speedKmh?: number | null;
    };
    status: '待装载' | '装载中' | '运输中' | '已完成' | '已取消' | string;
    updatedAt: string;
    deleted?: boolean;
    upToDate?: boolean;

    /** 前端展示辅助字段：后端可以先不传。 */
    coordinates?: LonLat[];
    routeLengthKm?: number;
    speedKmh?: number;
};

export type TownTransportTask = TownTransportOrder;

export type TownSourceProvince = {
    provinceKey: string;
    provinceName: string;
};

export type TownCandidatePath = {
    pathId: string;
    provincePath: string[];
    provinceNames?: string[];
    edgeKeys?: string[];
    pathCost?: number | null;
    bestPath?: boolean | null;
    primaryOrderLineIds?: string[];
    alongOrderLineIds?: string[];
};

export type TownRouteGroup = {
    groupId: string;
    groupName: string;
    fromProvinceKey?: string;
    fromProvinceName?: string;
    toProvinceKey?: string;
    toProvinceName?: string;
    primaryOrderLineIds?: string[];
    alongOrderLineIds?: string[];
    candidatePaths?: TownCandidatePath[];
};

export type TownProvinceEdge = {
    edgeKey: string;
    fromProvinceKey: string;
    fromProvinceName?: string;
    toProvinceKey: string;
    toProvinceName?: string;
    routeGroupIds?: string[];
    pathIds?: string[];
    primaryOrderLineIds?: string[];
    alongOrderLineIds?: string[];
    orderLineIds?: string[];
    orderCount?: number;
};

export type TownRoadDiffSummary = {
    added?: number;
    updated?: number;
    deleted?: number;
    unchanged?: number;
    routeChanged?: number;
    skippedInvalid?: number;
    skippedNotRenderable?: number;
    skippedLongHaul?: number;
};

/**
 * 单个真正可执行的 TownRoadMap 渲染命令。
 */
export type TownRoadRenderCommand = {
    type: 'town_road_render';
    commandId?: string;
    title?: string;
    description?: string;
    sourceProvince?: TownSourceProvince;

    /** 正式字段：只放省级 adcode，例如 440000、350000。 */
    renderProvinces?: string[];

    /** 后端已经筛选好的二级路线组，用于后续轮播/动画编排。 */
    routeGroups?: TownRouteGroup[];

    /** 后端生成的省份边索引，用于后续路线边高亮/动画编排。 */
    provinceEdges?: TownProvinceEdge[];

    /** 正式字段：后端筛选好的订单列表。 */
    orders?: TownTransportOrder[];

    /** @deprecated 旧字段：默认按 province-district 执行。 */
    renderLevel?: 'province' | 'province-city' | 'province-district' | 'city' | 'district' | 'mixed';

    /** @deprecated 旧字段：请使用 renderProvinces。 */
    renderAdcodes?: string[];

    /** @deprecated 旧字段：请使用 orders。 */
    tasks?: TownTransportOrder[];

    issuedAt?: string;
};

/**
 * 后端一次轮询/模拟广播的外层结果。
 * 注意：这个 wrapper 不能直接丢给地图渲染，真正的渲染命令在 commands[] 里。
 */
export type TownRoadRenderEnvelope = {
    ok?: boolean;
    type: 'town_road_render';
    /** 后端可以指定主场景。没有这个字段时，前端会按订单数/路径数自动选择最大场景。 */
    primaryCommandId?: string;
    activeCommandId?: string;
    message?: string;
    rawCount?: number;
    normalizedCount?: number;
    shortHaulCount?: number;
    commandCount?: number;
    diff?: TownRoadDiffSummary;
    commands: TownRoadRenderCommand[];
};

export type TownRoadRenderIncoming =
    | TownRoadRenderCommand
    | TownRoadRenderCommand[]
    | TownRoadRenderEnvelope;

export type TownRoadMap3DHandle = {
    setRoute: (fromCoords: LonLat, toCoords: LonLat) => void;
    setTransportTasks: (tasks: TownTransportOrder[]) => void;
    setRenderCommand: (command: TownRoadRenderCommand) => void;
    /** 预留动画启动入口：这一版只接收阶段，不执行具体 Three 动画。 */
    startAnimationStage?: (stage: TownAnimationStage) => void;
    /** 预留动画播放入口：下一步按 stage.kind 分发镜头、路径、边和订单动画。 */
    playAnimationStage?: (stage: TownAnimationStage) => void;
    clearRoutes: () => void;
};

export type TownRouteInput = TownTransportOrder;

export type TownRoutePanelState = {
    groupId?: string | null;
    groupName?: string;
    routes: TownTransportOrder[];
};
