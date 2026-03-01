# Fix Performance Stats to Reflect Actual 7-Day Data

## Problem

The LLM sees misleading performance data:

```
=== YOUR PERFORMANCE (7d) ===
-515.94 EUR realized | 12% win rate (659 trades)
```

**Bugs:**
1. "659 trades" is ALL-TIME, not 7-day
2. "12% win rate" is from last 50 completed trades (weeks/months), not 7 days
3. "-515.94 EUR" is from last 50 trades, not 7 days
4. `oneWeekAgo` variable is defined but never used

This causes the bot to think "I lose money trading" when market conditions (extreme fear) suggest buying.

---

## Fix: `src/kraken/balance.js` lines 155-205

**Current code:**
```javascript
// Build analytics summary
let totalPnL = 0;
let wins = 0;
let losses = 0;
const recentActivity = [];
const oneWeekAgo = (Date.now() - (7 * 24 * 60 * 60 * 1000)) / 1000;

for (const asset in state.costBasis) {
  const cb = state.costBasis[asset];
  totalPnL += cb.realizedPnL;
  
  for (const t of cb.completedTrades) {
    if (t.pnl >= 0) wins++;
    else losses++;
    
    recentActivity.push({
      asset,
      pnl: t.pnl,
      pnlPercent: t.pnlPercent,
      sellTime: t.sellTime,
      sellPrice: t.sellPrice
    });
  }
}

recentActivity.sort((a, b) => b.sellTime - a.sellTime);

const displayedTrades = recentActivity.slice(0, 50);

let displayedPnL = 0;
let displayedWins = 0;
let displayedLosses = 0;
for (const t of displayedTrades) {
  displayedPnL += t.pnl;
  if (t.pnl >= 0) displayedWins++;
  else displayedLosses++;
}

state.tradeAnalytics = {
  lastUpdate: Date.now(),
  summary: {
    totalTrades: wins + losses,
    realizedPnL: totalPnL,
    weeklyPnL: displayedPnL,
    winningTrades: wins,
    losingTrades: losses,
    winRate: (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0,
    weeklyWinRate: (displayedWins + displayedLosses) > 0 ? (displayedWins / (displayedWins + displayedLosses)) * 100 : 0
  },
  recentActivity: displayedTrades
};
```

**New code:**
```javascript
// Build analytics summary
let totalPnL = 0;
let wins = 0;
let losses = 0;
let weeklyPnL = 0;
let weeklyWins = 0;
let weeklyLosses = 0;
let weeklyTrades = 0;
const recentActivity = [];
const oneWeekAgo = (Date.now() - (7 * 24 * 60 * 60 * 1000)) / 1000;

for (const asset in state.costBasis) {
  const cb = state.costBasis[asset];
  totalPnL += cb.realizedPnL;
  
  for (const t of cb.completedTrades) {
    if (t.pnl >= 0) wins++;
    else losses++;
    
    // Only count 7-day trades for weekly stats
    if (t.sellTime >= oneWeekAgo) {
      weeklyTrades++;
      weeklyPnL += t.pnl;
      if (t.pnl >= 0) weeklyWins++;
      else weeklyLosses++;
    }
    
    recentActivity.push({
      asset,
      pnl: t.pnl,
      pnlPercent: t.pnlPercent,
      sellTime: t.sellTime,
      sellPrice: t.sellPrice
    });
  }
}

recentActivity.sort((a, b) => b.sellTime - a.sellTime);

const displayedTrades = recentActivity.slice(0, 50);

state.tradeAnalytics = {
  lastUpdate: Date.now(),
  summary: {
    totalTrades: wins + losses,
    realizedPnL: totalPnL,
    weeklyPnL: weeklyPnL,
    weeklyTrades: weeklyTrades,
    weeklyWins: weeklyWins,
    weeklyLosses: weeklyLosses,
    winningTrades: wins,
    losingTrades: losses,
    winRate: (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0,
    weeklyWinRate: weeklyTrades > 0 ? (weeklyWins / weeklyTrades) * 100 : 0
  },
  recentActivity: displayedTrades
};
```

---

## Fix: `src/ai/analysis.js` prompt template

**Current line 227-228:**
```javascript
=== YOUR PERFORMANCE (7d) ===
${ctx.analytics.weeklyPnL !== undefined ? `${ctx.analytics.weeklyPnL.toFixed(2)} EUR realized` : 'No trades'} | ${ctx.analytics.weeklyWinRate?.toFixed(0) || 0}% win rate (${ctx.analytics.totalTrades || 0} trades)
```

**New code:**
```javascript
=== YOUR PERFORMANCE (7d) ===
${ctx.analytics.weeklyTrades > 0 ? `${ctx.analytics.weeklyPnL.toFixed(2)} EUR realized | ${ctx.analytics.weeklyWinRate.toFixed(0)}% win rate (${ctx.analytics.weeklyTrades} trades)` : 'No completed trades this week'}
```

---

## After Implementation

1. Run `pm2 restart 6`
2. Trigger new analysis: `curl -X POST http://localhost:8000/api/analyze`
3. Verify prompt shows accurate 7-day data

---

## Expected Result

**Before:**
```
=== YOUR PERFORMANCE (7d) ===
-515.94 EUR realized | 12% win rate (659 trades)
```

**After:**
```
=== YOUR PERFORMANCE (7d) ===
No completed trades this week
```

Or if there were trades in last 7 days:
```
=== YOUR PERFORMANCE (7d) ===
2983.61 EUR realized | 0% win rate (1 trades)
```

This shows the actual SELL that happened on Feb 28, rather than all-time stats labeled as "7d".