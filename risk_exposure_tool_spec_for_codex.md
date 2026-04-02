# Risk Exposure Tool Spec for CodeX

## Goal

Build a lightweight risk exposure tool for my options strategy.

This is **not** a P&L tracker.  
This tool is for **portfolio-level risk budgeting**.

The tool should help me answer:

1. What is my current total risk exposure?
2. How much risk comes from my stock positions?
3. How much risk comes from my sold put positions?
4. What percentage of my total capital is currently at risk?
5. Am I still within my configured risk budget?
6. How much additional risk can I still take?

---

## My Use Case

I use a Wheel Strategy.

- My base account information is entered once as **Config**
- Later, I keep adding or updating sold put positions
- I may also hold stocks
- I want the tool to combine:
  - stock risk
  - sold put risk
  - total portfolio risk

The output should be easy to read and clearly show whether my current risk is safe or too high.

---

## Product Design

Please build the tool with **two layers of data**:

### 1. Config (entered once, editable later)
This is persistent account-level setup.

It should include:

- `total_capital`: total account / household capital
- `total_cash`: current cash amount
- `risk_limit_pct`: max allowed total portfolio risk, e.g. `0.02` for 2%
- `default_stress_drop_pct`: default stress test drop, e.g. `0.10` for 10%
- `warning_threshold_pct`: optional, e.g. `0.8`, meaning warn me at 80% of my risk limit

### 2. Positions (updated over time)

#### Stock positions
Each stock position should include:

- `ticker`
- `shares`
- `current_price`

#### Sold put positions
Each sold put position should include:

- `ticker`
- `put_strike`
- `premium_per_share`
- `contracts`
- `days_to_expiration`

---

## Core Risk Model

The tool should calculate risk using **stress-test exposure**, not just nominal value.

### A. Stock Risk

For each stock position:

- `stock_value = shares * current_price`
- `stock_risk = stock_value * stress_drop_pct`

### B. Sold Put Risk

For each sold put position:

- `nominal_exposure = put_strike * contracts * 100`
- `breakeven_price = put_strike - premium_per_share`
- `net_cost_basis = breakeven_price * contracts * 100`
- `put_risk = net_cost_basis * stress_drop_pct`

### C. Portfolio Risk

- `total_stock_risk = sum(all stock_risk)`
- `total_put_risk = sum(all put_risk)`
- `total_portfolio_risk = total_stock_risk + total_put_risk`
- `portfolio_risk_pct = total_portfolio_risk / total_capital`
- `risk_limit_amount = total_capital * risk_limit_pct`
- `remaining_risk_budget = risk_limit_amount - total_portfolio_risk`

---

## Risk Status Rules

Use these labels:

- **Safe**: total risk < 80% of risk limit
- **Near Limit**: total risk is between 80% and 100% of risk limit
- **Exceeded**: total risk > risk limit

Also classify positioning:

- **Light**: total risk < 50% of risk limit
- **Normal**: total risk is 50% to 80% of risk limit
- **Heavy**: total risk is 80% to 100% of risk limit
- **Overloaded**: total risk > risk limit

---

## What the UI Should Show

Please design a simple, clean interface with these sections:

### Section 1: Config
Fields:
- Total capital
- Total cash
- Risk limit %
- Default stress drop %
- Warning threshold %

Actions:
- Save config
- Edit config
- Reset config

### Section 2: Stock Positions
Actions:
- Add stock position
- Edit stock position
- Delete stock position

Columns:
- Ticker
- Shares
- Current price
- Market value
- Stress risk
- Risk % of total capital

### Section 3: Sold Put Positions
Actions:
- Add sold put
- Edit sold put
- Delete sold put

Columns:
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

### Section 4: Portfolio Summary
Show:
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

### Section 5: Insights
Show short text insights such as:

- Largest risk contributor
- Highest-risk ticker
- Whether more positions can be added
- Maximum additional risk allowed
- Whether the account is under control

---

## Important Design Considerations

Please think through these carefully.

### 1. Config vs Transactions
- Config is entered once and reused
- Positions are added incrementally over time
- The app should preserve both config and positions between sessions

### 2. Persistence
Use local persistence.  
Preferred:
- localStorage for a simple version
- or a small local JSON file if needed

I want the app to remember my config and position history.

### 3. Editable Data
I must be able to:
- edit config
- edit any position
- delete any position
- correct mistakes easily

### 4. Multiple Stress Scenarios
Please support at least:
- 10% stress drop
- 15% stress drop
- 20% stress drop

The default can come from config, but the UI should also let me switch scenarios easily.

### 5. Clear Separation of Risk Types
The tool must clearly separate:
- stock risk
- sold put risk
- total risk

### 6. No Over-Engineering
Keep it simple and practical.
This is a decision-support tool, not a full brokerage dashboard.

---

## Recommended Technical Direction

