// @ts-check
/**
 * AI/LLM Module
 * Handles market analysis and trade execution
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { state, log, saveLLMAnalysis, saveLLMHistory, saveAIExecutions, saveInsights, DATA_DIR } = require('./state');
const kraken = require('./kraken');
const { fetchAllNews, formatNewsForPrompt } = require('./news');

let config = {
  provider: 'openrouter',
  apiKey: null,
  model: 'x-ai/grok-3-mini-beta',
  ollamaHost: 'localhost',
  ollamaPort: 11434,
  enabled: true,
  intervalMinutes: 10
};

// ============================================
// INITIALIZATION
// ============================================

function init(options = {}) {
  if (typeof options === 'string') {
    config.apiKey = options;
    if (arguments[1]) config.model = arguments[1];
  } else {
    config.provider = options.provider || config.provider;
    config.apiKey = options.apiKey || null;
    config.model = options.model || config.model;
    config.ollamaHost = options.ollamaHost || config.ollamaHost;
    config.ollamaPort = options.ollamaPort || config.ollamaPort;
  }
  log(`[AI] Initialized with provider: ${config.provider}, model: ${config.model}`);
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
  if (config.provider === 'ollama') {
    return callOllama(prompt);
  }
  return callOpenRouter(prompt);
}

async function callOllama(prompt) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false
    });

    const req = http.request({
      hostname: config.ollamaHost,
      port: config.ollamaPort,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 120000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error));
          } else {
            resolve(sanitizeResponse(parsed.message?.content));
          }
        } catch (e) {
          reject(new Error('Failed to parse Ollama response: ' + e.message));
        }
      });
    });

    req.on('error', e => reject(new Error('Ollama connection failed: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(postData);
    req.end();
  });
}

async function callOpenRouter(prompt) {
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
        const orderAsset = cleanAssetName(orderPair?.replace(/Z?EUR$/, '') || '');
        const pairMatch = orderPair === pair || 
                          orderPair === pair.replace('ZEUR', 'EUR') ||
                          orderPair === pair.replace('EUR', 'ZEUR') ||
                          orderAsset === action.asset;
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
      
      state.aiExecutionHistory.executions.push({
        timestamp: Date.now(),
        action: action.action,
        asset: action.asset,
        price: action.price,
        result: result?.success ? 'success' : 'failed',
        error: result?.error || null
      });
      if (result?.success) {
        state.aiExecutionHistory.dailyCount++;
      }
      saveAIExecutions();
      
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

// Fetch global market data from CoinGecko (with simple debounce)
let lastGlobalMarketFetch = 0;
const GLOBAL_MARKET_CACHE_TTL = 30000; // 30 seconds

async function fetchGlobalMarketData() {
  const now = Date.now();
  if (state.globalMarket && (now - lastGlobalMarketFetch) < GLOBAL_MARKET_CACHE_TTL) {
    return state.globalMarket;
  }
  
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.coingecko.com',
      path: '/api/v3/global',
      method: 'GET',
      headers: {
        'User-Agent': 'KrakenBot/2.0 (trading bot)'
      }
    };
    
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.data) {
            state.globalMarket = {
              marketCap: json.data.total_market_cap?.usd,
              marketCapChange24h: json.data.market_cap_change_percentage_24h_usd,
              btcDominance: json.data.market_cap_percentage?.btc,
              ethDominance: json.data.market_cap_percentage?.eth,
              volume24h: json.data.total_volume?.usd,
              lastFetch: now
            };
            lastGlobalMarketFetch = now;
          }
          resolve(state.globalMarket);
        } catch (e) {
          resolve(state.globalMarket);
        }
      });
    }).on('error', () => resolve(state.globalMarket));
  });
}

// Compute per-asset performance from trade history
function computeAssetPerformance() {
  const assetStats = {};
  const now = Date.now();
  const thirtyDaysAgo = now / 1000 - (30 * 24 * 60 * 60);
  
  if (!state.fullTradeHistory?.trades) return assetStats;
  
  for (const [id, trade] of Object.entries(state.fullTradeHistory.trades)) {
    if (trade.time < thirtyDaysAgo) continue;
    
    const pair = trade.pair || '';
    const asset = pair.replace(/Z?EUR$/, '').replace(/^X+/, '');
    if (!asset || asset === 'EUR') continue;
    
    if (!assetStats[asset]) {
      assetStats[asset] = { trades: 0, wins: 0, losses: 0, totalPnL: 0, totalWin: 0, totalLoss: 0, bestWin: 0, worstLoss: 0 };
    }
    
    const pnl = parseFloat(trade.pnl || 0);
    assetStats[asset].trades++;
    
    if (pnl > 0) {
      assetStats[asset].wins++;
      assetStats[asset].totalWin += pnl;
      if (pnl > assetStats[asset].bestWin) assetStats[asset].bestWin = pnl;
    } else if (pnl < 0) {
      assetStats[asset].losses++;
      assetStats[asset].totalLoss += Math.abs(pnl);
      if (Math.abs(pnl) > assetStats[asset].worstLoss) assetStats[asset].worstLoss = Math.abs(pnl);
    }
  }
  
  // Compute derived stats
  for (const asset in assetStats) {
    const s = assetStats[asset];
    s.winRate = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : 0;
    s.avgWin = s.wins > 0 ? (s.totalWin / s.wins).toFixed(0) : 0;
    s.avgLoss = s.losses > 0 ? (s.totalLoss / s.losses).toFixed(0) : 0;
    s.totalPnL = s.totalWin - s.totalLoss;
  }
  
  return assetStats;
}

// Get session info
function getSessionInfo() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
  
  let session = 'Unknown';
  if (utcHour >= 0 && utcHour < 8) session = 'Asian';
  else if (utcHour >= 8 && utcHour < 16) session = 'European';
  else session = 'US';
  
  return {
    utcTime: now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
    session,
    isWeekend
  };
}

async function buildContext() {
  const enriched = kraken.getEnrichedPositions();
  const minValue = 1.0;
  
  // Get EUR cash balance (ZEUR is Kraken's EUR)
  const eurCash = state.wallet['ZEUR']?.amount || state.wallet['EUR']?.amount || 0;
  const totalPortfolio = state.tradeBalance;
  const investedValue = totalPortfolio - eurCash;
  
  // Fetch additional data in parallel
  const [globalMarket, news, sessionInfo, assetPerformance] = await Promise.all([
    fetchGlobalMarketData(),
    fetchAllNews(),
    Promise.resolve(getSessionInfo()),
    Promise.resolve(computeAssetPerformance())
  ]);
  
  // Store news in state for dashboard (memory only)
  if (news) {
    state.news = {
      crypto: news.crypto?.items || [],
      kraken: news.kraken?.items || [],
      world: news.world?.items || [],
      lastUpdate: Date.now()
    };
  }
  
  // Determine pairs for OHLC: positions + top 20 by volume
  const positionPairs = new Set();
  for (const asset in enriched) {
    const pair = kraken.findPairForAsset(asset);
    if (pair) positionPairs.add(pair);
  }
  
  const topByVolume = Object.entries(state.ticker)
    .map(([pair, t]) => ({ pair, ...t }))
    .sort((a, b) => (b.volumeEur || 0) - (a.volumeEur || 0))
    .slice(0, 20);
  
  for (const t of topByVolume) {
    positionPairs.add(t.pair);
  }
  
  // Fetch OHLC for all relevant pairs
  const ohlcData = await kraken.fetchOHLCForPairs([...positionPairs]);
  
  // Fetch depth for positions only
  const positionPairsArray = [...positionPairs].filter(p => {
    const asset = p.replace(/Z?EUR$/, '').replace(/^X+/, '');
    return enriched[asset] || enriched['X' + asset] || enriched['XX' + asset];
  });
  const depthData = await kraken.fetchDepthForPairs(
    Object.keys(enriched).map(a => kraken.findPairForAsset(a)).filter(Boolean)
  );
  
  // Build market breadth
  let assetsUp = 0;
  let assetsDown = 0;
  for (const [pair, t] of Object.entries(state.ticker)) {
    const change = ((t.price - t.open) / t.open) * 100;
    if (change > 0) assetsUp++;
    else if (change < 0) assetsDown++;
  }
  const marketBreadth = { up: assetsUp, down: assetsDown, total: assetsUp + assetsDown };
  
  // Build positions list with ticker data for each holding
  const positions = [];
  for (const asset in enriched) {
    const p = enriched[asset];
    if (p.currentValue >= minValue) {
      const pair = kraken.findPairForAsset(asset);
      const ticker = pair ? state.ticker[pair] : null;
      const ohlc = ohlcData[pair] || [];
      const depth = depthData[pair] || null;
      const perf = assetPerformance[cleanAssetName(asset)] || null;
      
      positions.push({
        asset: cleanAssetName(asset),
        amount: p.amount,
        value: p.currentValue.toFixed(2),
        pnl: p.unrealizedPnL.toFixed(2),
        pnlPct: p.unrealizedPct.toFixed(1) + '%',
        days: p.holdingDays,
        avgEntry: p.avgCost?.toFixed(6) || 'N/A',
        ticker: {
          price: ticker?.price,
          bid: ticker?.bid,
          ask: ticker?.ask,
          spreadPct: ticker?.spreadPct,
          low24: ticker?.low24,
          high24: ticker?.high24,
          distFromLow: ticker?.distFromLow,
          dayMove: ticker?.dayMove,
          volumeEur: ticker?.volumeEur,
          vwap: ticker?.vwap,
          trades24h: ticker?.trades24h
        },
        ohlc: ohlc.map(c => c.close.toFixed(c.close < 1 ? 6 : 2)),
        depth: depth ? {
          bidDepth5pct: depth.bidDepth5pct,
          askDepth5pct: depth.askDepth5pct,
          bidWalls: depth.bidWalls,
          askWalls: depth.askWalls,
          spread: depth.spread
        } : null,
        performance: perf
      });
    }
  }
  
  // Add EUR as a position entry
  if (eurCash >= 0.01) {
    positions.unshift({
      asset: 'EUR',
      amount: eurCash.toFixed(2),
      value: eurCash.toFixed(2),
      pnl: '0',
      pnlPct: '0%',
      days: 0,
      avgEntry: 'N/A',
      ticker: null,
      ohlc: [],
      depth: null,
      performance: null,
      isCash: true
    });
  }
  
  // Sort positions by value (EUR stays at top)
  positions.sort((a, b) => {
    if (a.isCash) return -1;
    if (b.isCash) return 1;
    return parseFloat(b.value) - parseFloat(a.value);
  });
  
  // Top movers
  const movers = Object.entries(state.ticker)
    .map(([pair, t]) => ({ pair, ...t }))
    .sort((a, b) => b.dayMove - a.dayMove)
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
  
  // Open orders
  const openOrders = Object.entries(state.orders).map(([id, o]) => ({
    id,
    type: o.descr?.type,
    pair: o.descr?.pair,
    asset: cleanAssetName(o.descr?.pair?.replace(/Z?EUR$/, '')) || 'UNKNOWN',
    price: o.descr?.price,
    volume: parseFloat(o.vol).toFixed(6),
    orderType: o.descr?.ordertype,
    status: o.status,
    created: new Date(o.opentm * 1000).toLocaleString()
  }));
  
  // Previous decisions - last 5 only
  const previousDecisions = state.llmHistory.slice(0, 5).map(h => ({
    time: new Date(h.lastUpdate).toLocaleString(),
    sentiment: h.marketSentiment,
    risk: h.riskAssessment,
    commands: h.commands || 'HOLD',
    analysis: h.analysis?.substring(0, 200) || '' 
  }));
  
  // Recent execution results
  const recentExecutions = state.aiExecutionHistory.executions.slice(-10).reverse();
  const seenKeys = new Set();
  const recentExecutionResults = [];
  for (const e of recentExecutions) {
    const key = `${e.action}-${e.asset}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      recentExecutionResults.push({
        action: `${e.action} ${e.asset}`,
        result: e.result,
        error: e.error,
        time: new Date(e.timestamp).toLocaleString()
      });
    }
  }
  recentExecutionResults.reverse();
  
  // Performance summary
  const analytics = state.tradeAnalytics.summary;
  
  // Calculate some additional useful metrics
  const unrealizedPnL = positions.reduce((sum, p) => sum + parseFloat(p.pnl), 0);
  const cashPct = totalPortfolio > 0 ? ((eurCash / totalPortfolio) * 100).toFixed(1) : '0';
  
  // Portfolio value history
  const balanceHistory = [];
  if (state.balanceHistory.length > 0) {
    const now = Date.now();
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
      const targetTime = now - (daysAgo * 24 * 60 * 60 * 1000);
      const dayStart = targetTime - (12 * 60 * 60 * 1000);
      const dayEnd = targetTime + (12 * 60 * 60 * 1000);
      
      const daySnapshots = state.balanceHistory.filter(s => s.timestamp >= dayStart && s.timestamp <= dayEnd);
      if (daySnapshots.length > 0) {
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
  
  // BTC and ETH OHLC for market overview
  const btcOHLC = ohlcData['XXBTZEUR'] || [];
  const ethOHLC = ohlcData['XETHZEUR'] || [];
  
  // Recent deposits/withdrawals
  const recentLedgers = state.ledgers.slice(0, 10);
  
  return {
    // Session
    sessionInfo,
    // Global market
    globalMarket,
    marketBreadth,
    // Market data
    greedIndex: state.greedIndex,
    greedClass: state.greedClassification,
    btcPrice: state.ticker['XXBTZEUR']?.price,
    ethPrice: state.ticker['XETHZEUR']?.price,
    btcOHLC,
    ethOHLC,
    btcDepth: depthData['XXBTZEUR'] || null,
    ethDepth: depthData['XETHZEUR'] || null,
    ohlcData,
    // News
    news,
    // Portfolio breakdown
    totalPortfolio: totalPortfolio.toFixed(2),
    eurCash: eurCash.toFixed(2),
    investedValue: investedValue.toFixed(2),
    cashPct,
    unrealizedPnL: unrealizedPnL.toFixed(2),
    // Positions with all data
    positions,
    // Market data
    movers,
    topByVolume,
    // Trade data
    recentTrades,
    recentLedgers,
    openOrders,
    previousDecisions,
    recentExecutionResults,
    analytics,
    assetPerformance,
    // Insights
    insights: state.insights.slice(0, 20),
    // Portfolio history
    balanceHistory,
    weekChangeEUR,
    weekChangeBTC
  };
}

async function runAnalysis(force = false) {
  // Check cooldown
  if (!force && state.llmAnalysis.lastUpdate) {
    const minutes = (Date.now() - state.llmAnalysis.lastUpdate) / 60000;
    if (minutes < config.intervalMinutes) {
      return { skipped: true, reason: 'cooldown' };
    }
  }
  
  log('[AI] Running market analysis...');
  
  // Refresh data first
  await kraken.refreshAll();
  
  const ctx = await buildContext();
  
  if (!ctx.totalPortfolio || !ctx.greedIndex) {
    return { skipped: true, reason: 'insufficient_data' };
  }
  
  // Format positions for prompt
  const formatPosition = (p) => {
    if (p.isCash) {
      return `${p.asset}: ${p.amount} EUR (${p.value} EUR total)`;
    }
    
    const t = p.ticker || {};
    const priceStr = t.price ? (t.price < 1 ? t.price.toFixed(6) : t.price.toFixed(2)) : 'N/A';
    const bidStr = t.bid ? (t.bid < 1 ? t.bid.toFixed(6) : t.bid.toFixed(2)) : 'N/A';
    const askStr = t.ask ? (t.ask < 1 ? t.ask.toFixed(6) : t.ask.toFixed(2)) : 'N/A';
    const lowStr = t.low24 ? (t.low24 < 1 ? t.low24.toFixed(6) : t.low24.toFixed(2)) : 'N/A';
    const highStr = t.high24 ? (t.high24 < 1 ? t.high24.toFixed(6) : t.high24.toFixed(2)) : 'N/A';
    const vwapStr = t.vwap ? (t.vwap < 1 ? t.vwap.toFixed(6) : t.vwap.toFixed(2)) : 'N/A';
    
    let lines = [`${p.asset}: ${p.amount} tokens = ${p.value} EUR`];
    lines.push(`  P&L: ${p.pnl} EUR (${p.pnlPct}) | Held ${p.days}d | Entry: ${p.avgEntry}`);
    lines.push(`  Price: ${priceStr} | Bid: ${bidStr} | Ask: ${askStr} | Spread: ${t.spreadPct?.toFixed(2) || 'N/A'}%`);
    lines.push(`  24h: ${lowStr}-${highStr} (${t.distFromLow || 0}% from low, ${t.dayMove || 0}% range) | VWAP: ${vwapStr} | Vol: ${t.volumeEur?.toFixed(0) || 'N/A'} EUR`);
    
    if (p.ohlc && p.ohlc.length > 0) {
      lines.push(`  7d close: ${p.ohlc.join(' -> ')}`);
    }
    
    if (p.depth) {
      const bidWalls = p.depth.bidWalls?.map(w => `${w.price.toFixed(t.price < 1 ? 6 : 2)} (${w.volume.toFixed(1)})`).join(', ') || 'none';
      const askWalls = p.depth.askWalls?.map(w => `${w.price.toFixed(t.price < 1 ? 6 : 2)} (${w.volume.toFixed(1)})`).join(', ') || 'none';
      lines.push(`  Depth: ${p.depth.bidDepth5pct?.toFixed(0) || 0} EUR bid / ${p.depth.askDepth5pct?.toFixed(0) || 0} EUR ask to 5%`);
      lines.push(`  Walls - Bid: ${bidWalls} | Ask: ${askWalls}`);
    }
    
    if (p.performance && p.performance.trades > 0) {
      lines.push(`  Your stats: ${p.performance.trades} trades, ${p.performance.winRate}% win, avg +${p.performance.avgWin}/-${p.performance.avgLoss} EUR`);
    }
    
    return lines.join('\n');
  };
  
  // Format BTC depth
  const btcDepthStr = ctx.btcDepth ? 
    `Depth: ${(ctx.btcDepth.bidDepth5pct / 1000000).toFixed(2)}M EUR bid / ${(ctx.btcDepth.askDepth5pct / 1000000).toFixed(2)}M EUR ask to 5%` : '';
  
  const prompt = `=== TIME ===
${ctx.sessionInfo.utcTime}
Session: ${ctx.sessionInfo.session}${ctx.sessionInfo.isWeekend ? ' (Weekend)' : ''}

=== GLOBAL MARKET ===
Market Cap: ${ctx.globalMarket?.marketCap ? `$${(ctx.globalMarket.marketCap / 1e12).toFixed(2)}T` : 'N/A'} (${ctx.globalMarket?.marketCapChange24h?.toFixed(1) || 0}% 24h)
BTC Dominance: ${ctx.globalMarket?.btcDominance?.toFixed(1) || 'N/A'}% | ETH Dominance: ${ctx.globalMarket?.ethDominance?.toFixed(1) || 'N/A'}%
24h Volume: ${ctx.globalMarket?.volume24h ? `$${(ctx.globalMarket.volume24h / 1e9).toFixed(1)}B` : 'N/A'}
Fear/Greed: ${ctx.greedIndex}% (${ctx.greedClass})
Market Breadth: ${ctx.marketBreadth.up} up / ${ctx.marketBreadth.down} down (${ctx.marketBreadth.total} total)

=== BTC ===
Price: ${ctx.btcPrice ? ctx.btcPrice.toFixed(0) + ' EUR' : 'N/A'}
24h Change: ${state.ticker['XXBTZEUR']?.dayMove || 0}% | Range: ${state.ticker['XXBTZEUR']?.low24?.toFixed(0) || 'N/A'}-${state.ticker['XXBTZEUR']?.high24?.toFixed(0) || 'N/A'} EUR
${ctx.btcOHLC?.length > 0 ? `7d close: ${ctx.btcOHLC.map(c => c.close.toFixed(0)).join(' -> ')}` : ''}
${btcDepthStr}

=== ETH ===
Price: ${ctx.ethPrice ? ctx.ethPrice.toFixed(0) + ' EUR' : 'N/A'}
24h Change: ${state.ticker['XETHZEUR']?.dayMove || 0}% | Range: ${state.ticker['XETHZEUR']?.low24?.toFixed(0) || 'N/A'}-${state.ticker['XETHZEUR']?.high24?.toFixed(0) || 'N/A'} EUR
${ctx.ethOHLC?.length > 0 ? `7d close: ${ctx.ethOHLC.map(c => c.close.toFixed(0)).join(' -> ')}` : ''}

=== NEWS ===
[WORLD]
${ctx.news.world?.items?.slice(0, 5).map(item => `  ${item.title}${item.age ? ` (${item.age})` : ''}`).join('\n') || '  No recent world news'}
[CRYPTO]
${ctx.news.crypto?.items?.slice(0, 5).map(item => `  ${item.title}${item.age ? ` (${item.age})` : ''}`).join('\n') || '  No recent crypto news'}
[KRAKEN]
${ctx.news.kraken?.items?.slice(0, 5).map(item => `  ${item.title}${item.age ? ` (${item.age})` : ''}`).join('\n') || '  No recent Kraken updates'}

=== PORTFOLIO ===
Total: ${ctx.totalPortfolio} EUR | Cash: ${ctx.eurCash} EUR (${ctx.cashPct}%) | Invested: ${ctx.investedValue} EUR
Unrealized P&L: ${ctx.unrealizedPnL} EUR
7d Change: ${ctx.weekChangeEUR || 'N/A'}% EUR | ${ctx.weekChangeBTC || 'N/A'}% BTC-adjusted
${ctx.balanceHistory.length > 0 ? `History: ${ctx.balanceHistory.map(h => h.eur).join(' -> ')} EUR` : 'No history'}

=== POSITIONS (${ctx.positions.length}) ===
${ctx.positions.map(formatPosition).join('\n\n') || 'None'}

=== YOUR PERFORMANCE (30d) ===
${ctx.analytics.totalTrades || 0} trades | ${ctx.analytics.winRate?.toFixed(0) || 0}% win rate | Realized: ${ctx.analytics.realizedPnL?.toFixed(2) || 0} EUR
By asset: ${Object.entries(ctx.assetPerformance).slice(0, 10).map(([a, s]) => `${a} ${s.winRate}% win (${s.trades}t)`).join(', ') || 'No trades'}

=== OPEN ORDERS (${ctx.openOrders.length}) ===
${ctx.openOrders.map(o => `[${o.id}] ${o.type?.toUpperCase()} ${o.asset}: ${o.volume} @ ${o.price} EUR (placed ${o.created})`).join('\n') || 'None'}

=== TOP 20 BY VOLUME ===
${ctx.topByVolume.slice(0, 20).map(m => {
  const p = m.price < 1 ? 6 : 2;
  const ohlc = ctx.ohlcData && ctx.ohlcData[m.pair] ? ctx.ohlcData[m.pair].map(c => c.close.toFixed(p)).join('->').substring(0, 50) : '';
  return `${m.pair.replace(/Z?EUR$/, '')}: ${m.price?.toFixed(p)} | 24h: ${m.low24?.toFixed(p)}-${m.high24?.toFixed(p)} (${m.dayMove}%) | Vol: ${m.volumeEur?.toFixed(0) || 0} EUR${ohlc ? ` | 7d: ${ohlc}` : ''}`;
}).join('\n')}

=== TOP 10 MOVERS (24h) ===
${ctx.movers.slice(0, 10).map(m => {
  const p = m.price < 1 ? 6 : 2;
  return `${m.pair.replace(/Z?EUR$/, '')}: ${m.price?.toFixed(p)} (${m.dayMove > 0 ? '+' : ''}${m.dayMove}%) | Vol: ${m.volumeEur?.toFixed(0) || 0} EUR`;
}).join('\n')}

=== RECENT TRADES (7d) ===
${ctx.recentTrades.slice(0, 10).map(t => `[${t.time}] ${t.type.toUpperCase()} ${t.pair}: ${t.volume} @ ${t.price} = ${t.cost} EUR`).join('\n') || 'None'}

${ctx.recentLedgers && ctx.recentLedgers.length > 0 ? `=== DEPOSITS/WITHDRAWALS (7d) ===
${ctx.recentLedgers.map(l => `[${l.timestamp}] ${l.type.toUpperCase()}: ${l.amount.toFixed(l.asset === 'ZEUR' ? 2 : 6)} ${l.asset.replace('Z', '')}${l.fee > 0 ? ` (fee: ${l.fee})` : ''}`).join('\n')}` : ''}

=== PREVIOUS DECISIONS ===
${ctx.previousDecisions.map(d => `[${d.time}] ${d.sentiment}/${d.risk} | ${d.commands}`).join('\n') || 'None'}

=== EXECUTION RESULTS ===
${ctx.recentExecutionResults.map(e => `[${e.time}] ${e.action} -> ${e.result}${e.error ? ` (${e.error})` : ''}`).join('\n') || 'None'}

=== RESPONSE FORMAT ===
SENTIMENT: [bullish/neutral/bearish]
RISK: [low/medium/high]

ANALYSIS: [Your reasoning. Reference specific data.]

INSIGHT: [Optional: One pattern about YOUR trading behavior or portfolio (NOT market observations). Examples: "I tend to sell winners too early", "Low-volume assets have poor fills for me", "My ETH trades outperform my memecoin trades". Skip if nothing meaningful to add.]
${ctx.insights && ctx.insights.length > 0 ? `
EXISTING INSIGHTS (do not duplicate these):
${ctx.insights.slice(0, 15).map(i => `• ${i.insight}`).join('\n')}` : ''}

COMMANDS:
[One command per line, or HOLD]

=== COMMAND SYNTAX ===
BUY <ASSET> <eur_amount> <price> - e.g., "BUY ETH 50 3100"
SELL <ASSET> <price> - e.g., "SELL ETH 3200" (sells ALL holdings)
CANCEL BUY <ASSET> - e.g., "CANCEL BUY ETH"
HOLD - no action this time

Note: BUY/SELL cancels existing orders for that asset first.
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
    const analysisMatch = response.match(/ANALYSIS:\s*(.+?)(?=\n\s*(COMMANDS|INSIGHT):|\n\n|$)/is);
    const insightMatch = response.match(/INSIGHT:\s*(.+?)(?=\n\s*COMMANDS:|\n\n|$)/is);
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
    
    // Store insight if provided
    if (insightMatch && insightMatch[1]) {
      const insightText = insightMatch[1].trim();
      if (insightText && insightText.length > 10) {
        state.insights.unshift({
          insight: insightText.substring(0, 200),
          time: Date.now(),
          sentiment: state.llmAnalysis.marketSentiment
        });
        // Keep only last 50 insights
        if (state.insights.length > 50) {
          state.insights = state.insights.slice(0, 50);
        }
        saveInsights();
        log(`[AI] New insight stored: ${insightText.substring(0, 50)}...`);
      }
    }
    
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
// INIT CONTEXT (fetch on startup)
// ============================================

async function initContext() {
  log('[AI] Fetching initial context (global market, news)...');
  try {
    await Promise.all([
      fetchGlobalMarketData(),
      fetchAllNews()
    ]);
    log('[AI] Initial context loaded');
  } catch (e) {
    console.error('[AI] Failed to load initial context:', e.message);
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  init,
  runAnalysis,
  initContext,
  setEnabled: (enabled) => { config.enabled = enabled; },
  setInterval: (minutes) => { config.intervalMinutes = minutes; }
};
