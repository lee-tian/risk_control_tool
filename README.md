# Option Risk Control Tool

本项目是一个本地优先的 React + TypeScript 单页应用，用于管理 Sell Put 与 Covered Call，并在风险视图里聚焦 Sell Put 风险。

## 股票价格刷新

当前版本已接入 Twelve Data。

使用方式：

- 在 `Stock List` 中维护 `ticker`
- 为每个 ticker 维护 `beta` 和 `current price`
- 点击 `Refresh Prices`，系统会批量拉取当天价格
- 更新后，所有 Option 的价格与风险指标会自动重算；风险视图仍只展示 Put risk

当前价格是按 `Stock List` 维护的，不需要在每个 Put 里单独填写。

## 本地数据持久化

当前项目已经实现本地数据持久化，数据保存在浏览器 `localStorage` 中。

已持久化的数据包括：

- Config
- Option 仓位
- 股票代码列表
- 压力场景选择
- Risk Score 历史

实现位置：

- [src/lib/storage.ts](/Users/emily/Documents/Code/risk control tool/src/lib/storage.ts)

说明：

- 只要你使用的是同一个浏览器、同一个域名和同一个浏览器配置文件，刷新页面或重启容器后数据仍会保留
- 由于数据存在浏览器本地，而不是容器文件系统里，所以 Docker 重建容器通常不会丢失数据
- 如果你清空浏览器站点数据，或者更换浏览器，`localStorage` 数据会丢失
- 当前版本支持导出 / 导入 Option 仓位 JSON

## 导出与导入

在 `Config` 区域可以看到：

- `Export Options`：导出当前 Option 仓位为 JSON 文件
- `Import Options`：将之前导出的 Option 仓位重新导入

导出的内容包括：

- Option 仓位

## 本地运行

```bash
npm install
npm run dev
```

默认访问地址：

```text
http://localhost:60688
```

## 生产构建

```bash
npm install
npm run build
npm run preview
```

## Docker 部署

```bash
docker build -t risk-exposure-tool .
docker run --rm -p 60688:80 risk-exposure-tool
```

访问：

```text
http://localhost:60688
```

## Docker Compose 部署

已添加 Compose 文件：

- [docker-compose.yml](/Users/emily/Documents/Code/risk control tool/docker-compose.yml)
- [Dockerfile.api](/Users/emily/Documents/Code/risk control tool/Dockerfile.api)
- [api/server.mjs](/Users/emily/Documents/Code/risk control tool/api/server.mjs)

启动：

```bash
docker compose up -d --build
```

停止：

```bash
docker compose down
```

访问：

```text
http://localhost:60688
```

说明：

- Compose 会同时启动前端和价格 API
- Twelve Data API key 已通过本地 `.env` 配置
- 前端通过 `/api/quotes` 请求后端，再由后端去调用 Twelve Data

## 已实现功能

- Cash 配置持久化
- Sell Put / Covered Call 仓位增删改
- 压力场景切换
- Put 风险预算汇总
- Risk Score 趋势展示
- 复制组合摘要
