// @ts-check
/**
 * Kraken API Module
 * Handles all Kraken exchange interactions
 */

const KrakenClient = require('kraken-api');
const { state, log, saveTradeHistory, saveCostBasis, saveAnalytics } = require('./state');

let kraken = null;

// ============================================
// RATE LIMITING
// ============================================
// Kraken rate limits: counter starts at 0, increases per call, decreases ~0.33/sec
// TradesHistory, Ledgers, ClosedOrders: +2 per call
// Most other private endpoints: +1 per call
// Trading endpoints (AddOrder, CancelOrder): +0
// Max counter: 15 for starter tier, 20 for intermediate

const rateLimit = {
  counter: 0,
  maxCounter: 15,
  lastDecay: Date.now(),
  decayRate: 0.33, // counter decreases by ~1 every 3 seconds
};

// Decay the counter based on time elapsed
function decayCounter() {
  const now = Date.now();
  const elapsed = (now - rateLimit.lastDecay) / 1000;
  const decay = elapsed * rateLimit.decayRate;
  rateLimit.counter = Math.max(0, rateLimit.counter - decay);
  rateLimit.lastDecay = now;
}

// Wait if we would exceed rate limit, then increment counter
async function waitForRateLimit(cost) {
  decayCounter();
  
  while (rateLimit.counter + cost > rateLimit.maxCounter) {
    const waitTime = Math.ceil((rateLimit.counter + cost - rateLimit.maxCounter) / rateLimit.decayRate) * 1000 + 500;
    log(`[RATE LIMIT] Counter at ${rateLimit.counter.toFixed(1)}, waiting ${waitTime}ms before +${cost} call`);
    await new Promise(r => setTimeout(r, waitTime));
    decayCounter();
  }
  
  rateLimit.counter += cost;
}

// ============================================
// INITIALIZATION
// ============================================

function init(apiKey, apiSecret) {
  kraken = new KrakenClient(apiKey, apiSecret);
  log('[KRAKEN] API initialized');
}

// ============================================
// ASSET PAIR HELPERS
// ============================================

function findPairForAsset(assetName) {
  if (!state.pairs || !assetName) return null;
  const normalized = assetName.toUpperCase().trim();
  
  // Check precomputed map first
  if (state.assetToPairMap[normalized]) {
    return state.assetToPairMap[normalized];
  }
  
  // Try common variations
  const variations = [
    normalized + 'EUR',
    normalized + 'ZEUR', 
    'X' + normalized + 'ZEUR',
    'XX' + normalized.slice(1) + 'ZEUR'
  ];
  
  for (const v of variations) {
    if (state.pairs[v]) return v;
  }
  
  // Search by base asset
  for (const pair in state.pairs) {
    const base = state.pairs[pair].base;
    if (base === normalized || base === 'X' + normalized || base === 'XX' + normalized.slice(1)) {
      if (pair.endsWith('EUR') || pair.endsWith('ZEUR')) {
        return pair;
      }
    }
  }
  
  return null;
}

function getAssetFromPair(pair) {
  if (state.pairs?.[pair]?.base) return state.pairs[pair].base;
  return pair.replace(/Z?EUR$/, '').replace(/\.S$/, '');
}

// ============================================
// DATA FETCHING
// ============================================

async function fetchPairs() {
  return new Promise((resolve, reject) => {
    kraken.api('AssetPairs', null, (error, data) => {
      if (error) return reject(error);
      
      state.pairs = {};
      state.assetToPairMap = {};
      
      for (const pair in data.result) {
        const info = data.result[pair];
        // Only EUR pairs, skip margin
        if ((pair.endsWith('EUR') || pair.endsWith('ZEUR')) && !pair.includes('.')) {
          state.pairs[pair] = info;
          
          // Build asset-to-pair map - map multiple variations to the pair
          const base = info.base;
          state.assetToPairMap[base] = pair;
          
          // Also map without X prefix for legacy Kraken assets (XXBT -> XBT, XETH -> ETH)
          // But only for short assets where X is clearly a prefix
          if (base.startsWith('X') && base.length <= 5) {
            state.assetToPairMap[base.slice(1)] = pair;
          }
          if (base.startsWith('XX') && base.length <= 6) {
            state.assetToPairMap[base.slice(1)] = pair;
            state.assetToPairMap[base.slice(2)] = pair;
          }
        }
      }
      
      log(`[KRAKEN] Loaded ${Object.keys(state.pairs).length} EUR pairs`);
      resolve(state.pairs);
    });
  });
}

