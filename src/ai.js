// @ts-check
/**
 * AI/LLM Module
 * Handles market analysis and trade execution
 */

const https = require('https');
const path = require('path');
const fs = require('fs');
const { state, log, saveLLMAnalysis, saveLLMHistory, saveAIExecutions, DATA_DIR } = require('./state');
const kraken = require('./kraken');

let config = {
  apiKey: null,
  model: 'x-ai/grok-3-mini-beta',
  enabled: true,
  intervalHours: 1
};

// ============================================
// INITIALIZATION
// ============================================

function init(apiKey, model) {
  config.apiKey = apiKey;
  if (model) config.model = model;
  log(`[AI] Initialized with model: ${config.model}`);
}

// ============================================
// LLM API
// ============================================

function sanitizeResponse(text) {
  if (!text) return text;
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2026]/g, '...')
    .replace(/[\u20AC]/g, 'EUR');
}

async function callLLM(prompt) {
  if (!config.apiKey) {
    console.error('[AI] No API key configured');
    return null;
  }
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 600
    });

    const req = https.request({
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'HTTP-Referer': 'https://kraken-bot.local',
        'X-Title': 'Kraken Trading Bot'
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message));
          } else {
            resolve(sanitizeResponse(parsed.choices?.[0]?.message?.content));
          }
        } catch (e) {
          reject(new Error('Failed to parse response'));
        }
      });
    });

    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

// ============================================
// COMMAND PARSING
// ============================================

function parseCommands(raw) {
  const actions = [];
  
  const commandsMatch = raw.match(/COMMANDS:\s*([\s\S]*?)(?:\n\n|$)/i);
  const text = commandsMatch ? commandsMatch[1] : raw;
  
  // SELL <ASSET> <price>
  for (const match of text.matchAll(/^SELL\s+([A-Z0-9]{1,10})\s+(\d+(?:\.\d+)?)/gim)) {
    // Strip EUR/ZEUR suffix - AI sometimes includes it from pair names
    const asset = match[1].toUpperCase().replace(/Z?EUR$/, '');
    const price = parseFloat(match[2]);
    if (asset !== 'EUR' && asset !== 'HOLD' && asset.length > 0 && price > 0) {
      actions.push({ action: 'SELL', asset, price });
    }
  }
  
  // BUY <ASSET> <amount_eur> <price>
  for (const match of text.matchAll(/^BUY\s+([A-Z0-9]{1,10})\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/gim)) {
    // Strip EUR/ZEUR suffix - AI sometimes includes it from pair names
    const asset = match[1].toUpperCase().replace(/Z?EUR$/, '');
    const amountEur = parseFloat(match[2]);
    const price = parseFloat(match[3]);
    if (asset !== 'EUR' && asset !== 'HOLD' && asset.length > 0 && amountEur > 0 && price > 0) {
      actions.push({ action: 'BUY', asset, amountEur, price });
    }
  }
  
  // CANCEL <order_id> - Kraken order IDs are like "OGUAMO-DKTTN-BYR5Q2"
  for (const match of text.matchAll(/^CANCEL\s+([A-Z0-9]{6}-[A-Z0-9]{5}-[A-Z0-9]{6})/gim)) {
    const orderId = match[1].toUpperCase();
    actions.push({ action: 'CANCEL', orderId });
  }
  
  // Also support CANCEL BUY/SELL <ASSET> format - cancel all orders for that asset/type
  for (const match of text.matchAll(/^CANCEL\s+(BUY|SELL)\s+([A-Z0-9]{1,10})/gim)) {
    const orderType = match[1].toLowerCase();
    const asset = match[2].toUpperCase().replace(/Z?EUR$/, '');
    if (asset !== 'EUR' && asset.length > 0) {
      actions.push({ action: 'CANCEL_BY_ASSET', orderType, asset });
    }
  }
  
  log(`[AI] Parsed ${actions.length} commands: ${JSON.stringify(actions)}`);
  return actions;
}

// ============================================
// EXECUTION
// ============================================

