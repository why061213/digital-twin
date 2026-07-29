# 聚申数字孪生平台 — 技术交接文档

> 版本：2026-07-28 | 前端 `jushen-digital-twin` | 后端 `jushen-digital-twin-service`

---

## 目录

1. [系统架构概览](#1-系统架构概览)
2. [技术栈总览](#2-技术栈总览)
3. [完整数据流水线](#3-完整数据流水线)
4. [API 接口清单](#4-api-接口清单)
5. [前端视图体系](#5-前端视图体系)
    - [5.4 全局播放链表](#54-全局播放链表useglobalplaybackcontroller)
6. [RoadMap3D-2 核心架构](#6-roadmap3d-2-核心架构)
7. [路线颜色系统](#7-路线颜色系统)
8. [3D 车辆系统](#8-3d-车辆系统)
9. [位置投影算法](#9-位置投影算法)
10. [后端关键服务](#10-后端关键服务)
11. [配置参考](#11-配置参考)
12. [附录 A — 文件索引](#附录-a--文件索引)
13. [附录 B — 关键变量速查](#附录-b--关键变量速查)

---

## 1. 系统架构概览

```
┌──────────────────────────────────────────────────────────────────┐
│                    前端 (React 19 + Three.js 0.184)                │
│  Vite 8 开发服务器 :5173 → proxy /api → :8080, /ws → ws://:8080   │
│  DashboardPage → 多视图(ChinaMap3D / RoadMap3D-1 / RoadMap3D-2)   │
│  数据拉取: REST API + WebSocket (带token鉴权 + ping/pong心跳)       │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTP / WS
┌──────────────────────────┴───────────────────────────────────────┐
│               后端 (Spring Boot 3.3.5 + Java 17, Maven)            │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ TownRoadRenderService       RM2数据完整管线入口               │ │
│  │ TownRoadMiddleLayer         数据清洗+规范化+路线编排           │ │
│  │ VehicleOrderChainStore      车辆订单链日库存储+差分            │ │
│  │ VehicleOrderEligibilityService  车辆资格判定(装卸/在途/完成)   │ │
│  │ VehicleTripRuntimeService   Trip里程进度解析                  │ │
│  │ VehicleTripTopologyService  Trip到离站拓扑判断                │ │
│  │ RoutePushService            路线推送+位置模拟+装载检测         │ │
│  │ VehiclePositionCacheService 车辆位置缓存+批量刷新              │ │
│  │ RoutePlanningService        百度/高德路线规划统一入口          │ │
│  │ Rm2GroupQueryService        RM2稳定分组REST查询               │ │
│  │ DailyOrderStatisticsService 每日订单KPI统计                   │ │
│  │ RealtimeWebSocket           WebSocket实时推送(scope广播)       │ │
│  │ DashboardAccessTokenFilter   MAC白名单+设备令牌鉴权            │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**核心数据流**：

1. 外部订单拉取 → 车辆订单链差分(实验分支) → 入口去重 → 位置预热 → 坐标补全 → 路线规划(百度优先→高德回退) → 规范化 → 状态分流 → RM2分组 → 指纹比对 → WebSocket广播
2. 前端请求路线组 → 后端返回分组+坐标+实时位置 → 前端3D渲染（行政边界+道路管网+卡车模型+端点/经停标记+标签）
3. 车辆位置：后端定时批量查询外部API → 缓存+死推预测 → 窗口约束投影校准 → 前端定时拉取/WebSocket推送 → 3D卡车运动插值
4. 装载中车辆持续追踪位置 → 偏离初始位置>1km → 自动触发订单同步

---

## 2. 技术栈总览

### 2.1 前端

| 类别 | 技术 | 版本 |
|------|------|------|
| 框架 | React | 19.2.7 |
| 构建 | Vite | 8.1.0 |
| 语言 | TypeScript | 6.0.2 |
| 3D引擎 | Three.js | 0.184.0 |
| React 3D | @react-three/fiber + @react-three/drei | 9.6.1 / 10.7.7 |
| 图表 | ECharts + echarts-for-react + echarts-gl | 6.1.0 |
| 地理投影 | d3-geo | 3.1.1 |
| 多边形计算 | polygon-clipping | 0.15.7 |
| 样式 | Tailwind CSS | 4.3.1 |
| 状态管理 | zustand | 5.0.14 |
| 路由 | react-router-dom | 7.18.0 |
| 测试 | vitest | 4.1.10 |

### 2.2 后端

| 类别 | 技术 | 版本 |
|------|------|------|
| 框架 | Spring Boot | 3.3.5 |
| 语言 | Java | 17 |
| 构建 | Maven | - |
| Web | spring-boot-starter-web | - |
| WebSocket | spring-boot-starter-websocket | - |
| JSON | jackson-datatype-jsr310 | - |
| 辅助 | Lombok | - |

### 2.3 外部依赖

| 外部系统 | API | 用途 |
|----------|-----|------|
| 聚申平台 | `GET https://api.jushen.co/Freight/DispatchTransitNew/listTransitBoard` | 拉取运输订单 |
| 百度地图 | `directionlite/v1/driving` / `logistics_direction/v1/truck` | 轿车/货车路线规划 |
| 高德地图 | `v5/direction/driving` / `v4/direction/truck` | 轿车/货车路线规划(回退) |
| 高德地图 | `v3/geocode` | 地址→坐标地理编码 |
| 阿里云DataV | `https://geo.datav.aliyun.com/areas_v3/bound/` | 省市县GeoJSON边界 |
| 外部位置API | 配置项 `external-position-url` | 车辆实时位置批量查询 |

---

## 3. 完整数据流水线

### 3.1 数据清洗管线（`TownRoadRenderService.processAndBroadcastInternal`）

```
定时触发 (每15分钟, auto-sync-fixed-delay-ms: 900000)
  │
  ▼
① 拉取原始订单 ── GET https://api.jushen.co/Freight/DispatchTransitNew/listTransitBoard
  │  请求头: internalCall=jushen-internal, platformType=JsSc
  │
  ▼
② [实验分支] VehicleOrderChain ── 车辆实例展开+坐标补全→日库差分存储
  │   └─ VehicleOrderEligibilityService.analyzeLatestVehicleOrders() → 资格判定+位置预热
  │       └─ 输出: 合格订单子集 + 复合路线途经点Map + tripDecisionByLineId
  │
  ▼
③ 入口去重 ── deduplicateOrders(): 按 orderId+lineId+车牌号前缀去重，保留updatedAt最晚
  │
  ▼
④ 车辆实例展开 ── expandVehicleInstances(): 将 order.lines[].vehicles[] 扁平化
  │
  ▼
⑤ 位置预热 ── prepareProviderPositionVehicle() + warmPositionCacheForLineIds()
  │   └─ 批量查询外部车辆位置API，为所有待规划路线车辆预填真实坐标
  │
  ▼
⑥ 校准预注册路线 ── calibratePreparedRoutesFromCache()
  │   └─ 在路线规划之前先用真实位置校准已有路线的时间线
  │
  ▼
⑦ 装载车辆追踪 ── 待装载订单 → trackLoadingVehicle() 注册初始位置
  │
  ▼
⑧ 数据清洗 (TownRoadMiddleLayer.processSnapshot)
  │   ├─ withFreshProviderPosition() — 注入本批最新位置坐标
  │   ├─ isWorthRoutePlanning() — 预过滤：排除无效/无坐标/已删除/已取消/待装载/已完成
  │   ├─ planOrderLineRoutes() — 百度优先→高德回退，按OD缓存24h
  │   │   ├─ baseline路线：起终点最优路径
  │   │   └─ initialization路线：途经车辆当前位置的路径（支持复合途经点）
  │   ├─ normalize() — 生成NormalizedTownRoadOrder（含 dataSignature+routeSignature）
  │   ├─ 省份路径计算 — ProvinceRoadGraph → CityRoadGraph(Dijkstra 281城) → DistrictRoadGraph(边境约束)
  │   └─ 状态分流 — isShortHaul(同省/邻省≤3省)→RM2短途 / 跨省→RM1长途
  │                 待装载/已完成超时→过滤
  │
  ▼
⑨ RM2分组 ── buildStableGroups(rm2Routes, RM2_GROUP_SIZE=3)
  │   └─ buildRm2ChainStructure(): 省→方向→组三级链表
  │
  ▼
⑩ 指纹比对 ── SHA-256 内容指纹(rm2Fingerprint)，仅变化时更新快照
  │
  ▼
⑪ WebSocket广播 ── route_snapshot_changed (scope=rm2) → 前端刷新拓扑
  │   同时广播 daily_kpis → 前端KPI卡片更新
  │
  ▼
⑫ RM1长途注册 ── dispatchLongHaulRoutesToRoadMap() → 非短途可用订单注册为RM1模拟路线
```

### 3.2 数据过滤漏斗

```
原始订单 (rawCount: inputRawCount)
  │
  ├─ [VehicleOrderChain] 差分过滤 → 仅新/变更订单进入下游
  ├─ ❌ 入口去重 (同订单+同线路+同车牌)
  │
  = 展开后订单 (expandedTotal)
  │
  ├─ ❌ 预过滤 (isWorthRoutePlanning: 无效/无坐标/已删除/已取消/待装载/已完成)
  │
  = 路线规划候选 (worthRoutePlan)
  │
  ├─ ❌ 规范化失败
  ├─ ❌ 已删除/已取消
  │
  = 规范化订单 (normalizedCount)
  │
  ├─ ❌ 缺坐标 (skippedNotRenderable)
  ├─ ❌ 跨省长途 → RM1 (skippedLongHaul → roadMapRouteCount)
  ├─ ❌ 待装载
  ├─ ❌ 已完成超时(completedRetentionMinutes)
  │
  = 最终RM2渲染 (shortHaulCount) ✅
```

### 3.3 车辆位置数据流

```
后端 scheduledPositionRefresh (每30s)
  │
  ├─ runBatchRefresh()
  │   ├─ 从 activeRoutes + rm2GroupIdByLineId 收集待刷新lineId集合
  │   ├─ 分批(batchSize=50) POST external-position-url
  │   └─ 写入 VehiclePositionCacheService.cache
  │
  ├─ calibrateActiveRoutesFromCache()
  │   └─ 窗口约束投影校准所有活跃路线上的车辆进度
  │
  ├─ checkLoadingVehicleDepartures()
  │   └─ 装载中车辆当前位置 vs 初始位置 >1km → onLoadingVehicleDeparted()
  │       └─ 触发 fetchProcessAndBroadcast() 刷新订单
  │
  └─ WebSocket 广播
      ├─ vehicle_positions (scope=rm1/rm2，按订阅范围定向推送)
      └─ truck_position (单车主位置)

前端 useTruckPositionController
  │
  ├─ WebSocket 接收 truck_position → acceptPositionSample(时序去重) → applyTruckPositionToRoute(投影)
  ├─ 定时轮询 POSITION_RENDER_TICK_MS(500ms) → predictedPosition(死推插值) → renderTruckPosition
  └─ 到达预测终点 → requestTruckPosition(主动拉取确认) → finishRoute 或 继续
```

---

## 4. API 接口清单

### 4.1 RM2 路线 — `/api/road/groups` (scope=rm2)

前端实际使用的 RM2 REST 接口（通过 `RoadController` 路由，`scope=rm2` 时委托给 `Rm2GroupQueryService`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/road/groups?scope=rm2&snapshotVersion={ver}` | RM2 稳定分组列表（版本不匹配返回 mismatch） |
| `GET` | `/api/road/groups/structure?scope=rm2` | 省→方向→组三级链表结构 |
| `GET` | `/api/road/groups/{groupId}/routes?scope=rm2&snapshotVersion={ver}` | 某组路线详情+车辆位置 |
| `GET` | `/api/road/routes/{lineId}/position` | 单车位置查询（含模拟回退） |
| `POST` | `/api/road/vehicles/positions/query` | 批量位置查询（只读缓存） |

另外 `Rm2Controller` 也提供了 `/api/road/rm2/*` 路径的等效接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/road/rm2/groups` | 等同于 `groups?scope=rm2` |
| `GET` | `/api/road/rm2/groups/structure` | 等同于 `groups/structure?scope=rm2` |
| `GET` | `/api/road/rm2/groups/{groupId}/routes` | 等同于 `groups/{id}/routes?scope=rm2` |

### 4.2 公开诊断 — `/api/public/vehicle-order-chain`

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| `GET` | `/api/public/vehicle-order-chain/transit-metrics` | 运输指标快照 | **免登录** |

### 4.3 鉴权 — `/api/auth` & `/api/bootstrap`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/auth/login` | 登录获取 Dashboard 访问 token |
| `GET` | `/api/bootstrap/status` | 系统启动状态 |
| `GET` | `/api/bootstrap/config` | 系统公开配置 |

鉴权机制：MAC 地址白名单（通过局域网 ARP/邻居表识别）+ 设备令牌兜底（跨 VLAN 场景）。会话密钥在 `/api/auth/login` 签发，token 通过 `?token=` 参数或 HTTP Header 传递。

### 4.4 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/road/dispatch` | 派发单条随机路线 |
| `POST` | `/api/road/dispatch/bulk?vehicleCount=24` | 批量派发路线 |
| `GET` | `/api/road/groups?scope=rm1&strategy=xxx` | RM1 路线分组（支持 business-priority/by-order/by-path/by-route 策略） |
| `GET` | `/api/warehouse/snapshot` | 全国仓储快照 |
| `GET` | `/api/warehouse/focus/{cityName}` | 城市仓储详情+面板 |
| `GET` | `/api/road/town/statistics` | 每日订单统计 |
| `POST` | `/api/town-road/mock/dispatch` | 模拟派发城镇订单 |
| `POST` | `/api/road/routes/query-position` | 手动车牌/carId查位置 |

### 4.5 WebSocket 消息协议

**服务端→客户端：**

| type | 说明 |
|------|------|
| `city_raise` | 城市飞线升起 |
| `city_fall` | 城市飞线降落 |
| `road_path` | 路线路径数据 |
| `truck_position` | 单车位置更新 |
| `vehicle_positions` | 批量车辆位置（scope=rm1\|rm2） |
| `route_snapshot_changed` | RM2 快照变更通知（含 changedGroupIds/removedGroupIds） |
| `warehouse_update` | 仓库数据更新 |
| `warehouse_focus` | 仓库聚焦（含面板配置） |
| `camera_control` | 摄像机控制指令 |
| `daily_kpis` | 每日KPI统计数据 |
| `pong` | 心跳响应 |

**客户端→服务端：**

| type | 说明 |
|------|------|
| `ping` | 应用层心跳（20s间隔） |
| `vehicle_position_subscription` | 订阅/取消车辆位置 scope |

---

## 5. 前端视图体系

### 5.1 视图切换

通过 `ViewButtons` 组件：`[R1] [R2] [仓库] [地球]`

| 视图 | state值 | 3D组件 | 说明 |
|------|---------|--------|------|
| R1 | `chinaMap` | ChinaMap3D | 全国地图 + 城市飞线 + 仓储巡游 |
| R2 | `roadMap2` | RoadMap3D-2 | 省市县道路地图 + 卡车3D模型 |
| 仓库 | `warehouse` | Warehouse3D | 3D仓库可视化 |
| 地球 | `earth` | Earth3D | 地球模块 |

### 5.2 DashboardPage Hook 链

```
DashboardPage
├── useGlobalPlaybackController()  → 全局链表循环(ChinaMap→RM1→RM2自动编排)
├── useDashboardRealtime()          → WebSocket实时连接(心跳+重连+scope订阅)
├── useRoadGroupsController()       → RM1路线组数据+策略切换
├── useRm2PlaybackController()      → RM2核心：拓扑刷新+组巡游+位置批量注入
│   └── useTruckPositionController() → (内部实例) 车辆位置管理
├── useWarehouseController()        → 仓储巡游+城市升降+摄像机控制
└── useTruckPositionController()    → (顶层实例) RM1车辆位置管理(createActiveRoute等)
```

### 5.3 RM2 视图数据流时序

```
用户进入RM2视图 (view='roadMap2' + sceneReady)
  │
  ├─ 1. RoadMap3D-2挂载 → useRoadMapScene → 场景初始化
  ├─ 2. onVisualReady回调 → setIsRoadMap2VisualReady(true)
  ├─ 3. useRm2PlaybackController.refreshRm2()
  │      ├─ fetchRm2ChainStructure() → 获取省→方向→组链表结构
  │      ├─ fetchRm2Groups(snapshotVersion) → 获取分组列表(版本校验)
  │      ├─ buildPlaybackChain() → 构建前端巡游链表(playbackNext + hierarchyNext)
  │      └─ 自动播放 headLeaf → playNode()
  │
  ├─ 4. playNode(node)
  │      ├─ preloadProvinceRegion / preloadDirectionRegions → 预装GeoJSON底图
  │      ├─ 省/方向变化时 → setProvinceRegion / setDirectionRegions → 切换图层
  │      ├─ fetchRm2GroupRoutes(groupId, snapshotVersion) → 获取路线+位置
  │      ├─ adaptRenderRoute() → 转换为 RoadPathMessage
  │      ├─ assignRm2RouteColorSlots() → 按后端orderLineIds顺序分配色槽
  │      ├─ createActiveRoute() → 创建ActiveRoute(复用已有visualKey的校准位置)
  │      ├─ hydrateRoutePositions() → 注入后端返回的实时位置
  │      └─ showRoutes() → syncRoadRoute + renderTruckPosition → 3D渲染
  │
  ├─ 5. 自动巡游 → setTimeout(durationMs) → playNode(playbackNext)
  │      durationMs = max(20s, min(180s, vehicleCount*15s))
  │
  ├─ 6. WebSocket route_snapshot_changed → debounce(250ms) → refreshRm2()
  │      └─ 快照版本变化时重新拉取拓扑和分组
  │
  ├─ 7. WebSocket vehicle_positions(scope=rm2) → handleRm2VehiclePositions()
  │      └─ 仅处理当前活跃组的车辆，时序去重后校准进度
  │
  └─ 8. handleMotionRouteFinished → 所有活跃车辆完成 → playNode(playbackNext)
```

### 5.4 全局播放链表（`useGlobalPlaybackController`）

全局控制器管理整个大屏的自动循环播放，将 ChinaMap / RM1 / RM2 串联为一条环形链表：

```
Head → ChinaMap → RM1_Judge → RM1 → RM2_Judge → RM2 → End → (回到ChinaMap)
```

**核心设计：**

- **ChinaMap**：仓库巡游，每次完整循环触发 `onTourLoopCompleted` 回调。达到配置次数后进入下一节点。
- **RM*_Judge**：**不切换视图**（保持前一画面不黑屏），直接调用后端 API 判断对应视图是否有可播放数据。
  - 有数据 → 进入对应视图节点
  - 无数据 → 跳过，进入下一个 Judge
- **RM1 / RM2**：切换视图，交由各自的 PlaybackController 播放路线组。
- **End**：累计总循环次数。达到 `totalLoopCount` 后停止，否则回到 ChinaMap。
- **冷却期**：进入 RM1/RM2 后 5 秒内不触发耗尽检测，避免数据加载期间误判。

**Judge 数据判断方式：**

| Judge 节点 | 调用 API | 判断依据 |
|-----------|----------|---------|
| RM1_Judge | `fetchRoadGroupsByStrategy('business-priority')` | `groups.length > 0` |
| RM2_Judge | `fetchRm2ChainStructure()` | `leafGroupIds.length > 0` |

> Judge 节点**直接调用 API** 而不依赖 React state，因为在非对应视图下 hook state 不会被更新。

**关键文件：**

| 文件 | 说明 |
|------|------|
| `playback/globalChain.ts` | 链表类型定义 + `buildGlobalChain()` 构建函数 |
| `hooks/useGlobalPlaybackController.ts` | 核心控制器（节点切换、循环计数、Judge判断、冷却期） |
| `config/labelLayout.ts` | `globalPlayback` 配置节 |

**配置：**

```typescript
// config/labelLayout.ts
globalPlayback: {
    chinaMapLoopCount: 2,   // ChinaMap 巡游几轮后进入 RM1_Judge
    totalLoopCount: 2,      // 整个大循环执行几次（0=无限）
    rm1GroupHoldMs: 0,      // RM1 组间停留
    emptyViewRetryMs: 5000, // 空视图重试间隔
}
```

**视图切换流程：**

```
ChinaMap 仓库巡游 N 轮 (onTourLoopCompleted 计数)
  → N 达到 chinaMapLoopCount → 异步推进(300ms, 避免同步重置)
    → RM1_Judge: fetchRoadGroupsByStrategy() → 有数据? → RM1 : RM2_Judge
      → RM1: 切换视图 → RoadMap3D-1 自动加载 → 播放所有组
        → 耗尽 → RM2_Judge: fetchRm2ChainStructure() → 有数据? → RM2 : End
          → RM2: 切换视图 → RoadMap3D-2 自动加载 → 播放所有组
            → 耗尽 → End: totalLoopRef++ → 达到上限? → ChinaMap(停) : ChinaMap(继续)
```

---

## 6. RoadMap3D-2 核心架构

### 6.1 3D场景结构

```
场景 (Scene)
├── 行政边界层 (provinceRegion / directionRegions)
│   ├── 省级边界 → TubeGeometry 金色管道 (#f59e0b)
│   ├── 市级边界 → ExtrudeGeometry 深蓝填充 (#2f465e)
│   └── 区县边界 → ExtrudeGeometry 更暗填充 (#1a2a3a)
│
├── 路线层 (per pathKey)
│   ├── grayTube → 未走过路线底色(透明度0.10)
│   ├── visualLayers → 屏幕空间辉光线
│   ├── sharedProgressTube → 共享路段彩色流动材质
│   ├── selectionTube → 选中高亮(默认透明)
│   │
│   ├── OrderLane[] → 每条业务订单车道
│   │   ├── progressTube → 车辆已走过部分(亮色0.95)
│   │   ├── endpointLayer → 起终点标记
│   │   │   ├── createEndpointMarker → 地图钉(halo光环+stem杆+pin钉子)
│   │   │   └── createEndpointLabel → 起点·xxx / 终点·xxx 标签
│   │   ├── stopLayer → 经停点标记（复合订单的装卸货点）
│   │   └── VehicleBar[] → 每辆车
│   │       ├── bar → 车辆进度条方块(BoxGeometry)
│   │       ├── truckVisual → 3D卡车模型(GLTF, /models/rm2-truck.glb)
│   │       └── locator → 选中定位环(RingGeometry, 默认不可见)
│   └── snakeProgressTube → 蛇形流动光效(沿path曲线)
```

### 6.2 地图投影

```typescript
// geo.ts
MAP_HORIZONTAL_SCALE = 100  // 地图水平放大系数
projection = geoMercator()
  .center([104.5, 35])       // 中国中心
  .scale(80)
  .translate([0, 0])
```

坐标转换：`mapPosition([lng, lat], lift)` → `Vector3(-px * 100, lift, -py * 100)`（x轴取反使地理方向正确）

### 6.3 行政边界

| 层级 | 渲染方式 | 颜色 | 加载来源 |
|------|---------|------|---------|
| 省 | TubeGeometry管道 | 金色 `#f59e0b` | 阿里云DataV `100000_full.json` → 市级合并外轮廓 |
| 市 | ExtrudeGeometry填充 | `#2f465e` | 省级全量子区域 + `{省adcode}_full.json` |
| 区县 | ExtrudeGeometry填充 | `#1a2a3a` | `{市adcode}_full.json`（仅非直筒子市/无区县市） |

直辖市(110000/120000/310000/500000)特殊处理：省级轮廓+区县级直接填充。

### 6.4 图层切换

系统维护 `provinceRegion`（始发省）和 `directionRegions`（目的省+途经省）两组图层。切换组时：
- 始发省变化 → `setProvinceRegion()`（一次性替换）
- 方向变化 → `setDirectionRegions()`（替换目的省/途经省图层，始发省图层不动）
- 下一组预装 → `preloadProvinceRegion()/preloadDirectionRegions()`（提前异步加载GeoJSON）

---

## 7. 路线颜色系统

### 7.1 RM2 颜色分配（色槽顺序）

RM2 使用后端分组的 `orderLineIds` 顺序分配色槽，确保面板和3D颜色严格对应：

```typescript
// assignRm2RouteColorSlots()
slotByBusinessLineId = orderLineIds → index(0,1,2,...)
route.routeColorIndex = slotByBusinessLineId.get(orderFamilyId)
                      ?? slotByVehicleLineId.get(lineId)
                      ?? fallbackSlot++
```

色槽索引直接映射到6色调色板：

| 索引 | 颜色名 | 3D值 | 面板hex |
|------|--------|------|---------|
| 0 | 蓝 | `0x3b82f6` | `#3b82f6` |
| 1 | 黄 | `0xf59e0b` | `#f59e0b` |
| 2 | 绿 | `0x22c55e` | `#22c55e` |
| 3 | 紫 | `0xa78bfa` | `#a78bfa` |
| 4 | 粉 | `0xfb7185` | `#fb7185` |
| 5 | 青 | `0x2dd4bf` | `#2dd4bf` |

> **注意**：RM2 不再使用 `stableHash(colorKey) % 6` 的随机取色逻辑，而是严格按后端业务订单顺序。面板(`routePresentation.ts`)和3D(`useRoadControls.ts`)均使用同一6色调色板。

### 7.2 RM1 颜色分配（hash取色）

```
colorKey = "main:orderId:lineId"  (preserveBackendRouteIdentity生成)
       ↓
stableHash(colorKey) % 6  →  索引0-5
       ↓
ROUTE_COLORS[索引]  →  3D路线颜色
ROUTE_TONES[索引]   →  面板边框/背景颜色
```

### 7.3 车道分组

- **车道分组键**：`laneKeyFor(info)` → 同 `orderFamilyId` 的多辆车共享一个 OrderLane
- **颜色键**：`orderKeyFor(id, info)` → 每辆车独立 colorKey（含 lineId）
- **分支颜色**：`branchColors(baseColor, orderId)` → 从主车道颜色派生（色相偏移≤10%）

### 7.4 未走过路线虚化

- `grayTube` 透明度固定为 **0.10**
- 已走过部分由 `progressTube`（不透明度0.95）亮色覆盖

---

## 8. 3D车辆系统

### 8.1 车辆视觉层级

```
VehicleBarState
├── bar           → 进度条方块 (BoxGeometry, VEHICLE_COLOR)
├── truckVisual   → 3D卡车模型 (GLTF, /models/rm2-truck.glb)
│   ├── model     → 克隆的卡车模型
│   └── locator   → 选中定位环 (RingGeometry, 默认不可见)
└── upgradeProgress → 放大动画进度 (0→1, cubic缓动)
```

### 8.2 车辆关键常量

```typescript
TRUCK_MODEL_URL = '/models/rm2-truck.glb'
TRUCK_MODEL_SCALE = 1              // 选中时大小
TRUCK_MODEL_Y_OFFSET = -0.31       // 模型垂直偏移
TRUCK_IDLE_VISUAL_SCALE = 0.14     // 默认缩小
TRUCK_HIGH_CAMERA_SCALE = 1.55     // 高处摄像机额外缩放
VEHICLE_UPGRADE_MS = 420           // 放大动画时长(ms)
```

### 8.3 车辆选中流程

```
面板 onActiveVehicleChange(lineId)
  → roadMap2Ref.setHighlightedVehicle(lineId)
  → findVehicle(lineId)  (兼容lineId和visualKey两种查找)
  → upgradeVehicle(vehicle)
     ├─ createTruckVisual → 创建卡车模型+定位环
     └─ animateVehicleUpgrade → cubic缓动放大到TRUCK_MODEL_SCALE
```

### 8.4 场景ID映射

- `sceneRouteId(route)` → `route.visualKey || route.lineId`
- 3D场景使用 `visualKey` 作为稳定标识（后端 lineId 变化也不影响）
- `findVehicle` 支持两种ID查找：先直查 `lineTrackMapRef`，失败后遍历所有车辆匹配 `info.lineId`

### 8.5 告警波纹特效

当车辆 `alarmSeverity` 为 `warning` 或 `critical` 时，`syncVehicleAlertRipple()` 在车辆位置创建扩散环动画（`vehicleAlertRipples.ts`）。

---

## 9. 位置投影算法

### 9.1 窗口约束投影（U形路线修复）

```typescript
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

### 9.2 死推预测

前端在两次真实位置之间使用匀速死推：

```typescript
predictedDistance(route, now) // 基于 calibratedAt + calibratedDistance + pathSpeed 推算
predictedPosition(route, now) // 坐标空间插值
```

- 速度源优先级：provider速度 > 计算速度(位置差/时间差) > `FALLBACK_TRUCK_SPEED_KMH`
- 最大可信速度：`MAX_PROVIDER_SPEED_KMH=140`，`MAX_CALCULATED_SPEED_KMH=160`
- 位置变化 < `35m` 且服务端速度=0 → 连续计数后强制零速

---

## 10. 后端关键服务

### 10.1 TownRoadRenderService

RM2数据管线的主入口。`processAndBroadcastInternal()` 串联全部处理步骤。

**关键常量：**
- `RM2_GROUP_SIZE = 3`（每组最多3个业务订单，每车独立渲染）

**关键方法：**
- `fetchProcessAndBroadcast()` — 拉取+处理+广播
- `processAndBroadcastInternal()` — 完整管线(含 VehicleOrderChain 实验分支)
- `deduplicateOrders()` — 入口去重
- `registerShortHaulRoutesForPositions()` — 仅注册"运输中"订单
- `isPublishableRm2Route()` — 过滤无运行数据的路线
- `rm2Fingerprint()` — SHA-256 内容指纹

**关键状态：**
- `latestRm2Snapshot`: 原子快照（含 routes/groups/chainStructure/routesByGroupId/groupIdByLineId）
- `previousFingerprint`: 上一版指纹（用于变化检测）
- `tripDecisionByLineId`: 车辆资格判定结果

### 10.2 TownRoadMiddleLayer

数据清洗和路线计算的核心。

**关键方法：**
- `processSnapshot()` — 主流程：展开→预过滤→路线规划→规范化→分流
- `isWorthRoutePlanning()` — 预过滤：排除不值得调API的订单
- `normalize()` — 数据规范化，生成 NormalizedTownRoadOrder
- `expandVehicleInstances()` — 订单→车辆实例展开
- `isShortHaul()` — 同省/邻省判断（provincePath ≤ 3省）
- `planOrderLineRoutes()` — 调用百度/高德规划路线
- `resolveOrderLocations()` — 装卸点坐标补全
- `resolveProvincePathKeys()` — 省份路径解析

**关键索引：**
- `ordersByInstanceId` — 所有订单实例缓存
- `odIndex` — OD索引：fromKey→toKey→instanceIds
- `provincePairIndex` — 省份对索引
- `provincePathIndex` — 省份路径索引
- `sourceProvinceIndex` — 起点省份索引

### 10.3 RoutePushService

路线模拟和位置管理（整个项目最大的服务类）。

**关键Map：**
- `activeRoutes: ConcurrentHashMap<String, ScheduledRoute>` — 活跃路线
- `displayGroupLocks` — 展示组锁
- `lastPositionSamples` — 上次位置样本（速度计算用）
- `zeroSpeedCounters` — 连续零速计数器
- `rm2GroupIdByLineId` — lineId→groupId索引
- `loadingVehiclePositions` — 装载中车辆初始位置（出发检测）
- `localPositionHistoryByLineId` — 本地位置历史（供Trip状态机消费）
- `routeReplanAnchors` — 重规划锚点坐标

**关键方法：**
- `dispatchTownRoute()` — 注册RM2短途路线
- `dispatchExternalOrderRoute()` — 注册RM1长途路线
- `scheduledPositionRefresh()` — 定时位置刷新
- `calibrateActiveRoutesFromCache()` — 位置校准
- `checkLoadingVehicleDepartures()` — 装载车出发检测（>1km触发同步）
- `trackLoadingVehicle()` — 注册装载中车辆
- `syncRm2PositionGroups()` — 同步RM2群组索引到位置系统
- `prepareProviderPositionVehicle()` — 预热供应商位置
- `warmPositionCacheForLineIds()` — 批量位置预热

**关键常量：**
- `LOADING_DEPARTURE_THRESHOLD_KM = 1.0` — 装载出发检测阈值
- `MAX_PROVIDER_SPEED_KMH = 140.0` — 供应商速度上限
- `MAX_CALCULATED_SPEED_KMH = 160.0` — 计算速度上限
- `POSITION_CHANGE_THRESHOLD_METERS = 35.0` — 位置变化阈值
- `POSITION_MAX_SILENCE_MS = 120_000` — 位置静默超时
- `MAX_CALIBRATION_OFF_ROUTE_KM = 2.0` — 最大离路线校准距离

### 10.4 VehicleOrderChainStore

车辆订单链日库存储，基于 instanceId 的差分机制：
- `ingest(expandedOrders)` — 摄入展开后的订单，差分出 new/updated/removed
- 持久化到 `runtime-data/vehicle-order-chain/` JSON文件

### 10.5 VehicleOrderEligibilityService

车辆资格判定服务，分析车辆处于"装卸"还是"运输中"：
- `analyzeLatestVehicleOrders()` — 核心判定逻辑
- `advanceTripsFromLocalPositionHistory()` — 基于本地位置历史推进Trip里程碑
- 输出 `tripDecision`（PICKUP/DELIVERY/TRANSPORTING/COMPLETED 等）
- 位置预热：判定阶段即批量查询供应商位置

### 10.6 VehicleTripRuntimeService / VehicleTripTopologyService

- `VehicleTripRuntimeService`: 解析 Trip 的里程进度（基于 GPS轨迹投影+路线规划对比）
- `VehicleTripTopologyService`: 判断到离站事件（trip-arrival-radius-km=0.5, trip-departure-radius-km=0.8, trip-minimum-dwell-ms=60000）

### 10.7 RoutePlanningService

百度/高德路线规划统一入口。

**关键方法：**
- `plan(origin, destination)` — 轿车路线
- `plan(origin, destination, waypoints)` — 带途经点路线（支持复合订单多段规划）

**百度API：**
- 轿车：`https://api.map.baidu.com/directionlite/v1/driving`
- 货车：`https://api.map.baidu.com/logistics_direction/v1/truck` (+高/宽/重/长参数)

**高德API：**
- 轿车：`https://restapi.amap.com/v5/direction/driving` (v5格式，cost子对象)
- 货车：`https://restapi.amap.com/v4/direction/truck` (v4格式，distance/duration顶层)

### 10.8 VehiclePositionCacheService

车辆位置缓存服务。

- `cache: ConcurrentHashMap<String, PositionSnapshot>` — 位置缓存
- `runBatchRefresh()` — 批量刷新（POST external-position-url，分批 size=50）
- `getPosition(lineId)` — 读取缓存（含死推预测和stale检测）

### 10.9 Rm2GroupQueryService

RM2 分组的 REST 查询服务，直接读取 `TownRoadRenderService.latestRm2Snapshot`：
- `listGroups(snapshotVersion)` — 版本校验+分组列表返回
- `listStructure()` — 省→方向→组链表结构
- `listGroupRoutes(groupId, snapshotVersion)` — 路由+位置（含路线分析结果注入）

### 10.10 DailyOrderStatisticsService

每日订单KPI统计服务：
- `applySnapshot()` — 基于 instanceId 累积去重统计
- 广播 `daily_kpis` WebSocket消息触发前端KPI卡片更新
- 缓存到 `runtime-data/daily-order-statistics.json`

### 10.11 其他服务

- **RealtimePushService**: 实时推送编排
- **SimulationDataFactory**: 路线模拟数据工厂（城市飞线/道路路径模拟）
- **WarehousePushService/WarehouseDataProvider**: 仓库数据提供和巡游推送
- **RouteDeviationClassifier/RouteDeviationPathBuilder/RouteCorrectionPathBuilder**: 路线偏离检测与纠正
- **RouteProgressProjector**: 路线进度投影
- **TripMilestoneProgressResolver/TripRouteAnchorResolver**: Trip里程碑解析
- **TruckRoutePatternStore**: 卡车路线模式存储
- **RouteAnalysisService**: 路线语义分析（共享路段/偏离检测）

---

## 11. 配置参考

### 11.1 后端 application.yml 关键配置

```yaml
server:
  port: 8080

spring:
  application.name: jushen-digital-twin-backend
  config.import:
    - classpath:simulation.yml
    - classpath:warehouse.yml
    - classpath:camera.yml
    - optional:classpath:application-private.yml  # 私有密钥等

dashboard:
  access:
    enabled: true
    trust-loopback: true
    session-ttl: 8h
    session-refresh-after: 4h
    max-active-sessions: 256

  websocket:
    external-order:
      auto-sync-enabled: true
      auto-sync-fixed-delay-ms: 900000        # 15分钟
      require-renderable-coords: true
      connect-timeout-ms: 5000
      request-timeout-ms: 12000
      # VehicleOrderChain 实验分支
      vehicle-order-chain-experiment-enabled: true
      vehicle-order-chain-store-path: runtime-data/vehicle-order-chain
      # Trip 到离站判定参数
      trip-arrival-radius-km: 0.5
      trip-departure-radius-km: 0.8
      trip-minimum-dwell-ms: 60000

  route:
    simulation-profile: real
    group-size: 12
    default-group-strategy: province-path
    external-position-url: ""                 # 外部车辆位置API
    external-position-batch-size: 50
    position-refresh:
      enabled: true
      initial-delay-ms: 10000
      fixed-delay-ms: 30000                   # 30秒批量刷新
      batch-size: 50
      request-timeout-ms: 10000
      stale-after-ms: 180000

  coord-db:
    amap-key: ""                              # 高德地理编码Key
    amap-secret: ""                           # 高德安全密钥

  route-plan:
    enabled: true
    baidu-ak: ""                              # 百度地图AK
    amap-key: ""                              # 高德地图Key
    cache-ttl-ms: 86400000                    # 路线缓存24h
    min-request-interval-ms: 400              # API调用限速
    use-truck-routing: false                  # false=轿车 true=货车

  route-analysis:                             # 路线语义分析参数
    resample-step-m: 100
    grid-size-m: 500
    shared-tolerance-m: 120
    deviation-enter-distance-m: 300
```

### 11.2 前端关键常量

```typescript
// Dashboard/constants.ts
API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'
POSITION_QUERY_INTERVAL_MS = test:60_000 / real:1_800_000  (按 VITE_TRUCK_SIMULATION_PROFILE 区分)
SLOW_POSITION_QUERY_INTERVAL_MS = test:15_000 / real:300_000
POSITION_RENDER_TICK_MS = 500                              // 死推渲染间隔
LOW_SPEED_THRESHOLD_KMH = 50                                // 低速阈值

// RoadMap3D-2/geo.ts
MAP_HORIZONTAL_SCALE = 100                                  // 地图水平放大
projection.center = [104.5, 35]
projection.scale = 80

// RoadMap3D-2/constants.ts
ROAD_LIFT = 0.08                                            // 路线Y轴高度
TRUCK_LIFT = 0.36                                           // 卡车Y轴高度
PATH_SAMPLE_COUNT = 160                                     // 曲线采样点
CAMERA_TILT_RATIO = 0.48                                    // 摄像机俯仰比
BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/'  // GeoJSON数据源

// RoadMap3D-2/hooks/useRoadControls.ts
ROUTE_COLORS = [蓝,黄,绿,紫,粉,青]                            // 6色调色板
TRUCK_IDLE_VISUAL_SCALE = 0.14                               // 默认缩放
TRUCK_MODEL_SCALE = 1                                        // 选中时大小
TRUCK_MODEL_Y_OFFSET = -0.31                                 // 模型偏移
TRUCK_HIGH_CAMERA_SCALE = 1.55                               // 高处额外缩放
VEHICLE_UPGRADE_MS = 420                                     // 放大动画时长(ms)
```

### 11.3 Vite 代理配置

```typescript
// vite.config.ts
server: {
  host: '0.0.0.0',
  port: 5173,
  proxy: {
    '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    '/ws':  { target: 'ws://127.0.0.1:8080', ws: true },
  }
}
```

---

## 附录 A — 文件索引

### 后端核心文件

| 文件 | 说明 |
|------|------|
| `townroad/TownRoadRenderService.java` | RM2管线主入口（processAndBroadcastInternal） |
| `townroad/TownRoadMiddleLayer.java` | 数据清洗+规范化+路径计算 |
| `townroad/TownRoadOrderSyncScheduler.java` | 定时同步触发器 |
| `townroad/TownRoadExternalOrderClient.java` | 外部订单API客户端（listTransitBoard） |
| `townroad/TownRoadCoordinateResolver.java` | 坐标补全（高德地理编码+本地库） |
| `townroad/TownRoadModels.java` | 数据模型定义 |
| `townroad/TownRoadRenderCommand.java` | 渲染命令模型（TownRoadOrder/TownRoadRouteGroup等） |
| `townroad/TownRoadDataLayer.java` | 数据层抽象 |
| `townroad/NormalizedTownRoadOrder.java` | 规范化订单Record |
| `townroad/ExternalOrderRecord.java` | 外部订单原始Record |
| `townroad/OrderSnapshotDiff.java` | 订单快照差分模型 |
| `townroad/VehicleOrderChainStore.java` | 车辆订单链日库存储 |
| `townroad/VehicleOrderEligibilityService.java` | 车辆资格判定（装卸/运输中） |
| `townroad/VehicleOrderChainDiagnosticsController.java` | 免登录诊断接口 |
| `townroad/VehicleTripRuntimeService.java` | Trip里程进度解析 |
| `townroad/VehicleTripTopologyService.java` | Trip到离站拓扑判断 |
| `townroad/WaitingOrderTrajectoryClassifier.java` | 待装载订单轨迹分类 |
| `townroad/ProviderTrajectoryClient.java` | 供应商轨迹查询客户端 |
| `townroad/DailyOrderStatisticsService.java` | 每日订单KPI统计 |
| `townroad/DailyOrderStatisticsController.java` | 每日统计REST接口 |
| `townroad/ProvinceRoadGraph.java` | 省级路网图（Dijkstra） |
| `townroad/CityRoadGraph.java` | 市级路网图（281城） |
| `townroad/DistrictRoadGraph.java` | 区县级路网图 |
| `townroad/ChinaBoundaryConstraint.java` | 国境边界约束 |
| `townroad/ProvinceCodeResolver.java` | 省份编码解析 |
| `townroad/AmapGeocodeClient.java` | 高德地理编码客户端 |
| `townroad/LocalCoordDb.java` | 本地坐标库 |
| `townroad/CoordDbProperties.java` | 坐标库配置 |
| `townroad/TownRoadController.java` | TownRoad REST接口 |
| `service/RoutePushService.java` | 路线模拟+位置校准（最大服务类） |
| `service/VehiclePositionCacheService.java` | 位置缓存+批量刷新 |
| `service/Rm2GroupQueryService.java` | RM2分组查询 |
| `service/Rm2RouteResponseAssembler.java` | RM2响应组装 |
| `service/RealtimePushService.java` | 实时推送编排 |
| `service/SimulationDataFactory.java` | 路线模拟数据工厂 |
| `service/WarehousePushService.java` | 仓库推送 |
| `service/RouteDeviationClassifier.java` | 路线偏离分类器 |
| `service/RouteDeviationPathBuilder.java` | 偏离路线构建器 |
| `service/RouteCorrectionPathBuilder.java` | 纠正路线构建器 |
| `service/RouteProgressProjector.java` | 路线进度投影 |
| `service/TripMilestoneProgressResolver.java` | Trip里程碑进度解析 |
| `service/TripRouteAnchorResolver.java` | Trip路线锚点解析 |
| `service/TruckRoutePatternStore.java` | 卡车路线模式存储 |
| `service/PositionSnapshot.java` | 位置快照模型 |
| `baidu/RoutePlanningService.java` | 百度/高德路线规划统一入口 |
| `baidu/BaiduRoutePlanService.java` | 百度驾车/货车API |
| `baidu/AmapRoutePlanService.java` | 高德驾车/货车API |
| `dto/RouteDtoConverter.java` | NormalizedOrder→RenderRouteDTO转换+分组构建 |
| `dto/RenderRouteDTO.java` | 渲染路线DTO |
| `dto/Rm2RouteGroupDTO.java` | RM2路线组DTO |
| `dto/Rm2Snapshot.java` | RM2原子快照 |
| `dto/Rm2ChainStructureDTO.java` | RM2链表结构DTO |
| `web/RoadController.java` | 路线REST API（RM1+RM2路由分发） |
| `web/Rm2Controller.java` | RM2专用REST API |
| `web/WarehouseController.java` | 仓库REST API |
| `web/TownRoadMockController.java` | 模拟派发接口 |
| `web/HealthController.java` | 健康检查 |
| `bootstrap/DashboardAccessTokenFilter.java` | Token鉴权过滤器（含MAC白名单） |
| `bootstrap/DashboardAccessTokenService.java` | Token签发/验证服务 |
| `bootstrap/DashboardAuthController.java` | 登录认证接口 |
| `bootstrap/DashboardBootstrapController.java` | 启动状态接口 |
| `websocket/RealtimeWebSocketHandler.java` | WebSocket处理（scope订阅+广播） |
| `websocket/TokenHandshakeInterceptor.java` | WebSocket握手拦截（token校验） |
| `config/WebSocketConfig.java` | WebSocket配置 |
| `config/WebConfig.java` | Web CORS配置 |
| `config/SchedulerConfig.java` | 定时任务调度配置 |
| `routeanalysis/RouteAnalysisService.java` | 路线语义分析（共享路段/偏离） |
| `grouping/` | 路线分组策略族（策略模式，多种分组算法） |
| `externalorder/` | 外部订单同步服务 |

### 前端核心文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `DashboardPage.tsx` | 395 | 主页面（Hook编排+视图切换） |
| `hooks/useGlobalPlaybackController.ts` | 230+ | 全局链表循环控制器 |
| `hooks/useDashboardRealtime.ts` | 530 | WebSocket实时连接（心跳+重连+scope订阅） |
| `hooks/useRm2PlaybackController.ts` | 609 | RM2核心控制（拓扑刷新+组巡游+位置批量注入） |
| `hooks/useTruckPositionController.ts` | 631 | 车辆位置管理（createActiveRoute+死推+校准） |
| `hooks/useRoadGroupsController.ts` | - | RM1路线组控制 |
| `hooks/useWarehouseController.ts` | - | 仓储巡游控制 |
| `hooks/useDataFetch.ts` | - | 数据拉取Hook |
| `modules/RoadMap3D-2/hooks/useRoadControls.ts` | 1184 | 3D路线+车辆渲染（前端最大文件） |
| `modules/RoadMap3D-2/hooks/useRoadMapScene.ts` | - | 场景初始化+行政边界 |
| `modules/RoadMap3D-2/hooks/useRoadSelection.ts` | - | 路线选中交互 |
| `modules/RoadMap3D-2/hooks/useRoadMapRefs.ts` | - | 场景引用管理 |
| `modules/RoadMap3D-2/geo.ts` | 137 | 地图投影+GeoJSON加载 |
| `modules/RoadMap3D-2/constants.ts` | 6 | RM2渲染常量 |
| `modules/routeVisuals.ts` | 675 | 路线视觉效果（端点标记+辉光线+标签+共享路段） |
| `modules/routePresentation.ts` | 61 | 面板颜色逻辑（ROUTE_TONES+routeTone） |
| `modules/vehicleAlertRipples.ts` | - | 车辆告警波纹特效 |
| `modules/DashboardSidePanels.tsx` | - | 侧面板（仓库/车辆运输详情） |
| `modules/TownRoadMap3D/` | - | 城镇道路3D模块 |
| `playback/chain.ts` | 223 | 省→方向→组巡游链表构建 |
| `playback/globalChain.ts` | 45 | 全局播放链表类型定义+buildGlobalChain |
| `playback/rm2RouteIdentity.ts` | - | 路线ID映射（sceneRouteId/routeVisualKey） |
| `playback/rm2SceneAdapter.ts` | - | RM2场景适配器 |
| `playback/routeGroupRing.ts` | - | 路线组环形链表 |
| `services/renderRouteApi.ts` | 412 | 渲染路线API封装+DTO类型定义 |
| `services/roadApi.ts` | - | 路线API封装 |
| `services/dashboardAuth.ts` | - | 鉴权token管理 |
| `services/mapGeoApi.ts` | - | 地图GeoJSON加载 |
| `services/warehouseApi.ts` | - | 仓库API封装 |
| `services/dashboardKpi.ts` | - | KPI数据+事件 |
| `services/bootstrapApi.ts` | - | 启动状态API |
| `utils.ts` | - | 位置投影算法（projectDistanceOnPath/predictedPosition等） |

---

## 附录 B — 关键变量速查

### 后端

| 变量/常量 | 位置 | 值/说明 |
|-----------|------|--------|
| `RM2_GROUP_SIZE` | TownRoadRenderService | **3**（每组最多3个业务订单） |
| `activeRoutes` | RoutePushService | 活跃路线 ConcurrentHashMap |
| `loadingVehiclePositions` | RoutePushService | 装载中车辆初始位置 |
| `LOADING_DEPARTURE_THRESHOLD_KM` | RoutePushService | **1.0**（触发同步阈值） |
| `MAX_PROVIDER_SPEED_KMH` | RoutePushService | **140.0**（供应商速度上限） |
| `MAX_CALCULATED_SPEED_KMH` | RoutePushService | **160.0**（计算速度上限） |
| `POSITION_CHANGE_THRESHOLD_METERS` | RoutePushService | **35.0**（位置变化阈值） |
| `POSITION_MAX_SILENCE_MS` | RoutePushService | **120_000**（位置静默超时） |
| `MAX_CALIBRATION_OFF_ROUTE_KM` | RoutePushService | **2.0** |
| `use-truck-routing` | application.yml | **false**（轿车/货车切换） |
| `auto-sync-fixed-delay-ms` | application.yml | **900000**（15分钟订单同步） |
| `position-refresh.fixed-delay-ms` | application.yml | **30000**（30秒位置刷新） |
| `route-plan.cache-ttl-ms` | application.yml | **86400000**（24h路线缓存） |
| `trip-arrival-radius-km` | application.yml | **0.5** |
| `trip-departure-radius-km` | application.yml | **0.8** |
| `trip-minimum-dwell-ms` | application.yml | **60000** |
| `DEFAULT_API_URL` | TownRoadExternalOrderClient | `https://api.jushen.co/Freight/DispatchTransitNew/listTransitBoard` |

### 前端

| 变量/常量 | 位置 | 值/说明 |
|-----------|------|--------|
| `ROUTE_COLORS` | useRoadControls.ts | 6色数组 `[蓝,黄,绿,紫,粉,青]` |
| `ROUTE_TONES` | routePresentation.ts | 面板6色（与ROUTE_COLORS对应） |
| `MAP_HORIZONTAL_SCALE` | geo.ts | **100**（地图水平放大） |
| `ROAD_LIFT` | constants.ts | **0.08**（路线Y轴高度） |
| `TRUCK_LIFT` | constants.ts | **0.36**（卡车Y轴高度） |
| `PATH_SAMPLE_COUNT` | constants.ts | **160**（曲线采样数） |
| `TRUCK_IDLE_VISUAL_SCALE` | useRoadControls.ts | **0.14**（默认缩放） |
| `TRUCK_MODEL_SCALE` | useRoadControls.ts | **1**（选中时大小） |
| `TRUCK_HIGH_CAMERA_SCALE` | useRoadControls.ts | **1.55**（高处额外缩放） |
| `VEHICLE_UPGRADE_MS` | useRoadControls.ts | **420**（放大动画时长ms） |
| `grayTube opacity` | useRoadControls.ts | **0.10**（未走过路线虚化） |
| `POSITION_RENDER_TICK_MS` | constants.ts | **500**（死推渲染间隔ms） |
| `POSITION_QUERY_INTERVAL_MS` | constants.ts | test:**60_000** / real:**1_800_000** |
| `VITE_TRUCK_SIMULATION_PROFILE` | .env | `test` 或 `real` |
| `sceneRouteId` | rm2RouteIdentity.ts | `visualKey \|\| lineId`（场景ID） |
| `laneKeyFor` | useRoadControls.ts | 车道分组键（orderFamilyId） |
| `orderKeyFor` | useRoadControls.ts | 颜色键（colorKey+lineId） |
| `API_BASE_URL` | constants.ts | `VITE_API_BASE_URL \|\| '/api'` |
| `chinaMapLoopCount` | labelLayout.ts | **2**（ChinaMap巡游循环次数） |
| `totalLoopCount` | labelLayout.ts | **2**（大循环总次数，0=无限） |
| `VIEW_COOLDOWN_MS` | useGlobalPlaybackController.ts | **5000**（视图冷却期ms） |

---

> **文档维护**：每次功能变更后请同步更新本文档的相关章节。
> 项目代码位于：前端 `jushen-digital-twin/`、后端 `jushen-digital-twin-service/`