async function fetchTicker() {
  if (!state.pairs || Object.keys(state.pairs).length === 0) return;
  
  const pairList = Object.keys(state.pairs).join(',');
  
  return new Promise((resolve) => {
    kraken.api('Ticker', { pair: pairList }, (error, data) => {
      if (error) {
        console.error('[KRAKEN] Ticker error:', error.message);
        return resolve(null);
      }
      
      for (const pair in data.result) {
        const t = data.result[pair];
        const price = parseFloat(t.c[0]);
        const low24 = parseFloat(t.l[1]);
        const high24 = parseFloat(t.h[1]);
        const range = high24 - low24;
        const distFromLow = range > 0 ? Math.round(((price - low24) / range) * 100) : 0;
        const dayMove = low24 > 0 ? Math.round((range / low24) * 100) : 0;
        
        // Parse bid/ask data
        const askPrice = parseFloat(t.a[0]);
        const askVolume = parseFloat(t.a[2]); // lot volume
        const bidPrice = parseFloat(t.b[0]);
        const bidVolume = parseFloat(t.b[2]); // lot volume
        const spread = askPrice - bidPrice;
        const spreadPct = bidPrice > 0 ? ((spread / bidPrice) * 100) : 0;
        
        state.ticker[pair] = {
          // Last trade price
          price,
          lastVolume: parseFloat(t.c[1]),
          // Bid/Ask (order book top)
          ask: askPrice,
          askVolume,
          bid: bidPrice,
          bidVolume,
          spread,
          spreadPct,
          // 24h stats
          low24,
          high24,
          lowToday: parseFloat(t.l[0]),
          highToday: parseFloat(t.h[0]),
          distFromLow,
          dayMove,
          // Volume (base asset)
          volume: parseFloat(t.v[1]),
          volumeToday: parseFloat(t.v[0]),
          // Volume in EUR (base volume * vwap for accuracy)
          volumeEur: parseFloat(t.v[1]) * parseFloat(t.p[1]),
          volumeEurToday: parseFloat(t.v[0]) * parseFloat(t.p[0]),
          // VWAP (volume weighted average price)
          vwap: parseFloat(t.p[1]),
          vwapToday: parseFloat(t.p[0]),
          // Trade counts
          trades24h: t.t[1],
          tradesToday: t.t[0],
          // Opening price
          open: parseFloat(t.o),
          // Computed
          display: `${price.toFixed(price < 1 ? 6 : 2)} (${distFromLow}%/${dayMove}%)`
        };
      }
      
      resolve(state.ticker);
    });
  });
}

async function fetchBalance() {
  await waitForRateLimit(1);
  return new Promise((resolve) => {
    kraken.api('Balance', null, (error, data) => {
      if (error) {
        console.error('[KRAKEN] Balance error:', error.message);
        return resolve(null);
      }
      
      state.wallet = {};
      state.tradeBalance = 0;
      
      for (const asset in data.result) {
        const amount = parseFloat(data.result[asset]);
        if (amount > 0) {
          state.wallet[asset] = { asset, amount, value: 0 };
          
          if (asset === 'ZEUR' || asset === 'EUR') {
            state.wallet[asset].value = amount;
            state.tradeBalance += amount;
          }
        }
      }
      
      // Calculate values for non-EUR assets
      for (const asset in state.wallet) {
        if (asset !== 'ZEUR' && asset !== 'EUR') {
          const pair = findPairForAsset(asset);
          if (pair && state.ticker[pair]) {
            const value = state.wallet[asset].amount * state.ticker[pair].price;
            state.wallet[asset].value = value;
            state.tradeBalance += value;
          }
        }
      }
      
      resolve(state.wallet);
    });
  });
}

async function fetchOrders() {
  await waitForRateLimit(1);
  return new Promise((resolve) => {
    kraken.api('OpenOrders', null, (error, data) => {
      if (error) {
        console.error('[KRAKEN] Orders error:', error.message);
        return resolve(null);
      }
      
      state.orders = data.result?.open || {};
      resolve(state.orders);
    });
  });
}