async function executeCommands(actions) {
  const results = [];
  
  for (const action of actions) {
    // Handle CANCEL commands separately - they don't need a pair
    if (action.action === 'CANCEL') {
      try {
        log(`[AI-EXEC] Cancelling order: ${action.orderId}`);
        const cancelResult = await kraken.cancelOrder(action.orderId);
        if (cancelResult.success) {
          log(`[AI-EXEC] Cancelled order ${action.orderId}`);
          delete state.orders[action.orderId];
          state.aiExecutionHistory.executions.push({
            timestamp: Date.now(),
            action: 'CANCEL',
            orderId: action.orderId,
            result: 'success'
          });
          state.aiExecutionHistory.dailyCount++;
          saveAIExecutions();
          results.push({ ...action, success: true });
        } else {
          log(`[AI-EXEC] Failed to cancel order ${action.orderId}: ${cancelResult.error}`);
          results.push({ ...action, success: false, error: cancelResult.error });
        }
      } catch (e) {
        console.error(`[AI-EXEC] Cancel error:`, e.message);
        results.push({ ...action, success: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    
    // Handle CANCEL_BY_ASSET - cancel all orders of a type for an asset
    if (action.action === 'CANCEL_BY_ASSET') {
      const pair = kraken.findPairForAsset(action.asset);
      if (!pair) {
        log(`[AI-EXEC] No pair found for ${action.asset}`);
        results.push({ ...action, success: false, error: 'pair_not_found' });
        continue;
      }
      
      // Find matching orders
      const matchingOrders = Object.entries(state.orders).filter(([id, o]) => {
        const orderPair = o.descr?.pair;
        const orderType = o.descr?.type;
        const pairMatch = orderPair === pair || 
                          orderPair === pair.replace('ZEUR', 'EUR') ||
                          orderPair === pair.replace('EUR', 'ZEUR') ||
                          orderPair?.replace(/Z?EUR$/, '') === action.asset;
        return pairMatch && orderType === action.orderType;
      });
      
      if (matchingOrders.length === 0) {
        log(`[AI-EXEC] No ${action.orderType} orders found for ${action.asset}`);
        results.push({ ...action, success: false, error: 'no_matching_orders' });
        continue;
      }
      
      let cancelledCount = 0;
      for (const [orderId, order] of matchingOrders) {
        try {
          log(`[AI-EXEC] Cancelling ${action.orderType} order for ${action.asset}: ${orderId}`);
          const cancelResult = await kraken.cancelOrder(orderId);
          if (cancelResult.success) {
            log(`[AI-EXEC] Cancelled order ${orderId}`);
            delete state.orders[orderId];
            cancelledCount++;
          } else {
            log(`[AI-EXEC] Failed to cancel order ${orderId}: ${cancelResult.error}`);
          }
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error(`[AI-EXEC] Cancel error:`, e.message);
        }
      }
      
      if (cancelledCount > 0) {
        state.aiExecutionHistory.executions.push({
          timestamp: Date.now(),
          action: 'CANCEL_BY_ASSET',
          orderType: action.orderType,
          asset: action.asset,
          count: cancelledCount,
          result: 'success'
        });
        state.aiExecutionHistory.dailyCount++;
        saveAIExecutions();
      }
      results.push({ ...action, success: cancelledCount > 0, cancelled: cancelledCount });
      continue;
    }
    
    const pair = kraken.findPairForAsset(action.asset);
    if (!pair) {
      log(`[AI-EXEC] No pair found for ${action.asset}`);
      results.push({ ...action, success: false, error: 'pair_not_found' });
      continue;
    }
    
    try {
      // Cancel any existing orders for this pair before placing new one
      const existingOrders = Object.entries(state.orders).filter(([id, order]) => {
        const orderPair = order.descr?.pair;
        // Match by pair name (may have different formats)
        return orderPair === pair || 
               orderPair === pair.replace('ZEUR', 'EUR') ||
               orderPair === pair.replace('EUR', 'ZEUR');
      });
      
      for (const [orderId, order] of existingOrders) {
        log(`[AI-EXEC] Cancelling existing ${order.descr?.type} order for ${pair}: ${orderId}`);
        const cancelResult = await kraken.cancelOrder(orderId);
        if (cancelResult.success) {
          log(`[AI-EXEC] Cancelled order ${orderId}`);
          delete state.orders[orderId];
        } else {
          log(`[AI-EXEC] Failed to cancel order ${orderId}: ${cancelResult.error}`);
        }
        // Small delay after cancel
        await new Promise(r => setTimeout(r, 500));
      }
      
      let result;
      
      if (action.action === 'SELL') {
        const asset = state.pairs[pair]?.base;
        const holding = state.wallet[asset];
        
        if (!holding || holding.amount <= 0) {
          results.push({ ...action, success: false, error: 'no_holdings' });
          continue;
        }
        
        // Try selling 100% first, then fall back to smaller amounts if it fails
        const volumeAttempts = [1.0, 0.999, 0.99];
        for (const multiplier of volumeAttempts) {
          const volume = holding.amount * multiplier;
          result = await kraken.limitSell(pair, volume, action.price);
          if (result?.success) {
            if (multiplier < 1.0) {
              console.log(`[AI-EXEC] Sell succeeded at ${multiplier * 100}% volume`);
            }
            break;
          }
          // Only retry if it looks like a volume/rounding issue
          if (multiplier < 0.99 || !result?.error?.includes?.('volume')) {
            break;
          }
          console.log(`[AI-EXEC] Sell at ${multiplier * 100}% failed, retrying with less...`);
          await new Promise(r => setTimeout(r, 500));
        }
        
      } else if (action.action === 'BUY') {
        const available = state.wallet['ZEUR']?.amount || 0;
        
        if (available < action.amountEur) {
          results.push({ ...action, success: false, error: 'insufficient_balance' });
          continue;
        }
        
        result = await kraken.limitBuy(pair, action.amountEur, action.price);
      }
      
      if (result?.success) {
        state.aiExecutionHistory.executions.push({
          timestamp: Date.now(),
          action: action.action,
          asset: action.asset,
          price: action.price,
          result: 'success'
        });
        state.aiExecutionHistory.dailyCount++;
        saveAIExecutions();
      }
      
      results.push({ ...action, ...result });
      
      // Rate limit between orders
      await new Promise(r => setTimeout(r, 1000));
      
    } catch (e) {
      console.error(`[AI-EXEC] Error:`, e.message);
      results.push({ ...action, success: false, error: e.message });
    }
  }
  
  return results;
}

// ============================================
// MARKET ANALYSIS
// ============================================

// Clean asset name for display - only strip Kraken's X/Z prefixes for legacy assets
// e.g., XXBT -> XBT, XETH -> ETH, ZEUR -> EUR, but ZEREBRO stays ZEREBRO
function cleanAssetName(asset) {
  // Known Kraken prefixed assets (legacy naming)
  const krakenPrefixed = ['XXBT', 'XETH', 'XLTC', 'XXRP', 'XXLM', 'XZEC', 'XXMR', 'XETC', 'XREP', 'XMLN', 'ZEUR', 'ZUSD', 'ZGBP', 'ZCAD', 'ZJPY'];
  
  if (krakenPrefixed.includes(asset)) {
    return asset.slice(1); // Strip single prefix
  }
  
  // For XX-prefixed assets like XXBT
  if (asset.startsWith('XX') && asset.length <= 6) {
    return asset.slice(1);
  }
  
  return asset;
}

function buildContext() {
  const enriched = kraken.getEnrichedPositions();
  const minValue = 1.0;
  
  // Get EUR cash balance (ZEUR is Kraken's EUR)
  const eurCash = state.wallet['ZEUR']?.amount || state.wallet['EUR']?.amount || 0;
  const totalPortfolio = state.tradeBalance;
  const investedValue = totalPortfolio - eurCash;
  
  // Build positions list with ticker data for each holding
  const positions = [];
  for (const asset in enriched) {
    const p = enriched[asset];
    if (p.currentValue >= minValue) {
      // Find ticker for this asset
      const pair = kraken.findPairForAsset(asset);
      const ticker = pair ? state.ticker[pair] : null;
      
      positions.push({
        asset: cleanAssetName(asset),
        value: p.currentValue.toFixed(2),
        pnl: p.unrealizedPnL.toFixed(2),
        pnlPct: p.unrealizedPct.toFixed(1) + '%',
        days: p.holdingDays,
        avgEntry: p.avgCost?.toFixed(6) || 'N/A',
        // Ticker data for this holding
        price: ticker?.price?.toFixed(ticker.price < 1 ? 6 : 2) || 'N/A',
        // Bid/Ask for optimal order placement
        bid: ticker?.bid?.toFixed(ticker.bid < 1 ? 6 : 2) || 'N/A',
        ask: ticker?.ask?.toFixed(ticker.ask < 1 ? 6 : 2) || 'N/A',
        spread: ticker?.spreadPct?.toFixed(2) + '%' || 'N/A',
        // 24h range
        low24: ticker?.low24?.toFixed(ticker.low24 < 1 ? 6 : 2) || 'N/A',
        high24: ticker?.high24?.toFixed(ticker.high24 < 1 ? 6 : 2) || 'N/A',
        distFromLow: ticker?.distFromLow || 0,
        dayMove: ticker?.dayMove || 0,
        // Volume and activity (EUR value traded)
        volume24: ticker?.volumeEur?.toFixed(0) || 'N/A',
        vwap: ticker?.vwap?.toFixed(ticker.vwap < 1 ? 6 : 2) || 'N/A',
        trades24h: ticker?.trades24h || 0
      });
    }
  }
  
  // Build holdings list (all assets including EUR)
  const holdings = [];
  for (const asset in state.wallet) {
    const w = state.wallet[asset];
    if (w.value >= minValue || (asset === 'ZEUR' && w.amount >= 0.01)) {
      holdings.push({
        asset: asset === 'ZEUR' ? 'EUR (cash)' : cleanAssetName(asset),
        amount: w.amount.toFixed(asset === 'ZEUR' ? 2 : 6),
        value: w.value.toFixed(2),
        pctOfPortfolio: totalPortfolio > 0 ? ((w.value / totalPortfolio) * 100).toFixed(1) : '0'
      });
    }
  }
  // Sort holdings by value descending, but keep EUR at top
  holdings.sort((a, b) => {
    if (a.asset === 'EUR (cash)') return -1;
    if (b.asset === 'EUR (cash)') return 1;
    return parseFloat(b.value) - parseFloat(a.value);
  });
  
  // Top movers - get more of them (20)
  const movers = Object.entries(state.ticker)
    .map(([pair, t]) => ({ pair, ...t }))
    .sort((a, b) => b.dayMove - a.dayMove)
    .slice(0, 20);
  
  // Top 20 by volume (EUR value traded in 24h)
  const topByVolume = Object.entries(state.ticker)
    .map(([pair, t]) => ({ pair, ...t }))
    .sort((a, b) => (b.volumeEur || 0) - (a.volumeEur || 0))
    .slice(0, 20);
  
  // Recent trades - get all trades from last 7 days
  const sevenDaysAgo = Date.now() / 1000 - (7 * 24 * 60 * 60);
  const recentTrades = state.trades
    .filter(t => t.time >= sevenDaysAgo)
    .map(t => ({
      type: t.type,
      pair: t.pair.replace('EUR', ''),
      cost: parseFloat(t.cost).toFixed(2),
      price: parseFloat(t.price).toFixed(t.price < 1 ? 6 : 2),
      volume: parseFloat(t.vol).toFixed(6),
      time: new Date(t.time * 1000).toLocaleString()
    }));
  
  // Open orders with more detail - include order ID for cancellation
  const openOrders = Object.entries(state.orders).map(([id, o]) => ({
    id,  // Order ID for CANCEL command
    type: o.descr?.type,
    pair: o.descr?.pair,
    asset: o.descr?.pair?.replace(/Z?EUR$/, '') || 'UNKNOWN',
    price: o.descr?.price,
    volume: parseFloat(o.vol).toFixed(6),
    orderType: o.descr?.ordertype,
    status: o.status,
    created: new Date(o.opentm * 1000).toLocaleString()
  }));
  
  // Previous decisions - get last 15 for better context
  const previousDecisions = state.llmHistory.slice(0, 15).map(h => ({
    time: new Date(h.lastUpdate).toLocaleString(),
    sentiment: h.marketSentiment,
    risk: h.riskAssessment,
    commands: h.commands || 'HOLD',
    analysis: h.analysis?.substring(0) || '' 
  }));
  
  // Performance summary
  const analytics = state.tradeAnalytics.summary;
  
  // Calculate some additional useful metrics
  const unrealizedPnL = positions.reduce((sum, p) => sum + parseFloat(p.pnl), 0);
  const cashPct = totalPortfolio > 0 ? ((eurCash / totalPortfolio) * 100).toFixed(1) : '0';
  
  // Portfolio value history - sample daily snapshots from the last 7 days
  const balanceHistory = [];
  if (state.balanceHistory.length > 0) {
    const now = Date.now();
    // Get one snapshot per day for the last 7 days
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
      const targetTime = now - (daysAgo * 24 * 60 * 60 * 1000);
      const dayStart = targetTime - (12 * 60 * 60 * 1000); // 12h window
      const dayEnd = targetTime + (12 * 60 * 60 * 1000);
      
      // Find closest snapshot to this day
      const daySnapshots = state.balanceHistory.filter(s => s.timestamp >= dayStart && s.timestamp <= dayEnd);
      if (daySnapshots.length > 0) {
        // Pick the one closest to target time
        const closest = daySnapshots.reduce((a, b) => 
          Math.abs(a.timestamp - targetTime) < Math.abs(b.timestamp - targetTime) ? a : b
        );
        const date = new Date(closest.timestamp);
        balanceHistory.push({
          date: date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
          eur: closest.balanceEUR?.toFixed(2) || 'N/A',
          btc: closest.balanceBTC?.toFixed(6) || 'N/A',
          btcPrice: closest.btcPrice?.toFixed(0) || 'N/A'
        });
      }
    }
  }
  
  // Calculate week-over-week changes
  let weekChangeEUR = null;
  let weekChangeBTC = null;
  if (balanceHistory.length >= 2) {
    const oldest = balanceHistory[0];
    const newest = balanceHistory[balanceHistory.length - 1];
    const oldEUR = parseFloat(oldest.eur);
    const newEUR = parseFloat(newest.eur);
    const oldBTC = parseFloat(oldest.btc);
    const newBTC = parseFloat(newest.btc);
    if (!isNaN(oldEUR) && !isNaN(newEUR) && oldEUR > 0) {
      weekChangeEUR = ((newEUR - oldEUR) / oldEUR * 100).toFixed(2);
    }
    if (!isNaN(oldBTC) && !isNaN(newBTC) && oldBTC > 0) {
      weekChangeBTC = ((newBTC - oldBTC) / oldBTC * 100).toFixed(2);
    }
  }
  
  return {
    // Portfolio breakdown
    totalPortfolio: totalPortfolio.toFixed(2),
    eurCash: eurCash.toFixed(2),
    investedValue: investedValue.toFixed(2),
    cashPct,
    unrealizedPnL: unrealizedPnL.toFixed(2),
    // Market data
    greedIndex: state.greedIndex,
    greedClass: state.greedClassification,
    btcPrice: state.ticker['XXBTZEUR']?.price?.toFixed(0) || 'N/A',
    ethPrice: state.ticker['XETHZEUR']?.price?.toFixed(0) || 'N/A',
    // Lists
    positions,
    holdings,
    movers,
    topByVolume,
    recentTrades,
    openOrders,
    previousDecisions,
    analytics,
    // Portfolio history
    balanceHistory,
    weekChangeEUR,
    weekChangeBTC
  };
}

async function runAnalysis(force = false) {
  // Check cooldown
  if (!force && state.llmAnalysis.lastUpdate) {
    const hours = (Date.now() - state.llmAnalysis.lastUpdate) / 3600000;
    if (hours < config.intervalHours) {
      return { skipped: true, reason: 'cooldown' };
    }
  }
  
  log('[AI] Running market analysis...');
  
  // Refresh data first
  await kraken.refreshAll();
  
  const ctx = buildContext();
  
  if (!ctx.totalPortfolio || !ctx.greedIndex) {
    return { skipped: true, reason: 'insufficient_data' };
  }
  
  const prompt = `You are an autonomous crypto trading bot. Response under 600 words.

OPERATIONAL CONSTRAINTS:
- I execute once per 30 minutes (unless manually triggered more often, and when i am restarted)
- I can ONLY place LIMIT orders (BUY at price, SELL at price)
- NO stop-losses, trailing stops, or market orders available
- I make trading decisions NOW, return next time to see results and act again
- Speak in first person ("I am buying...", "I will sell...") - I AM the trader, not an advisor
- Be confident but measured in tone - no hype, no aggression

GOAL: To the moon. 

STRATEGY:
- Be smart: whenever you see a position with a profit of >10% or >100EUR, realise it (by selling at the current bid price). This is crypto you never know when the tables turn on you.
- Be careful trading assets with very low (<1000 EUR) volume as they might be stale and not dynamic enough for a good return.

=== PORTFOLIO SUMMARY ===
Total Portfolio: ${ctx.totalPortfolio} EUR
EUR Cash Available: ${ctx.eurCash} EUR (${ctx.cashPct}% of portfolio)
Invested in Positions: ${ctx.investedValue} EUR
Unrealized P&L: ${ctx.unrealizedPnL} EUR
Weekly P&L: ${ctx.analytics.weeklyPnL?.toFixed(2) || 0} EUR
Weekly Win Rate: ${ctx.analytics.weeklyWinRate?.toFixed(0) || 0}%

=== PORTFOLIO VALUE HISTORY (7 days) ===
${ctx.balanceHistory.length > 0 ? ctx.balanceHistory.map(h => `${h.date}: ${h.eur} EUR (${h.btc} BTC @ ${h.btcPrice})`).join('\n') : 'No history available'}
${ctx.weekChangeEUR !== null ? `Week change: ${ctx.weekChangeEUR}% EUR | ${ctx.weekChangeBTC}% BTC-equivalent` : ''}

=== MARKET CONDITIONS ===
BTC: ${ctx.btcPrice} EUR | ETH: ${ctx.ethPrice} EUR
Fear/Greed Index: ${ctx.greedIndex}% (${ctx.greedClass})

=== ALL HOLDINGS (${ctx.holdings.length}) ===
${ctx.holdings.map(h => `${h.asset}: ${h.amount} = ${h.value} EUR (${h.pctOfPortfolio}% of portfolio)`).join('\n') || 'None'}

=== POSITIONS WITH FULL TICKER DATA (${ctx.positions.length}) ===
${ctx.positions.map(p => `${p.asset}: ${p.value} EUR | P&L: ${p.pnl} EUR (${p.pnlPct}) | Held ${p.days}d
  Entry: ${p.avgEntry} | Last: ${p.price} | Bid: ${p.bid} | Ask: ${p.ask} | Spread: ${p.spread}
  24h: ${p.low24}-${p.high24} (${p.distFromLow}% from low, ${p.dayMove}% range) | VWAP: ${p.vwap} | Vol: ${p.volume24} | Trades: ${p.trades24h}`).join('\n') || 'None'}

=== OPEN ORDERS (${ctx.openOrders.length}) ===
${ctx.openOrders.map(o => `[${o.id}] ${o.type?.toUpperCase()} ${o.asset}: ${o.volume} @ ${o.price} EUR (placed ${o.created})`).join('\n') || 'None'}

=== TOP 20 MOVERS (24h volatility) - Full Order Book Data ===
Note: Vol = total EUR value traded in 24h
${ctx.movers.slice(0, 20).map(m => {
  const p = m.price < 1 ? 6 : 2;
  return `${m.pair.replace(/Z?EUR$/, '')}: Last ${m.price?.toFixed(p)} | Bid: ${m.bid?.toFixed(p)} | Ask: ${m.ask?.toFixed(p)} | Spread: ${m.spreadPct?.toFixed(2)}%
  24h: ${m.low24?.toFixed(p)}-${m.high24?.toFixed(p)} (${m.dayMove}% range, ${m.distFromLow}% from low) | VWAP: ${m.vwap?.toFixed(p)} | Vol: ${m.volumeEur?.toFixed(0) || 'N/A'} EUR | Trades: ${m.trades24h}`;
}).join('\n')}

=== TOP 20 BY VOLUME (24h traded) - Full Order Book Data ===
${ctx.topByVolume.map(m => {
  const p = m.price < 1 ? 6 : 2;
  return `${m.pair.replace(/Z?EUR$/, '')}: Last ${m.price?.toFixed(p)} | Bid: ${m.bid?.toFixed(p)} | Ask: ${m.ask?.toFixed(p)} | Spread: ${m.spreadPct?.toFixed(2)}%
  24h: ${m.low24?.toFixed(p)}-${m.high24?.toFixed(p)} (${m.dayMove}% range, ${m.distFromLow}% from low) | VWAP: ${m.vwap?.toFixed(p)} | Vol: ${m.volumeEur?.toFixed(0) || 'N/A'} EUR | Trades: ${m.trades24h}`;
}).join('\n')}

=== TRADES LAST 7 DAYS (${ctx.recentTrades.length}) ===
${ctx.recentTrades.map(t => `[${t.time}] ${t.type.toUpperCase()} ${t.pair}: ${t.volume} @ ${t.price} = ${t.cost} EUR`).join('\n') || 'None'}

=== MY PREVIOUS ${ctx.previousDecisions.length} DECISIONS ===
${ctx.previousDecisions.map(d => `[${d.time}] ${d.sentiment}/${d.risk} | ${d.commands}${d.analysis ? ' | "' + d.analysis + '"' : ''}`).join('\n') || 'None'}

=== RESPONSE FORMAT ===
SENTIMENT: [bullish/neutral/bearish]
RISK: [low/medium/high]

ANALYSIS: [Your reasoning, 3-5 sentences. Reference specific data points. Try to not repeat the previous advice word-for-word, even if the conditions are similar explain how the situation relates to the last analysis instead of offering the same advice twice.]

COMMANDS:
[One command per line, or HOLD if no action]

=== COMMAND SYNTAX ===
BUY <ASSET> <eur_amount> <price> - e.g., "BUY ETH 50 3100" (buys 50 EUR worth at limit price)
SELL <ASSET> <price> - e.g., "SELL ETH 3200" (sells ALL holdings at limit price)
CANCEL BUY <ASSET> - e.g., "CANCEL BUY ETH" (cancels ALL buy orders for that asset)
HOLD - no action this time

=== ABOUT CANCELLING ORDERS ===
Issuing BUY/SELL commands will CANCEL all existing orders for that asset before placing the new order. This means there is no need to CANCEL orders before replacing them. You should only CANCEL BUY if you have a previous BUY order that you want to abandon. 
`;

  // Save prompt for debugging
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'llm_prompt_latest.txt'), prompt, 'utf8');
  } catch (e) {}
  
  try {
    const response = await callLLM(prompt);
    
    if (!response) {
      return { success: false, reason: 'empty_response' };
    }
    
    // Parse response
    const sentimentMatch = response.match(/SENTIMENT:\s*(bullish|neutral|bearish)/i);
    const riskMatch = response.match(/RISK:\s*(low|medium|high)/i);
    const analysisMatch = response.match(/ANALYSIS:\s*(.+?)(?=\n\s*COMMANDS:|\n\n|$)/is);
    const commandsMatch = response.match(/COMMANDS:\s*([\s\S]*?)(?=\n\n|$)/i);
    
    state.llmAnalysis = {
      lastUpdate: Date.now(),
      marketSentiment: sentimentMatch?.[1]?.toLowerCase() || null,
      riskAssessment: riskMatch?.[1]?.toLowerCase() || null,
      analysis: analysisMatch?.[1]?.trim() || null,
      commands: commandsMatch?.[1]?.trim() || 'HOLD',
      raw: response
    };
    
    saveLLMAnalysis();
    
    // Add to history
    state.llmHistory.unshift({ ...state.llmAnalysis, id: Date.now() });
    if (state.llmHistory.length > 100) {
      state.llmHistory = state.llmHistory.slice(0, 100);
    }
    saveLLMHistory();
    
    log(`[AI] Analysis: ${state.llmAnalysis.marketSentiment} sentiment, ${state.llmAnalysis.riskAssessment} risk`);
    
    // Execute commands
    if (config.enabled && state.llmAnalysis.commands !== 'HOLD') {
      const actions = parseCommands(state.llmAnalysis.raw);
      if (actions.length > 0) {
        const results = await executeCommands(actions);
        const success = results.filter(r => r.success).length;
        log(`[AI-EXEC] Executed ${success}/${results.length} trades`);
        
        // Refresh data after trades
        if (success > 0) {
          setTimeout(() => kraken.refreshAll(), 3000);
        }
        
        return { success: true, analysis: state.llmAnalysis, executions: results };
      }
    }
    
    return { success: true, analysis: state.llmAnalysis };
    
  } catch (e) {
    console.error('[AI] Analysis failed:', e.message);
    return { success: false, error: e.message };
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  init,
  runAnalysis,
  setEnabled: (enabled) => { config.enabled = enabled; },
  setInterval: (hours) => { config.intervalHours = hours; }
};