Please build this as a **single-page local web app**.

Preferred stack:
- React
- TypeScript
- simple local state
- localStorage persistence

Nice to have:
- responsive layout
- clean cards/tables
- export / copy summary
- simple validation

No backend is required unless absolutely necessary.

---

## Validation Rules

Please include input validation:

- numbers must be non-negative
- contracts must be integer >= 1
- shares must be integer >= 0
- percentages must be between 0 and 1
- ticker cannot be empty

Also handle:
- empty state
- missing config
- invalid entries

---

## Output Formatting

Amounts:
- show as USD currency

Percentages:
- show as percent with 2 decimals

Tables:
- easy to scan
- no clutter

---

## Suggested Data Model

```ts
type Config = {
  total_capital: number;
  total_cash: number;
  risk_limit_pct: number;
  default_stress_drop_pct: number;
  warning_threshold_pct: number;
};

type StockPosition = {
  id: string;
  ticker: string;
  shares: number;
  current_price: number;
};

type PutPosition = {
  id: string;
  ticker: string;
  put_strike: number;
  premium_per_share: number;
  contracts: number;
  days_to_expiration: number;
};
```

---

## Required Calculations

### Stock
```ts
stock_value = shares * current_price
stock_risk = stock_value * stress_drop_pct
```

### Sold Put
```ts
nominal_exposure = put_strike * contracts * 100
breakeven_price = put_strike - premium_per_share
net_cost_basis = breakeven_price * contracts * 100
put_risk = net_cost_basis * stress_drop_pct
```

### Portfolio
```ts
total_stock_risk = sum(stock_risk)
total_put_risk = sum(put_risk)
total_portfolio_risk = total_stock_risk + total_put_risk
portfolio_risk_pct = total_portfolio_risk / total_capital
risk_limit_amount = total_capital * risk_limit_pct
remaining_risk_budget = risk_limit_amount - total_portfolio_risk
```

---

## Extra Feature Requests

If easy to implement, add:

1. a quick “Can I add this new put?” calculator
2. highlight the largest position risk
3. group risk by ticker
4. scenario toggle: 10% / 15% / 20%
5. copyable portfolio summary block

---

## What I Care About Most

Priority order:

1. Correct risk calculation
2. Simple config setup
3. Easy position updates
4. Clear total portfolio risk summary
5. Clean presentation

---

## Final Build Request

Please build the tool so that:

- I configure my base information once
- I can add stock and sold put positions over time
- the tool automatically recalculates my total risk exposure
- I can instantly see whether I am within my allowed risk budget
- the result is practical for real trading decisions

---

## Direct Implementation Prompt for CodeX

Build a local single-page React + TypeScript app called **Risk Exposure Tool**.

The app is a portfolio-level risk budgeting tool for a Wheel Strategy trader.

### Functional requirements

1. Persistent Config
   - total_capital
   - total_cash
   - risk_limit_pct
   - default_stress_drop_pct
   - warning_threshold_pct
   - save to localStorage

2. Persistent Positions
   - stock positions
   - sold put positions
   - add / edit / delete support
   - save to localStorage

3. Risk calculations
   - compute stock risk
   - compute sold put risk
   - compute total portfolio risk
   - compute risk % of capital
   - compute remaining risk budget

4. Scenario switching
   - support 10%, 15%, 20% stress scenarios
   - default from config
   - switching scenario updates all derived values live

5. UI sections
   - Config panel
   - Stock positions table
   - Sold put positions table
   - Portfolio summary cards
   - Insights panel

6. Validation
   - prevent invalid numbers
   - show friendly inline errors

7. UX
   - clean and minimal
   - easy to scan
   - no unnecessary complexity

### Calculation rules

For stock positions:
```ts
stock_value = shares * current_price
stock_risk = stock_value * stress_drop_pct
```

For sold put positions:
```ts
nominal_exposure = put_strike * contracts * 100
breakeven_price = put_strike - premium_per_share
net_cost_basis = breakeven_price * contracts * 100
put_risk = net_cost_basis * stress_drop_pct
```

For portfolio:
```ts
total_stock_risk = sum(stock_risk)
total_put_risk = sum(put_risk)
total_portfolio_risk = total_stock_risk + total_put_risk
portfolio_risk_pct = total_portfolio_risk / total_capital
risk_limit_amount = total_capital * risk_limit_pct
remaining_risk_budget = risk_limit_amount - total_portfolio_risk
```

### Status rules

- Safe: total risk < 80% of risk limit
- Near Limit: total risk between 80% and 100% of risk limit
- Exceeded: total risk > risk limit

Positioning labels:
- Light: < 50% of risk limit
- Normal: 50% to 80%
- Heavy: 80% to 100%
- Overloaded: > 100%

### Deliverable

Please produce:
- the full app implementation
- clear file structure
- readable components
- no backend
- local-first behavior
- a polished but simple UI
