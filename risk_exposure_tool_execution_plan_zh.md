# Risk Exposure Tool 可执行实施文档

## 1. 项目目标

构建一个本地单页 Web 应用 `Risk Exposure Tool`，用于期权 Wheel Strategy 的组合级风险预算管理。

该工具不是收益跟踪器，也不是券商交易终端，核心目标是帮助用户快速判断：

- 当前总风险敞口是多少
- 股票仓位带来了多少风险
- 卖出 Put 仓位带来了多少风险
- 当前总风险占总资金的比例是多少
- 是否仍然处于预设风险预算内
- 还可以额外承担多少风险

## 2. 产品定位

这是一个“决策支持工具”，不是完整投资管理系统。

设计原则：

- 本地优先
- 轻量
- 计算正确
- 配置简单
- 持续可编辑
- 展示清晰

## 3. 业务场景

用户采用 Wheel Strategy：

- 账户基础信息只需配置一次，后续可修改
- 会持续增加、编辑或删除卖出 Put 仓位
- 也可能持有股票仓位
- 希望系统自动汇总股票风险、Put 风险和组合总风险
- 希望一眼看出当前风险是否安全，是否还能继续开新仓

## 4. 范围定义

### 4.1 本期必须实现

- 配置账户基础信息
- 新增、编辑、删除股票仓位
- 新增、编辑、删除卖出 Put 仓位
- 基于压力测试计算各类风险
- 汇总组合级风险指标
- 支持 10% / 15% / 20% 三档压力场景切换
- 将配置和仓位持久化到 `localStorage`
- 展示风险状态、仓位强度状态和简要洞察

### 4.2 明确不做

- 不接券商 API
- 不做真实交易执行
- 不做盈亏跟踪
- 不做后端服务
- 不做复杂账户同步

### 4.3 可选增强项

- “我还能不能卖一个新 Put”快速测算器
- 高亮最大风险来源
- 按 ticker 聚合风险
- 一键复制组合摘要

## 5. 数据结构

### 5.1 Config

```ts
type Config = {
  total_capital: number;
  total_cash: number;
  risk_limit_pct: number;
  default_stress_drop_pct: number;
  warning_threshold_pct: number;
};
```

字段说明：

- `total_capital`：总资金
- `total_cash`：当前现金
- `risk_limit_pct`：组合最大允许风险比例，例如 `0.02`
- `default_stress_drop_pct`：默认压力跌幅，例如 `0.10`
- `warning_threshold_pct`：预警阈值，例如 `0.8`

### 5.2 StockPosition

```ts
type StockPosition = {
  id: string;
  ticker: string;
  shares: number;
  current_price: number;
};
```

### 5.3 PutPosition

```ts
type PutPosition = {
  id: string;
  ticker: string;
  put_strike: number;
  premium_per_share: number;
  contracts: number;
  days_to_expiration: number;
};
```

## 6. 核心计算规则

### 6.1 股票风险

```ts
stock_value = shares * current_price
stock_risk = stock_value * stress_drop_pct
```

### 6.2 卖出 Put 风险

```ts
nominal_exposure = put_strike * contracts * 100
breakeven_price = put_strike - premium_per_share
net_cost_basis = breakeven_price * contracts * 100
put_risk = net_cost_basis * stress_drop_pct
```

### 6.3 组合风险

```ts
total_stock_risk = sum(stock_risk)
total_put_risk = sum(put_risk)
total_portfolio_risk = total_stock_risk + total_put_risk
portfolio_risk_pct = total_portfolio_risk / total_capital
risk_limit_amount = total_capital * risk_limit_pct
remaining_risk_budget = risk_limit_amount - total_portfolio_risk
```

## 7. 风险状态规则

### 7.1 风险状态

- `Safe`：总风险 < 风险上限的 80%
- `Near Limit`：总风险在风险上限的 80% 到 100% 之间
- `Exceeded`：总风险 > 风险上限

### 7.2 仓位强度

- `Light`：总风险 < 风险上限的 50%
- `Normal`：50% 到 80%
- `Heavy`：80% 到 100%
- `Overloaded`：> 100%

## 8. 界面结构

### 8.1 Config 区域

展示和操作：

- Total capital
- Total cash
- Risk limit %
- Default stress drop %
- Warning threshold %
- Save config2
- Edit config
- Reset config

### 8.2 股票仓位区域

操作：

- Add stock position
- Edit stock position
- Delete stock position

列字段：

- Ticker
- Shares
- Current price
- Market value
- Stress risk
- Risk % of total capital

### 8.3 卖出 Put 区域

操作：

- Add sold put
- Edit sold put
- Delete sold put

列字段：

- Ticker
- Strike
- Premium
- Contracts
- DTE
- Nominal exposure
- Breakeven
- Net cost basis
- Stress risk
- Risk % of total capital

### 8.4 组合汇总区域

必须展示：

- Total capital
- Total cash
- Total stock market value
- Total nominal put exposure
- Total stock risk
- Total put risk
- Total portfolio risk
- Portfolio risk %
- Risk limit amount
- Remaining risk budget
- Risk status
- Positioning status