// Populate state.trades from cached fullTradeHistory (no API call)
function updateRecentTrades(count = 200) {
  state.trades = Object.entries(state.fullTradeHistory.trades)
    .map(([id, t]) => ({ id, ...t }))
    .sort((a, b) => b.time - a.time)
    .slice(0, count);
  return state.trades;
}

async function fetchAllTradeHistory() {
  const existingCount = Object.keys(state.fullTradeHistory.trades).length;
  
  if (existingCount > 0) {
    // We have cached trades - just fetch new ones
    log(`[KRAKEN] Have ${existingCount} cached trades, fetching new ones...`);
    return fetchNewTrades();
  }
  
  // No cached trades - need full fetch
  log('[KRAKEN] No cached trades, fetching full history...');
  return fetchFullTradeHistory();
}

// Fetch only new trades (stops when hitting known trades)
async function fetchNewTrades() {
  let offset = 0;
  let newTradesCount = 0;
  let hitExisting = false;
  
  while (!hitExisting) {
    await waitForRateLimit(2); // TradesHistory costs +2
    
    const result = await new Promise((resolve) => {
      kraken.api('TradesHistory', { ofs: offset, trades: true }, (error, data) => {
        if (error) {
          console.error('[KRAKEN] Trade history error:', error.message);
          return resolve({ error: true });
        }
        resolve({ trades: data.result?.trades || {} });
      });
    });
    
    if (result.error) break;
    
    const trades = result.trades;
    const count = Object.keys(trades).length;
    
    if (count === 0) break;
    
    // Check each trade - if we already have it, we've caught up
    let newInPage = 0;
    for (const [id, trade] of Object.entries(trades)) {
      if (state.fullTradeHistory.trades[id]) {
        hitExisting = true;
      } else {
        state.fullTradeHistory.trades[id] = trade;
        newInPage++;
        newTradesCount++;
      }
    }
    
    // If all trades in page were existing, we're done
    if (newInPage === 0) break;
    
    // If we got less than 50, no more pages
    if (count < 50) break;
    
    offset += 50;
  }
  
  if (newTradesCount > 0) {
    state.fullTradeHistory.totalCount = Object.keys(state.fullTradeHistory.trades).length;
    state.fullTradeHistory.lastFetchTime = Date.now();
    saveTradeHistory();
    log(`[KRAKEN] Found ${newTradesCount} new trades (total: ${state.fullTradeHistory.totalCount})`);
  }
  
  // Always rebuild cost basis (weekly stats are time-dependent)
  buildCostBasis();
  
  // Always update state.trades from cache
  updateRecentTrades();
  
  return state.fullTradeHistory;
}

// Full trade history fetch (only used when no cache exists)
async function fetchFullTradeHistory() {
  let offset = 0;
  let hasMore = true;
  
  while (hasMore) {
    await waitForRateLimit(2); // TradesHistory costs +2
    
    const result = await new Promise((resolve) => {
      kraken.api('TradesHistory', { ofs: offset, trades: true }, (error, data) => {
        if (error) {
          console.error('[KRAKEN] Trade history error:', error.message);
          return resolve({ error: true });
        }
        resolve({ trades: data.result?.trades || {} });
      });
    });
    
    if (result.error) break;
    
    const trades = result.trades;
    const count = Object.keys(trades).length;
    
    for (const [id, trade] of Object.entries(trades)) {
      state.fullTradeHistory.trades[id] = trade;
    }
    
    log(`[KRAKEN] Fetched ${count} trades (offset ${offset})`);
    
    hasMore = count === 50;
    offset += 50;
  }
  
  state.fullTradeHistory.totalCount = Object.keys(state.fullTradeHistory.trades).length;
  state.fullTradeHistory.lastFetchTime = Date.now();
  saveTradeHistory();
  log(`[KRAKEN] Loaded ${state.fullTradeHistory.totalCount} total trades`);
  buildCostBasis();
  updateRecentTrades();
  
  return state.fullTradeHistory;
}

// ============================================
// COST BASIS & ANALYTICS
// ============================================

