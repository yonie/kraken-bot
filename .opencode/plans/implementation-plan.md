# Implementation Plan: Strip Bot to Raw Data

## Summary
Remove insights, previous decisions, and fix data gaps. Change from 30-day to 7-day performance stats.

---

## File 1: `src/ai/context.js`

### Change A: Always fetch BTC/ETH depth (lines 159-165)

**Current code:**
```javascript
  const positionPairsArray = [...positionPairs].filter(p => {
    const asset = p.replace(/Z?EUR$/, '').replace(/^X+/, '');
    return enriched[asset] || enriched['X' + asset] || enriched['XX' + asset];
  });
  const depthData = await kraken.fetchDepthForPairs(
    Object.keys(enriched).map(a => kraken.findPairForAsset(a)).filter(Boolean)
  );
```

**New code:**
```javascript
  const positionPairsArray = [...positionPairs].filter(p => {
    const asset = p.replace(/Z?EUR$/, '').replace(/^X+/, '');
    return enriched[asset] || enriched['X' + asset] || enriched['XX' + asset];
  });
  const depthPairs = new Set(['XXBTZEUR', 'XETHZEUR']);
  Object.keys(enriched).forEach(a => {
    const pair = kraken.findPairForAsset(a);
    if (pair) depthPairs.add(pair);
  });
  const depthData = await kraken.fetchDepthForPairs([...depthPairs]);
```

### Change B: Remove previousDecisions (lines 273-279)

**DELETE this block entirely:**
```javascript
  const previousDecisions = state.llmHistory.slice(0, 5).map(h => ({
    time: new Date(h.lastUpdate).toLocaleString(),
    sentiment: h.marketSentiment,
    risk: h.riskAssessment,
    commands: h.commands || 'HOLD',
    analysis: h.analysis?.substring(0, 200) || '' 
  }));
```

### Change C: Remove insights and previousDecisions from return (lines 372-376)

**Current code:**
```javascript
    recentLedgers,
    openOrders,
    previousDecisions,
    recentExecutionResults,
    analytics,
    assetPerformance,
    insights: state.insights.slice(0, 20),
    balanceHistory,
```

**New code:**
```javascript
    recentLedgers,
    openOrders,
    recentExecutionResults,
    analytics,
    assetPerformance,
    balanceHistory,
```

---

## File 2: `src/ai/analysis.js`

### Change A: Use 7-day stats instead of 30-day (lines 227-229)

**Current code:**
```javascript
=== YOUR PERFORMANCE (30d) ===
${ctx.analytics.totalTrades || 0} trades | ${ctx.analytics.winRate?.toFixed(0) || 0}% win rate | Realized: ${ctx.analytics.realizedPnL?.toFixed(2) || 0} EUR
By asset: ${Object.entries(ctx.assetPerformance).slice(0, 10).map(([a, s]) => `${a} ${s.winRate}% win (${s.trades}t)`).join(', ') || 'No trades'}
```

**New code:**
```javascript
=== YOUR PERFORMANCE (7d) ===
${ctx.analytics.weeklyPnL !== undefined ? `${ctx.analytics.weeklyPnL.toFixed(2)} EUR realized` : 'No trades'} | ${ctx.analytics.weeklyWinRate?.toFixed(0) || 0}% win rate (${ctx.analytics.totalTrades || 0} trades)
```

### Change B: Remove PREVIOUS DECISIONS section (lines 253-254)

**DELETE these lines:**
```javascript
=== PREVIOUS DECISIONS ===
${ctx.previousDecisions.map(d => `[${d.time}] ${d.sentiment}/${d.risk} | ${d.commands}`).join('\n') || 'None'}

```

### Change C: Remove INSIGHT sections (lines 265-269)

**DELETE these lines:**
```javascript
INSIGHT: [Optional: ONE trading pattern. Before writing, COMPARE your idea against existing insights below. If your idea is similar to ANY existing insight (same topic, same lesson), skip this field entirely. Only provide an insight that covers a NEW topic not mentioned below. Max 80 chars, no personal pronouns.]
${ctx.insights && ctx.insights.length > 0 ? `
=== EXISTING INSIGHTS (skip if your idea is similar to any of these) ===
${ctx.insights.slice(0, 15).map(i => `• ${i.insight}`).join('\n')}` : ''}

```

### Change D: Remove insight storage logic (lines 92-103)

**DELETE this block:**
```javascript
    if (parsed.insight && parsed.insight.length > 5) {
      state.insights.unshift({
        insight: parsed.insight,
        time: Date.now(),
        sentiment: parsed.sentiment
      });
      if (state.insights.length > 50) {
        state.insights = state.insights.slice(0, 50);
      }
      saveInsights();
      log(`[AI] New insight stored: ${parsed.insight}`);
    }
```

---

## File 3: `data/insights.json`

**Replace content with:**
```json
[]
```

---

## File 4: `data/questions.json`

**Replace content with:**
```json
[]
```

---

## After Implementation

Run:
```bash
pm2 restart 6
```

Then check the new prompt:
```bash
cat /home/pi/code/npm-kraken-bot/data/llm_prompt_latest.txt
```

---

## Expected New Prompt Structure

```
=== TIME ===
...

=== GLOBAL MARKET ===
...

=== BTC ===
Price: ...
24h Change: ...
7d close: ...
Depth: X.XXM EUR bid / X.XXM EUR ask to 5%   <-- NEW: always present now
Walls - Bid: ... | Ask: ...

=== ETH ===
... (same with depth)
...

=== NEWS ===
...

=== PORTFOLIO ===
...

=== POSITIONS ===
...

=== YOUR PERFORMANCE (7d) ===          <-- CHANGED: now 7d, simpler format
X.XX EUR realized | XX% win rate (XX trades)

=== OPEN ORDERS ===
...

=== TOP 20 BY VOLUME ===
...

=== TOP 10 MOVERS ===
...

=== RECENT TRADES (7d) ===
...

=== DEPOSITS/WITHDRAWALS (7d) ===
...

=== EXECUTION RESULTS ===               <-- KEPT: shows recent outcomes
...

=== RESPONSE FORMAT ===
SENTIMENT: [bullish/neutral/bearish]
RISK: [low/medium/high]

ANALYSIS: [Your reasoning. Reference specific data.]

REQUEST: [Optional: ONE piece of data you wish you had...]

COMMANDS:
[One command per line, or HOLD]
```

Note: PREVIOUS DECISIONS and INSIGHTS sections are removed.