### 8.5 Insights 区域

至少输出以下洞察：

- 最大风险贡献来源
- 风险最高的 ticker
- 是否还能继续增加仓位
- 当前可新增的最大风险额度
- 当前账户风险是否可控

## 9. 交互与状态要求

### 9.1 持久化

- 配置数据保存在 `localStorage`
- 股票仓位保存在 `localStorage`
- Put 仓位保存在 `localStorage`
- 刷新页面后数据仍然存在

### 9.2 实时联动

以下动作必须触发实时重算：

- 修改配置
- 新增股票仓位
- 编辑股票仓位
- 删除股票仓位
- 新增 Put 仓位
- 编辑 Put 仓位
- 删除 Put 仓位
- 切换压力场景

### 9.3 压力场景

系统必须支持：

- 10%
- 15%
- 20%

规则：

- 默认值来自 `config.default_stress_drop_pct`
- 用户可在 UI 中快速切换
- 切换后所有派生值立即刷新

## 10. 校验规则

### 10.1 输入校验

- 所有数值必须为非负数
- `contracts >= 1` 且必须为整数
- `shares >= 0` 且必须为整数
- 百分比字段必须在 `0` 到 `1` 之间
- `ticker` 不能为空

### 10.2 异常状态处理

- 缺少 config 时要有空状态提示
- 没有仓位时要有空状态提示
- 无效输入要显示友好的行内错误
- `total_capital = 0` 时要避免除零错误

## 11. 展示格式

- 金额统一按 USD 货币格式展示
- 百分比统一保留 2 位小数
- 表格必须易读，不堆叠无效信息
- 风险状态需使用明显视觉区分

## 12. 建议技术方案

### 12.1 技术栈

- React
- TypeScript
- 单页应用
- 本地状态管理
- `localStorage` 持久化

### 12.2 推荐模块拆分

- `App`：页面总入口
- `ConfigPanel`：配置管理
- `ScenarioToggle`：压力场景切换
- `StockPositionsTable`：股票仓位表
- `PutPositionsTable`：Put 仓位表
- `PortfolioSummary`：组合汇总
- `InsightsPanel`：洞察区
- `storage`：本地持久化封装
- `calculations`：风险计算逻辑
- `formatters`：金额和百分比格式化
- `validators`：输入校验

## 13. 实施任务拆解

### 阶段一：项目初始化

- 创建 React + TypeScript 项目
- 建立基础目录结构
- 配置基础样式和页面骨架

### 阶段二：数据层

- 定义 `Config`、`StockPosition`、`PutPosition` 类型
- 实现 `localStorage` 读写封装
- 建立初始默认值和容错逻辑

### 阶段三：计算层

- 实现股票风险计算函数
- 实现 Put 风险计算函数
- 实现组合汇总计算函数
- 实现风险状态和仓位状态判定函数
- 实现按 ticker 聚合与最大风险识别逻辑

### 阶段四：表单与列表

- 实现 Config 表单
- 实现股票仓位新增/编辑/删除
- 实现 Put 仓位新增/编辑/删除
- 增加行内校验和错误提示

### 阶段五：汇总与洞察

- 实现 Portfolio Summary 卡片
- 实现 Insights 文本生成
- 实现场景切换与联动重算

### 阶段六：体验优化

- 优化响应式布局
- 空状态处理
- 复制摘要功能
- 高亮最大风险项

### 阶段七：测试与验收

- 手动校验所有公式
- 验证持久化是否正常
- 验证切换压力场景后的实时刷新
- 验证边界输入与错误提示

## 14. 验收标准

### 14.1 功能验收

- 用户首次进入可完成 Config 配置
- 用户可新增、编辑、删除股票仓位
- 用户可新增、编辑、删除 Put 仓位
- 所有数据刷新页面后仍保留
- 所有风险指标随数据变更实时更新
- 可在 10% / 15% / 20% 场景间切换

### 14.2 计算验收

- 股票风险计算符合公式
- Put 风险计算符合公式
- 组合总风险等于股票风险与 Put 风险之和
- 风险占比、风险额度、剩余预算计算正确
- 风险状态和仓位状态标签正确

### 14.3 体验验收

- 页面结构清楚
- 表格易读
- 错误提示明确
- 空状态合理
- 无需后端即可完成全部核心流程

## 15. 开发优先级

优先级从高到低：

1. 风险计算正确
2. Config 配置简单
3. 仓位增删改顺畅
4. 组合汇总清晰
5. 页面简洁易读
6. 可选增强功能

## 16. 直接执行说明

如果进入实际开发，建议按以下顺序落地：

1. 先完成数据类型、存储和计算函数
2. 再完成 Config 和两个仓位模块的增删改
3. 然后接 Portfolio Summary 和 Insights
4. 最后补场景切换、复制摘要、样式优化和边界校验

## 17. 最终交付物

本项目最终应交付：

- 一个本地可运行的 React + TypeScript 单页应用
- 清晰的组件结构
- 可读的风险计算逻辑
- 无后端依赖
- 本地持久化能力
- 简洁但完整的风险视图