function buildCostBasis() {
  const trades = Object.values(state.fullTradeHistory.trades)
    .sort((a, b) => a.time - b.time);
  
  state.costBasis = {};
  
  for (const trade of trades) {
    const asset = getAssetFromPair(trade.pair);
    const amount = parseFloat(trade.vol);
    const price = parseFloat(trade.price);
    const cost = parseFloat(trade.cost);
    
    if (!state.costBasis[asset]) {
      state.costBasis[asset] = {
        lots: [],
        totalInvested: 0,
        totalReturned: 0,
        realizedPnL: 0,
        completedTrades: []
      };
    }
    
    const cb = state.costBasis[asset];
    
    if (trade.type === 'buy') {
      cb.lots.push({ price, amount, remaining: amount, time: trade.time });
      cb.totalInvested += cost;
    } else if (trade.type === 'sell') {
      let remaining = amount;
      let costBasisUsed = 0;
      let amountMatched = 0;
      
      // FIFO matching
      while (remaining > 0 && cb.lots.length > 0) {
        const lot = cb.lots[0];
        const used = Math.min(remaining, lot.remaining);
        costBasisUsed += used * lot.price;
        amountMatched += used;
        lot.remaining -= used;
        remaining -= used;
        
        if (lot.remaining <= 0) {
          cb.lots.shift();
        }
      }
      
      // Only calculate P&L for the portion that had matching cost basis
      // This prevents inflated P&L from staking rewards/airdrops with no buy lots
      const matchedSaleValue = amountMatched > 0 ? (amountMatched / amount) * cost : 0;
      const pnl = matchedSaleValue - costBasisUsed;
      
      // Only record P&L if we actually matched some cost basis
      if (amountMatched > 0) {
        cb.realizedPnL += pnl;
      }
      cb.totalReturned += cost;
      
      cb.completedTrades.push({
        sellTime: trade.time,
        sellPrice: price,
        amount,
        amountMatched,  // Track how much was matched for transparency
        pnl: amountMatched > 0 ? pnl : 0,
        pnlPercent: costBasisUsed > 0 ? (pnl / costBasisUsed) * 100 : 0
      });
    }
  }
  
  // Build analytics summary
  let totalPnL = 0;
  let weeklyPnL = 0;
  let wins = 0;
  let losses = 0;
  let weeklyWins = 0;
  let weeklyLosses = 0;
  const recentActivity = [];
  
  // Calculate timestamp for 7 days ago (in seconds, matching sellTime format)
  const oneWeekAgo = (Date.now() - (7 * 24 * 60 * 60 * 1000)) / 1000;
  
  for (const asset in state.costBasis) {
    const cb = state.costBasis[asset];
    totalPnL += cb.realizedPnL;
    
    for (const t of cb.completedTrades) {
      if (t.pnl >= 0) wins++;
      else losses++;
      
      // Track weekly stats
      if (t.sellTime >= oneWeekAgo) {
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
  
  // Slice to 50 most recent trades first, then calculate P&L from those
  const displayedTrades = recentActivity.slice(0, 50);
  
  // Calculate P&L and win rate from the displayed trades only
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
  
  saveCostBasis();
  saveAnalytics();
}

function getEnrichedPositions() {
  const positions = {};
  
  // Use actual wallet balance as source of truth for positions
  for (const asset in state.wallet) {
    // Skip EUR/fiat
    if (asset === 'ZEUR' || asset === 'EUR' || asset === 'ZUSD' || asset === 'USD') continue;
    
    const walletEntry = state.wallet[asset];
    const amount = walletEntry.amount;
    
    // Skip dust amounts (less than €0.01 value)
    if (amount <= 0 || walletEntry.value < 0.01) continue;
    
    const pair = findPairForAsset(asset);
    const currentPrice = pair && state.ticker[pair] ? state.ticker[pair].price : 0;
    const currentValue = amount * currentPrice;
    
    // Skip if no price data available or value too small
    if (currentValue < 1) continue; // Hide small positions (< 1 EUR)
    
    // Try to get cost basis info if available
    const cb = state.costBasis[asset];
    let avgCost = currentPrice; // Default to current price if no cost basis
    let costBasis = currentValue;
    let oldestTime = Date.now();
    
    if (cb && cb.lots && cb.lots.length > 0) {
      let totalCost = 0;
      let totalAmount = 0;
      
      for (const lot of cb.lots) {
        if (lot.remaining > 0) {
          totalAmount += lot.remaining;
          totalCost += lot.remaining * lot.price;
          // Handle both ms and seconds timestamps
          const lotTime = lot.time > 1e12 ? lot.time : lot.time * 1000;
          oldestTime = Math.min(oldestTime, lotTime);
        }
      }
      
      if (totalAmount > 0) {
        avgCost = totalCost / totalAmount;
        costBasis = totalCost;
      }
    }
    
    const unrealizedPnL = currentValue - costBasis;
    const holdingDays = Math.floor((Date.now() - oldestTime) / (86400 * 1000));
    
    positions[asset] = {
      amount,
      avgCost,
      costBasis,
      currentPrice,
      currentValue,
      unrealizedPnL,
      unrealizedPct: costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0,
      holdingDays: holdingDays >= 0 ? holdingDays : 0
    };
  }
  
  return positions;
}

// ============================================
// ORDER EXECUTION
// ============================================

async function limitBuy(pair, amountEUR, price) {
  const pairInfo = state.pairs[pair];
  if (!pairInfo) throw new Error(`Unknown pair: ${pair}`);
  
  const pairDecimals = pairInfo.pair_decimals || 2;
  const lotDecimals = pairInfo.lot_decimals || 8;
  const formattedPrice = Number(price.toFixed(pairDecimals));
  
  let volume = amountEUR / formattedPrice;
  volume = Number(volume.toFixed(lotDecimals));
  
  if (pairInfo.ordermin) {
    volume = Math.max(volume, parseFloat(pairInfo.ordermin));
  }
  
  log(`[ORDER] Limit BUY: ${volume} ${pair} @ ${formattedPrice} EUR`);
  
  return new Promise((resolve) => {
    kraken.api('AddOrder', {
      pair,
      type: 'buy',
      ordertype: 'limit',
      volume,
      price: formattedPrice
    }, (error, data) => {
      if (error) {
        console.error('[ORDER] Buy failed:', error.message);
        resolve({ success: false, error: error.message });
      } else {
        log(`[ORDER] Buy success: ${data.result?.descr?.order}`);
        resolve({ success: true, order: data.result });
      }
    });
  });
}

async function limitSell(pair, volume, price) {
  const pairInfo = state.pairs[pair];
  if (!pairInfo) throw new Error(`Unknown pair: ${pair}`);
  
  const pairDecimals = pairInfo.pair_decimals || 2;
  const lotDecimals = pairInfo.lot_decimals || 8;
  const formattedPrice = Number(price.toFixed(pairDecimals));
  const formattedVolume = Number(volume.toFixed(lotDecimals));
  
  log(`[ORDER] Limit SELL: ${formattedVolume} ${pair} @ ${formattedPrice} EUR`);
  
  return new Promise((resolve) => {
    kraken.api('AddOrder', {
      pair,
      type: 'sell',
      ordertype: 'limit',
      volume: formattedVolume,
      price: formattedPrice
    }, (error, data) => {
      if (error) {
        console.error('[ORDER] Sell failed:', error.message);
        resolve({ success: false, error: error.message });
      } else {
        log(`[ORDER] Sell success: ${data.result?.descr?.order}`);
        resolve({ success: true, order: data.result });
      }
    });
  });
}

async function cancelOrder(orderId) {
  return new Promise((resolve) => {
    kraken.api('CancelOrder', { txid: orderId }, (error, data) => {
      if (error) {
        resolve({ success: false, error: error.message });
      } else {
        resolve({ success: true });
      }
    });
  });
}

// ============================================
// GREED INDEX
// ============================================

async function fetchGreedIndex() {
  const https = require('https');
  
  return new Promise((resolve) => {
    https.get('https://api.alternative.me/fng/?limit=1', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          state.greedIndex = parseInt(json.data[0].value);
          state.greedClassification = json.data[0].value_classification;
          resolve(state.greedIndex);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// ============================================
// REFRESH ALL
// ============================================

async function refreshAll() {
  // Public endpoints (no rate limit impact)
  await fetchTicker();
  await fetchGreedIndex();
  
  // Private endpoints (rate limited)
  await fetchBalance();    // +1
  await fetchOrders();     // +1
  await fetchNewTrades();  // +2 (only fetches new trades, stops at known ones)
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  init,
  
  // Data fetching
  fetchPairs,
  fetchTicker,
  fetchBalance,
  fetchOrders,
  fetchAllTradeHistory,
  fetchNewTrades,
  fetchGreedIndex,
  refreshAll,
  
  // Helpers
  findPairForAsset,
  getEnrichedPositions,
  
  // Orders
  limitBuy,
  limitSell,
  cancelOrder
};
