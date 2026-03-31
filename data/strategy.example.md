# Aggressive Swing Strategy (Default)

> Default strategy — copy to strategy.md and customize. Designed for aggressive crypto swing trading with a bot that runs 24/7.

## Goal
Maximize gains per position. Target 15–40% per trade. Use the bot's speed and availability aggressively — it never sleeps, never panics, and can scan hundreds of assets every cycle.

---

## Portfolio Allocation
- Cash reserve: 15–30% at all times (dry powder for opportunities)
- Max single position: 35% of portfolio
- Target concurrent positions: 5–10
- Always maintain meaningful BTC exposure (20%+ of invested capital)

---

## Two Trade Types

**Momentum play** — asset moving NOW with volume behind it
- Signal: price up 5–15% today on 2x+ volume spike, or positive news catalyst
- Target: 15–25% gain, exit relatively quickly

**Recovery play** — asset beaten down on fear, fundamentals intact
- Signal: price down 15–30% from recent high, Fear & Greed below 30
- Target: 25–40% gain, hold patiently for bounce

---

## Entry Rules
- Buy during fear, not greed — Fear & Greed below 30 = accumulate
- Volume must exceed 50k EUR/24h — no illiquid traps
- Scan top_movers and top_by_volume every cycle — hunt for opportunities
- BTC pumping = alts lag behind — buy the laggards before they catch up
- No shitcoins — established assets with real ecosystems only

---

## Exit Rules
- Minimum to sell: +8% above entry (enforced in code)
- Sweet spot: +15% to +30%
- At +40%: always take profit — big moves reverse fast
- Never sell at a loss — crypto recovers, time is on your side
- Do not panic sell under any circumstances

---

## Hard Rules (Code-Enforced)
These cannot be overridden — the system will reject commands that violate them:
1. **SELL floor**: limit price must be ≥ entry_price × 1.08
2. **BUY re-entry**: current price must be ≤ last_sell_price × 0.92 (8% below your exit)

If a command is rejected, you will see it in execution_results with the reason.

---

## Sell Order Management
- Issue a SELL for every open position every cycle — no position uncovered
- Formula: MAX(entry_price × 1.15, current_price × 1.10)
- Do NOT pair BUY and SELL in the same cycle — wallet updates after the next cycle

---

## Market Signals
| Signal | Action |
|--------|--------|
| F&G < 15 | Buy aggressively — generational entries |
| F&G 15–30 | Buy recovery plays |
| F&G > 75 | Slow down, tighten sell targets |
| BTC RSI < 30 | Strong market-wide buy signal |
| Volume spike 2x+ | Momentum play entry |

---

## Command Reference
```
BUY <ASSET> <EUR>            — market buy, executes immediately
SELL <ASSET> <LIMIT_PRICE>   — limit sell entire position
HOLD                         — no new buys (still issue SELL orders for all positions)
```
- SELL = entire position, limit order only, no partial exits
- Do NOT pair BUY and SELL in the same cycle — wallet updates after the next cycle
