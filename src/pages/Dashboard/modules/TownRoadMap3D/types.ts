export type LonLat = [number, number];

export type TownBoundaryLayerName = 'province' | 'city' | 'district';

export type TownBoundaryLayers = Partial<Record<TownBoundaryLayerName, any[]>>;

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
     * 真实对接时 from.coords 强烈建议必传；to.coords 如果暂时缺失，
     * 前端仍会接收订单并渲染行政区块，但不会画这条订单路线。
     */
    coords?: LonLat;
};

/**
 * 后端已经筛选好的短途订单/车辆任务。
 * 字段尽量贴近外部服务原始结构，不在前端做长短途判断。
 */
export type TownTransportOrder = {
    orderId: string | null;
    lineId: string;
    from: TownRouteEndpoint;
    to: TownRouteEndpoint;
    vehicle: {
        plate: string;
        carId: string;
        cargoWeight?: number;
        cargoUnit?: string;
    };
    status: '待装载' | '装载中' | '运输中' | '已完成' | '已取消' | string;
    updatedAt: string;
    deleted?: boolean;
    upToDate?: boolean;

    /** 前端展示辅助字段：后端可以先不传。 */
    groupId?: string;
    groupName?: string;
    coordinates?: LonLat[];
    routeLengthKm?: number;
    speedKmh?: number;
};

export type TownTransportTask = TownTransportOrder;

/**
 * 后端发给前端的 TownRoadMap 批量渲染命令。
 * 正式语义：
 * - renderProvinces: 这一屏需要渲染哪些省份，只放省级 adcode。
 * - orders: 后端已经筛选过、确定属于这一屏短途展示的订单列表。
 *
 * renderLevel / renderAdcodes / tasks 是历史兼容字段，后续稳定后可以删掉。
 */
export type TownRoadRenderCommand = {
    type: 'town_road_render';
    commandId?: string;
    title?: string;
    description?: string;

    /** 正式字段：只放省份 adcode，例如 440000、350000。 */
    renderProvinces?: string[];

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

export type TownRoadMap3DHandle = {
    setRoute: (fromCoords: LonLat, toCoords: LonLat) => void;
    setTransportTasks: (tasks: TownTransportOrder[]) => void;
    setRenderCommand: (command: TownRoadRenderCommand) => void;
    clearRoutes: () => void;
};

export type TownRouteInput = TownTransportOrder;

export type TownRoutePanelState = {
    groupId?: string | null;
    groupName?: string;
    routes: TownTransportOrder[];
};
