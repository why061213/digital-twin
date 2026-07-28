# 聚申数字孪生平台 — 技术交接文档

> 版本：2026-07-28 | 前端 `dashboard-v2` | 后端 `dashboard-v2`

---

## 目录

1. [系统架构概览](#1-系统架构概览)
2. [完整数据流水线](#2-完整数据流水线)
3. [API 接口清单](#3-api-接口清单)
4. [前端视图体系](#4-前端视图体系)
5. [RoadMap3D-2 核心架构](#5-roadmap3d-2-核心架构)
6. [路线颜色系统](#6-路线颜色系统)
7. [3D 车辆系统](#7-3d-车辆系统)
8. [位置投影算法](#8-位置投影算法)
9. [后端关键服务](#9-后端关键服务)
10. [配置参考](#10-配置参考)
11. [附录 A — 文件索引](#附录-a--文件索引)
12. [附录 B — 关键变量速查](#附录-b--关键变量速查)

---

## 1. 系统架构概览

```
┌────────────────────────────────────────────────────┐
│                    前端 (React + Three.js)           │
│  DashboardPage → 多个视图(ChinaMap3D/RM1/RM2)       │
│  数据拉取: REST API + WebSocket                      │
└────────────────────┬───────────────────────────────┘
                     │ HTTP / WS
┌────────────────────┴───────────────────────────────┐
│               后端 (Spring Boot + Java 17)           │
│  │ RoutePushService        路线推送/位置模拟         │
│  │ TownRoadRenderService   RM2数据完整管线入口       │
│  │ TownRoadMiddleLayer     数据清洗+路线编排          │
│  │ VehiclePositionCache    车辆位置缓存+批量刷新      │
│  │ RoutePlanningService    百度/高德路线规划          │
│  │ Rm2GroupQueryService    RM2稳定分组查询            │
│  │ RealtimeWebSocket       WebSocket实时推送         │
└────────────────────────────────────────────────────┘
```

**核心数据流**：

1. 外部订单拉取 → 入口去重 → 预过滤 → 坐标补全 → 路线规划(百度/高德) → 状态分流 → RM2分组 → WebSocket推送
2. 前端请求路线组 → 后端返回分组+坐标 → 前端3D渲染（道路管网+卡车模型+端点标记+标签）
3. 车辆位置：后端定时批量查询外部API → 缓存 → 窗口约束投影校准 → 前端定时拉取 → 3D卡车运动
4. 装载中车辆持续追踪位置 → 偏离初始位置>1km → 自动触发订单同步

---

## 2. 完整数据流水线

### 2.1 数据清洗管线（`TownRoadRenderService` → `TownRoadMiddleLayer`）

```
定时触发 (每15分钟)
  │
  ▼
① 拉取原始订单 ── GET https://api.jushen.co/Freight/DispatchTransitNew/listTransitBoard
  │
  ▼
② 入口去重 ── 按 orderId+lineId+车牌前缀去重，保留updatedAt最晚
  │
  ▼
③ 车辆实例展开 ── 将order.lines[].vehicles[]扁平化
  │
  ▼
④ 预过滤 (isWorthRoutePlanning) ── 排除：无效/无坐标/已删除/已取消/待装载/已完成
  │   ▲ 此步骤在路线规划API调用之前，避免浪费百度/高德API配额
  │
  ▼
⑤ 位置预热 ── 批量查询外部车辆位置API
  │
  ▼
⑥ 坐标补全 ── TownRoadCoordinateResolver：地址→坐标
  │
  ▼
⑦ 路线规划 ── RoutePlanningService：百度优先→高德回退，按OD缓存24h
  │   ├─ baseline路线：起终点最优路径
  │   └─ initialization路线：途经车辆当前位置的路径
  │
  ▼
⑧ 省份路径计算 ── ProvinceRoadGraph → CityRoadGraph(Dijkstra 281城) → DistrictRoadGraph(边境约束)
  │
  ▼
⑨ 规范化 (normalize) ── 生成NormalizedTownRoadOrder，含dataSignature+routeSignature
  │
  ▼
⑩ 状态分流 ── isShortHaul(同省/邻省)→RM2短途 / 跨省→RM1长途
  │             待装载/已完成超时→过滤
  │
  ▼
⑪ RM2分组 ── buildStableGroups(1辆车/组，临时) → buildRm2ChainStructure省→方向→组链表
  │
  ▼
⑫ 指纹比对 ── SHA-256快照指纹，仅变化时广播
  │
  ▼
⑬ WebSocket广播 ── route_snapshot_changed → 前端更新
```

### 2.2 外部API调用汇总

| 外部系统 | API URL | 用途 | 频率 |
|----------|---------|------|------|
| 聚申平台 | `listTransitBoard` | 拉取运输订单 | 每15分钟 |
| 百度地图 | `directionlite/v1/driving` | 轿车路线规划 | 按需，24h缓存 |
| 百度地图 | `logistics_direction/v1/truck` | 货车路线规划 | 按需（开关控制） |
| 高德地图 | `v5/direction/driving` | 轿车路线规划 | 百度失败回退 |
| 高德地图 | `v4/direction/truck` | 货车路线规划 | 按需（开关控制） |
| 外部位置API | `external-position-url` | 车辆实时位置 | 每30-60s批量 |
| 高德地理编码 | `v3/geocode` | 地址→坐标 | 按需 |
| 阿里云DataV | GeoJSON | 省/市/县边界 | 前端按需 |

### 2.3 数据过滤漏斗

```
原始订单 (rawCount)
  │
  ├─ ❌ 入口去重 (同订单+同线路+同车牌)
  ├─ ❌ 预过滤 (isWorthRoutePlanning: 无效/无坐标/已删除/已取消/待装载/已完成)
  │
  = 有效订单 (normalizedCount)
  │
  ├─ ❌ 缺坐标
  ├─ ❌ 跨省长途 → RM1 (roadMapRouteCount)
  ├─ ❌ 待装载/已完成超时
  │
  = 最终RM2渲染 (shortHaulCount) ✅
```

---

## 3. API 接口清单

### 3.1 RM2 专用 — `/api/road/rm2`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/road/rm2/groups` | RM2 稳定分组列表 |
| `GET` | `/api/road/rm2/groups/{id}/routes` | 某组路线详情+位置 |
| `GET` | `/api/road/rm2/snapshot` | 当前分组快照 |
| `GET` | `/api/road/rm2/stable-groups` | 稳定分组（原子快照） |
| `GET` | `/api/road/rm2/diagnostics` | 诊断信息 |
| `GET` | `/api/road/rm2/render-routes/{groupId}` | 渲染路线数据 |
| `GET` | `/api/road/rm2/trucks` | 车辆位置列表 |

### 3.2 公开诊断 — `/api/public/vehicle-order-chain`

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| `GET` | `/api/public/vehicle-order-chain/transit-metrics` | 运输指标 | **免登录** |

### 3.3 鉴权 — `/api/auth` & `/api/bootstrap`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/auth/login` | 登录获取Dashboard访问token |
| `GET` | `/api/bootstrap/status` | 系统启动状态 |
| `GET` | `/api/bootstrap/config` | 系统配置 |

### 3.4 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/road/dispatch` | 派发单条随机路线 |
| `POST` | `/api/road/dispatch/bulk?vehicleCount=24` | 批量派发路线 |
| `GET` | `/api/road/groups?scope=rm1&strategy=xxx` | RM1路线分组 |
| `GET` | `/api/warehouse/snapshot` | 全国仓储快照 |
| `GET` | `/api/warehouse/focus/{cityName}` | 城市仓储详情 |
| `GET` | `/api/road/external-orders/sync` | 触发外部订单同步 |
| `GET` | `/api/road/external-orders/status` | 同步状态 |
| `GET` | `/api/road/town/statistics` | 每日订单统计 |
| `POST` | `/api/town-road/mock/dispatch` | 模拟派发城镇订单 |

---

## 4. 前端视图体系

### 4.1 视图切换

通过 `ViewButtons`：`[R1] [R2] [仓库] [地球]`

| 视图 | 组件 | 说明 |
|------|------|------|
| R1 | ChinaMap3D | 全国地图 + 城市飞线 + 仓储巡游 |
| R2 | RoadMap3D-2 | 省市县道路地图 + 卡车3D模型 |
| 仓库 | Warehouse3D | 3D仓库可视化 |
| 地球 | Earth3D | 地球模块 |

### 4.2 DashboardPage Hook 链

```
DashboardPage
├── useDashboardRealtime()        → WebSocket实时连接
├── useRoadGroupsController()     → 路线组数据(RM1用)
├── useRm2PlaybackController()    → RM2核心：路线加载+组切换+位置校准
├── useWarehouseController()      → 仓储巡游逻辑
├── useTruckPositionController()  → 车辆位置管理(RM1/RM2复用)
└── useVehicleMotionController()  → 3D车辆运动插值
```

### 4.3 RM2 视图数据流时序

```
用户进入RM2视图
  │
  ├─ 1. RoadMap3D-2挂载 → loadCityGeoJson() → 渲染行政边界
  ├─ 2. onVisualReady回调
  ├─ 3. useRm2PlaybackController.refreshRm2() → 获取分组列表
  ├─ 4. 自动播放第一个group → playNode()
  │      ├─ preloadProvinceRegion / preloadDirectionRegions → 预装底图
  │      ├─ fetchRm2GroupRoutes → 获取路线+位置
  │      ├─ preserveBackendRouteIdentity → 设置colorKey(含lineId)
  │      ├─ createActiveRoute → 创建路线（保留已有位置）
  │      ├─ hydrateRoutePositions → 注入真实位置
  │      └─ showRoutes → 3D渲染（道路+端点+标签+卡车）
  ├─ 5. setInterval(durationMs) → 自动切换到下一组
  ├─ 6. handleTruckPosition (WebSocket) → 实时更新卡车位置
  └─ 7. handleMotionRouteFinished → 全部到达→切下一组
```

---

## 5. RoadMap3D-2 核心架构

### 5.1 3D场景结构

```
场景 (Scene)
├── 行政边界层 (provinceRegion / directionRegions)
│   ├── 省级边界 → TubeGeometry 金色管道
│   ├── 市级边界 → ExtrudeGeometry 深蓝填充
│   └── 区县边界 → ExtrudeGeometry 更暗填充
│
├── 路线层 (per pathKey)
│   ├── grayTube → 未走过路线底色(透明度0.10)
│   ├── visualLayers → 屏幕空间辉光线
│   ├── sharedProgressTube → 共享路段彩色流动材质
│   ├── selectionTube → 选中高亮(默认透明)
│   │
│   ├── OrderLane[] → 每条订单车道
│   │   ├── progressTube → 车辆已走过部分(亮色0.95)
│   │   ├── endpointLayer → 起终点标记
│   │   │   ├── createEndpointMarker → 地图钉(光环+杆+钉子)
│   │   │   │   ├── halo → RingGeometry光环
│   │   │   │   ├── stem → CylinderGeometry杆
│   │   │   │   └── pin → ShapeGeometry钉子形状
│   │   │   └── createEndpointLabel → 起点·xxx / 终点·xxx标签
│   │   └── VehicleBar[] → 每辆车
│   │       ├── bar → 车辆进度条(Mesh)
│   │       ├── truckVisual → 3D卡车模型(GLTF)
│   │       └── locator → 选中定位环(RingGeometry)
│   └── snakeProgressTube → 蛇形流动光效
```

### 5.2 地图缩放

```typescript
// geo.ts
MAP_HORIZONTAL_SCALE = 100  // 10倍放大
projection.center = [104.5, 35]
projection.scale = 80
```

### 5.3 行政边界

| 层级 | 渲染方式 | 颜色 | 加载来源 |
|------|---------|------|---------|
| 省 | TubeGeometry管道 | 金色`#f59e0b` | 阿里云DataV `100000_full.json` |
| 市 | ExtrudeGeometry填充 | `#2f465e` | `{省adcode}_full.json` |
| 区县 | ExtrudeGeometry填充 | `#1a2a3a` | `{市adcode}_full.json` |

---

## 6. 路线颜色系统

### 6.1 6色主路线数组

| 索引 | 颜色名 | 3D值 | 面板hex |
|------|--------|------|---------|
| 0 | 蓝 | `0x3b82f6` | `#3b82f6` |
| 1 | 黄 | `0xf59e0b` | `#f59e0b` |
| 2 | 绿 | `0x22c55e` | `#22c55e` |
| 3 | 紫 | `0xa78bfa` | `#a78bfa` |
| 4 | 粉 | `0xfb7185` | `#fb7185` |
| 5 | 青 | `0x2dd4bf` | `#2dd4bf` |

### 6.2 颜色分配逻辑

```
colorKey = "main:orderId:lineId"  (preserveBackendRouteIdentity生成，含lineId确保唯一)
       ↓
stableHash(colorKey) % 6  →  索引0-5
       ↓
ROUTE_COLORS[索引]  →  3D路线颜色
ROUTE_TONES[索引]   →  面板边框/背景颜色
```

**关键：** 面板(`routePresentation.ts`)和3D(`useRoadControls.ts`)使用相同的`stableHash`算法和相同的颜色数组，确保颜色一致。

### 6.3 车道分组与颜色分离

```
laneKey = orderFamilyId ?? orderId    → 同订单多车共享车道
orderId = colorKey (含lineId)         → 每车独立颜色
```

- **车道分组键**：`laneKeyFor(info)` → 同订单的多辆车共享一个车道
- **颜色键**：`orderKeyFor(id, info)` → 每辆车独立hash取色
- **分支颜色**：`branchColors(baseColor, orderId)` → 从第一车道颜色派生（色相偏移≤10%，调饱和度/明度）

### 6.4 未走过路线虚化

- `grayTube` 透明度固定为 **0.10**（原0.42-0.96）
- 已走过部分由`progressTube`（不透明度0.95）亮色覆盖

---

## 7. 3D车辆系统

### 7.1 车辆视觉层级

```
VehicleBarState
├── bar           → 进度条方块 (BoxGeometry)
├── truckVisual   → 3D卡车模型 (GLTF, /models/rm2-truck.glb)
│   ├── model     → 克隆的卡车模型
│   └── locator   → 选中定位环 (RingGeometry, 默认不可见)
└── upgradeProgress → 放大动画进度 (0→1)
```

### 7.2 车辆大小动画

- `TRUCK_IDLE_VISUAL_SCALE = 0.14` → 默认缩小
- `upgradeVehicle(vehicle)` → 放大到1.0 + 定位环可见
- `downgradeVehicle(vehicle)` → 缩小回0.14 + 定位环隐藏
- `animateVehicleUpgrade` → cubic缓动 420ms
- `cameraTruckScaleRef` → 高处摄像机额外缩放

### 7.3 车辆选中流程

```
面板 onActiveVehicleChange(lineId)
  → roadMap2Ref.setHighlightedVehicle(lineId)
  → findVehicle(lineId)  (兼容lineId和visualKey两种查找)
  → upgradeVehicle(vehicle)
     ├─ createTruckVisual → 创建卡车模型+定位环
     └─ animateVehicleUpgrade → 放大动画
```

### 7.4 场景ID映射

- `sceneRouteId(route)` → `route.visualKey || route.lineId`
- 3D场景使用`visualKey`作为稳定标识（后端lineId变化也不影响）
- `findVehicle`支持两种ID查找：先直查`lineTrackMapRef`，失败后遍历所有车辆匹配`info.lineId`

---

## 8. 位置投影算法

### 8.1 窗口约束投影（U形路线修复）

```
projectDistanceOnPath(coordinates, point, hintDistance)
progressOnCoordinates(coordinates, position, hintProgress)
```

**问题**：U形路线中，车辆在中间时，全图搜索最近点可能贴到弯道对面。

**解法**：加入窗口约束，仅在上次位置±30%路径长度范围内搜索。

- `hintDistance < 0` → 全图搜索（首次投影）
- `hintDistance >= 0` → 窗口约束搜索
- 窗口内最近点距离 > 阈值 → 自动回退全图搜索

**调用关系**：

| 位置 | hint来源 |
|------|---------|
| 后端 `calibrateActiveRoutesFromCache` | 当前模拟进度 |
| 前端 `applyTruckPositionToRoute` | `route.calibratedDistance` |
| 前端 `createActiveRoute`(existing) | `existing.calibratedDistance` |
| 后端 `initialProgressForExternalOrder` | 无hint(首次) |

---

## 9. 后端关键服务

### 9.1 TownRoadRenderService

RM2数据管线的主入口。`processAndBroadcastInternal()` 串联全部处理步骤。

**关键常量：**
- `RM2_GROUP_SIZE = 1`（临时每车单独一组，原值为3）

**关键方法：**
- `fetchProcessAndBroadcast()` — 拉取+处理+广播
- `processAndBroadcastInternal()` — 完整管线
- `deduplicateOrders()` — 入口去重
- `registerShortHaulRoutesForPositions()` — 仅注册"运输中"订单
- `isPublishableRm2Route()` — 过滤无运行数据的路线

### 9.2 TownRoadMiddleLayer

数据清洗和路线计算的核心。

**关键方法：**
- `processSnapshot()` — 主流程：展开→预过滤→路线规划→规范化→分流
- `isWorthRoutePlanning()` — 预过滤：排除不值得调API的订单
- `normalize()` — 数据规范化，生成NormalizedTownRoadOrder
- `expandVehicleInstances()` — 订单→车辆实例展开
- `isShortHaul()` — 同省/邻省判断
- `planOrderLineRoutes()` — 调用百度/高德规划路线

**关键变量：**
- `ordersByInstanceId` — 所有订单实例缓存
- `odIndex` — OD索引：fromKey→toKey→instanceIds
- `provincePathIndex` — 省份路径索引

### 9.3 RoutePushService

路线模拟和位置管理。

**关键Map：**
- `activeRoutes: ConcurrentHashMap<String, ScheduledRoute>` — 活跃路线
- `rm2GroupIdByLineId` — lineId→groupId索引
- `rm2SnapshotVersion` — 当前快照版本
- `loadingVehiclePositions` — 装载中车辆初始位置（用于出发检测）

**关键方法：**
- `dispatchTownRoute()` — 注册RM2短途路线
- `dispatchExternalOrderRoute()` — 注册RM1长途路线
- `scheduledPositionRefresh()` — 定时位置刷新
- `calibrateActiveRoutesFromCache()` — 位置校准
- `checkLoadingVehicleDepartures()` — 装载车出发检测（>1km触发同步）
- `trackLoadingVehicle()` — 注册装载中车辆
- `progressOnCoordinates(coords, pos, hintProgress)` — 窗口约束投影

### 9.4 RoutePlanningService

百度/高德路线规划统一入口。

**关键方法：**
- `plan(origin, destination)` — 轿车路线
- `plan(origin, destination, waypoints)` — 带途经点路线

**百度API：**
- 轿车：`https://api.map.baidu.com/directionlite/v1/driving`
- 货车：`https://api.map.baidu.com/logistics_direction/v1/truck` (+高/宽/重/长参数)

**高德API：**
- 轿车：`https://restapi.amap.com/v5/direction/driving` (v5格式，cost子对象)
- 货车：`https://restapi.amap.com/v4/direction/truck` (v4格式，distance/duration顶层)

### 9.5 VehiclePositionCacheService

车辆位置缓存服务。

- `cache: ConcurrentHashMap<String, PositionSnapshot>` — 位置缓存
- `runBatchRefresh()` — 批量刷新
- `getPosition(lineId)` — 读取缓存（含死推预测和stale检测）

---

## 10. 配置参考

### 10.1 后端 application.yml 关键配置

```yaml
dashboard:
  route-plan:
    enabled: true
    baidu-ak: ""                       # 百度地图AK
    amap-key: ""                       # 高德地图Key
    cache-ttl-ms: 86400000             # 路线规划缓存24h
    min-request-interval-ms: 400       # API调用限速
    use-truck-routing: false           # false=轿车 true=货车
  route:
    external-position-url: ""          # 外部车辆位置API
    position-refresh:
      enabled: true
      batch-size: 50
      request-timeout-ms: 10000
      stale-after-ms: 180000
  external-order:
    sync-rate-ms: 900000               # 订单同步间隔(15分钟)
  websocket:
    external-order:
      auto-sync-enabled: true
      auto-sync-fixed-delay-ms: 900000

townroad:
  external-order:
    completed-retention-minutes: 30    # 已完成订单保留窗口
```

### 10.2 前端关键常量

```typescript
// RoadMap3D-2/geo.ts
MAP_HORIZONTAL_SCALE = 100            // 10倍放大
projection.center = [104.5, 35]
projection.scale = 80

// RoadMap3D-2/hooks/useRoadControls.ts
ROUTE_COLORS = [蓝,黄,绿,紫,粉,青]     // 6色主路线数组
TRUCK_IDLE_VISUAL_SCALE = 0.14        // 默认缩小
TRUCK_MODEL_SCALE = 1                 // 选中放大
VEHICLE_UPGRADE_MS = 420              // 放大动画时长
ROAD_LIFT = 0.65                      // 路线高度

// Dashboard/constants.ts
POSITION_QUERY_INTERVAL_MS = 12000    // 12秒位置轮询
```

---

## 附录 A — 文件索引

### 后端核心文件

| 文件 | 说明 |
|------|------|
| `townroad/TownRoadRenderService.java` | RM2管线主入口(processAndBroadcastInternal) |
| `townroad/TownRoadMiddleLayer.java` | 数据清洗+规范化+路径计算 |
| `townroad/TownRoadOrderSyncScheduler.java` | 定时同步触发器 |
| `townroad/TownRoadExternalOrderClient.java` | 外部订单API客户端 |
| `townroad/TownRoadCoordinateResolver.java` | 坐标补全(高德地理编码+本地库) |
| `townroad/NormalizedTownRoadOrder.java` | 规范化订单Record |
| `townroad/VehicleOrderChainDiagnosticsController.java` | 免登录诊断接口 |
| `service/RoutePushService.java` | 路线模拟+位置校准(最大文件) |
| `service/VehiclePositionCacheService.java` | 位置缓存+批量刷新 |
| `service/Rm2GroupQueryService.java` | RM2分组查询 |
| `baidu/RoutePlanningService.java` | 百度/高德路线规划统一入口 |
| `baidu/BaiduRoutePlanService.java` | 百度驾车/货车API |
| `baidu/AmapRoutePlanService.java` | 高德驾车/货车API |
| `dto/RouteDtoConverter.java` | NormalizedOrder→RenderRouteDTO转换 |
| `web/Rm2Controller.java` | RM2 REST API |
| `bootstrap/DashboardAccessTokenFilter.java` | Token鉴权过滤器(含白名单) |
| `websocket/RealtimeWebSocketHandler.java` | WebSocket处理 |

### 前端核心文件

| 文件 | 说明 |
|------|------|
| `DashboardPage.tsx` | 主页面(Hook编排+视图切换) |
| `hooks/useRm2PlaybackController.ts` | RM2核心控制(组切换+位置校准+colorKey) |
| `hooks/useTruckPositionController.ts` | 车辆位置管理(createActiveRoute等) |
| `modules/RoadMap3D-2/hooks/useRoadControls.ts` | 3D路线+车辆渲染(最大文件) |
| `modules/RoadMap3D-2/hooks/useRoadMapScene.ts` | 场景初始化+行政边界 |
| `modules/routeVisuals.ts` | 路线视觉效果(端点标记+辉光线+标签) |
| `modules/routePresentation.ts` | 面板颜色逻辑(ROUTE_TONES+routeTone) |
| `modules/DashboardSidePanels.tsx` | 侧面板(VehicleTransportDetails) |
| `playback/rm2RouteIdentity.ts` | 路线ID映射(sceneRouteId/routeVisualKey) |
| `playback/chain.ts` | 省→方向→组巡游链表 |
| `services/renderRouteApi.ts` | 渲染路线API封装 |
| `utils.ts` | 位置投影算法(projectDistanceOnPath等) |

---

## 附录 B — 关键变量速查

### 后端

| 变量/常量 | 位置 | 值/说明 |
|-----------|------|--------|
| `RM2_GROUP_SIZE` | TownRoadRenderService | **1** (临时每车一组) |
| `activeRoutes` | RoutePushService | 活跃路线Map |
| `loadingVehiclePositions` | RoutePushService | 装载中车辆初始位置 |
| `LOADING_DEPARTURE_THRESHOLD_KM` | RoutePushService | **1.0** (触发同步阈值) |
| `use-truck-routing` | application.yml | **false** (轿车/货车切换) |

### 前端

| 变量/常量 | 位置 | 值/说明 |
|-----------|------|--------|
| `ROUTE_COLORS` | useRoadControls.ts | 6色数组 `[蓝,黄,绿,紫,粉,青]` |
| `ROUTE_TONES` | routePresentation.ts | 面板6色(与ROUTE_COLORS对应) |
| `TRUCK_IDLE_VISUAL_SCALE` | useRoadControls.ts | **0.14** (默认缩放) |
| `grayTube opacity` | useRoadControls.ts | **0.10** (未走过路线) |
| `sceneRouteId` | rm2RouteIdentity.ts | visualKey\|\|lineId (场景ID) |
| `laneKeyFor` | useRoadControls.ts | 车道分组键(orderFamilyId) |
| `orderKeyFor` | useRoadControls.ts | 颜色键(colorKey+lineId) |
| `stableHash` | useRoadControls/routePresentation | FNV hash算法 |

---

> **文档维护**：每次功能变更后请同步更新本文档的相关章节。
