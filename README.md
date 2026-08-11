# 聚申数字孪生前端

数字孪生大屏前端，负责全国仓储、RM1/RM2 路线组、复合行程、车辆位置和实时指标的三维展示。

## 文档

- 本文件：安装、配置、运行和发布。
- `TECHNICAL_DOCUMENTATION.md`：前端架构、播放链、数据契约和开发注意事项。
- 跨前后端协议见工作区根目录 `TECHNICAL_DOCUMENTATION.md`。

除以上文件外，不再维护其他前端交接文档。

## 环境要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- 已启动的后端服务，默认 `http://localhost:8080`

## 安装与运行

```powershell
npm install
npm run dev
```

浏览器访问 http://localhost:5173。开发服务器会代理：

- `/api` -> `http://127.0.0.1:8080`
- `/ws` -> `ws://127.0.0.1:8080`

## 环境变量

从 `.env.example` 创建本机 `.env`。常用变量：

| 变量 | 说明 | 默认行为 |
|---|---|---|
| `VITE_API_BASE_URL` | REST 基地址 | 留空时使用 `/api` |
| `VITE_WS_URL` | WebSocket 地址 | 留空时使用当前站点 `/ws` |
| `VITE_WS_TOKEN` | 旧版固定口令兼容项 | 正常使用会话鉴权时留空 |
| `VITE_TRUCK_SIMULATION_PROFILE` | `test` 或 `real` | 控制位置轮询档位 |
| `VITE_TRUCK_*` | 位置查询、低速和渲染间隔 | 参考 `.env.example` |

所有 `VITE_*` 值都会进入浏览器构建产物，不能放服务端密钥。

## 命令

```powershell
npm run lint
npm test
npm run build
npm run preview
```

生产产物位于 `dist/`。部署时应由反向代理把同域 `/api` 和 `/ws` 转发至后端，避免写死后端地址。

## 目录

```text
src/
  components/Layout/            页面框架
  config/                       播放和标签配置
  data/                         城市与静态数据
  pages/Dashboard/
    components/                 控制按钮和队列
    hooks/                      页面业务控制器
    modules/                    ChinaMap、RM1、RM2 与侧面板
    playback/                   全局和组内播放状态机
    services/                   REST、鉴权和 DTO
public/
  map/bound/                    行政区 GeoJSON
  models/                       车辆模型
```

## 发布前检查

1. `npm run lint` 无错误。
2. `npm test` 全部通过。
3. `npm run build` 成功。
4. `.env` 未被 Git 跟踪。
5. 验证页、WebSocket 重连、ChinaMap、RM1、RM2 至少各冒烟一次。
