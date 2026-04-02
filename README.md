# Option Risk Control Tool

本项目是一个本地优先的 React + TypeScript 单页应用，用于管理 Sell Put 与 Covered Call，并在风险视图里聚焦 Sell Put 风险。

## 技术栈

- 前端：Vite + React + TypeScript
- API：Node.js
- 本地 / Docker 持久化：文件存储
- Vercel 持久化：Blob JSON（通过 `APP_STORAGE_DRIVER=blob-json` 切换，当前使用 public blob）

## 股票价格刷新

当前版本已接入 Twelve Data。

使用方式：

- 在 `Stock List` 中维护 `ticker`
- 为每个 ticker 维护 `beta` 和 `current price`
- 点击 `Refresh Prices`，系统会批量拉取当天价格
- 更新后，所有 Option 的价格与风险指标会自动重算；风险视图仍只展示 Put risk

当前价格是按 `Stock List` 维护的，不需要在每个 Put 里单独填写。

## 数据持久化

项目现在有两层持久化：

- 浏览器本地：`localStorage`
- API 侧快照：app state / VIX cache

浏览器本地持久化实现：

- [storage.ts](/Users/emily/Documents/Code/risk_control_tool/src/lib/storage.ts)

API 持久化实现：

- [index.mjs](/Users/emily/Documents/Code/risk_control_tool/api/lib/storage/index.mjs)
- [fileStore.mjs](/Users/emily/Documents/Code/risk_control_tool/api/lib/storage/fileStore.mjs)
- [blobStore.mjs](/Users/emily/Documents/Code/risk_control_tool/api/lib/storage/blobStore.mjs)

说明：

- 本地和 Docker 默认使用 `file` 驱动，数据保存在 [app-state.json](/Users/emily/Documents/Code/risk_control_tool/data/app-state.json) 和 [vix-cache.json](/Users/emily/Documents/Code/risk_control_tool/data/vix-cache.json)
- Vercel 部署建议使用 `blob-json` 驱动，把 `app-state.json` 和 `vix-cache.json` 存到 Blob
- 当前实现基于 `@vercel/blob` 服务端 `put()` 的限制，使用 public blob pathname 存储这两个 JSON 文件
- 只要同一浏览器和同一站点不清空站点数据，浏览器本地状态会保留
- 即使浏览器本地数据丢失，只要 API 快照还在，页面刷新后也能恢复大部分状态

## 后台自动刷新

当前仓库已经支持“浏览器关闭后仍然后台刷新”：

- 服务端新增了受保护的刷新接口：
  - [/Users/emily/Documents/Code/risk_control_tool/api/server.mjs](/Users/emily/Documents/Code/risk_control_tool/api/server.mjs)
  - 路径：`/api/cron/refresh-market-data`
- GitHub Actions 定时任务文件：
  - [/Users/emily/Documents/Code/risk_control_tool/.github/workflows/refresh-market-data.yml](/Users/emily/Documents/Code/risk_control_tool/.github/workflows/refresh-market-data.yml)

刷新规则：

- GitHub Actions 每 `10` 分钟触发一次
- 服务端只会在**美股盘中**刷新股票 / 期权
- 股票只有超过 `20` 分钟未更新才会刷新
- 期权只有超过 `30` 分钟未更新才会刷新
- `VIX / CNN Fear & Greed` 会顺手一起更新缓存

这样做的原因是：

- 你当前 Vercel 是 `Hobby`
- Vercel 官方文档写明 Hobby Cron 只能 `once per day`
- 所以这里改成 GitHub Actions 定时调用，才能满足你想要的 20 / 30 分钟后台刷新

配置方式：

1. 在 Vercel `Environment Variables` 里新增：

```text
CRON_SECRET=<一串随机长字符串>
```

2. 在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 里新增：

```text
CRON_SECRET=<和 Vercel 完全相同的值>
CRON_REFRESH_URL=https://你的域名/api/cron/refresh-market-data
```

3. push 到 GitHub 后，GitHub Actions 会自动按计划调用

也可以手动测试：

```bash
curl --fail -X POST \
  -H "Authorization: Bearer <your_cron_secret>" \
  -H "Content-Type: application/json" \
  https://你的域名/api/cron/refresh-market-data \
  -d '{"include_vix":true}'
```

## 导出与导入

在 `Config` 区域可以看到：

- `Export All Data`：导出当前股票、期权、历史、配置等完整数据
- `Import`：导入之前导出的 JSON

导出的内容包括：

- 股票持仓
- Option 仓位
- 历史记录
- 配置与场景数据

## 本地运行

```bash
npm install
npm run dev
npm run dev:api
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

## Docker Compose 部署

已添加 Compose 文件：

- [docker-compose.yml](/Users/emily/Documents/Code/risk_control_tool/docker-compose.yml)
- [Dockerfile.api](/Users/emily/Documents/Code/risk_control_tool/Dockerfile.api)
- [server.mjs](/Users/emily/Documents/Code/risk_control_tool/api/server.mjs)

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
- Docker 下默认强制使用 `APP_STORAGE_DRIVER=file`
- Twelve Data / Gemini 等 key 通过本地 `.env` 配置
- 前端通过 `/api/quotes` 请求后端，再由后端去调用 Twelve Data

## Vercel 部署

项目已经补好 Vercel 配置文件：

- [vercel.json](/Users/emily/Documents/Code/risk_control_tool/vercel.json)
- [api.mjs](/Users/emily/Documents/Code/risk_control_tool/vercel/api.mjs)
- [VERCEL_MIGRATION.md](/Users/emily/Documents/Code/risk_control_tool/VERCEL_MIGRATION.md)

### 你需要准备

1. 一个 GitHub 仓库
2. 一个 Vercel 项目
3. 一个 Vercel Blob 存储

### Vercel 控制台逐步配置

1. 把当前仓库 push 到 GitHub
2. 登录 Vercel，点击 `Add New...`
3. 选择 `Project`
4. 选择你的 GitHub 仓库并点击 `Import`
5. Framework Preset 选择 `Vite`
6. Root Directory 保持仓库根目录
7. Build Command 填：

```text
npm run build
```

8. Output Directory 填：

```text
dist
```

9. 进入 `Environment Variables`
10. 添加下面这些变量，并至少勾选 `Production`

```text
APP_STORAGE_DRIVER=blob-json
BLOB_READ_WRITE_TOKEN=...
APP_STATE_BLOB_PATH=risk-tool/app-state.json
VIX_CACHE_BLOB_PATH=risk-tool/vix-cache.json
GEMINI_API_KEY=...
TWELVE_DATA_API_KEY=...
MARKETDATA_TOKEN=...
CRON_SECRET=...
```

11. 点击 `Deploy`
12. 首次部署成功后，打开项目域名
13. 到应用里手动验证：
    - `/api/health`
    - 股票刷新
    - Option 新增 / 删除
    - 卖前分析
    - App State 保存后刷新是否恢复

### 本地联调 Vercel 环境

```bash
npm install
npx vercel dev
```

如果需要把 Vercel Development 环境变量同步到本地，可以使用：

```bash
npx vercel env pull
```

## GitHub + Vercel 上线建议顺序

1. 先在本地确认 Docker 版本正常
2. push 到 GitHub 新分支
3. 在 Vercel 上创建 Preview Deployment
4. 验证 API、行情刷新、持久化都正常
5. 再合并到 `main`，生成 Production Deployment

## 已实现功能

- Cash 配置持久化
- Sell Put / Covered Call 仓位增删改
- 压力场景切换
- Put 风险预算汇总
- Risk Score 趋势展示
- 复制组合摘要
- Docker 与 Vercel 双部署路径兼容
