// @ts-check
/**
 * Trade History
 */

const { state, log, saveTradeHistory } = require('../state');
const { waitForRateLimit } = require('./api');
const { getAssetFromPair, buildCostBasis } = require('./balance');

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
    log(`[KRAKEN] Have ${existingCount} cached trades, fetching new ones...`);
    return fetchNewTrades();
  }
  
  log('[KRAKEN] No cached trades, fetching full history...');
  return fetchFullTradeHistory();
}

async function fetchNewTrades() {
  let offset = 0;
  let newTradesCount = 0;
  let hitExisting = false;
  
  while (!hitExisting) {
    await waitForRateLimit(2);
    
    const result = await new Promise((resolve) => {
      const { getClient } = require('./api');
      getClient().api('TradesHistory', { ofs: offset, trades: true }, (error, data) => {
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
    
    if (newInPage === 0) break;
    if (count < 50) break;
    
    offset += 50;
  }
  
  if (newTradesCount > 0) {
    state.fullTradeHistory.totalCount = Object.keys(state.fullTradeHistory.trades).length;
    state.fullTradeHistory.lastFetchTime = Date.now();
    saveTradeHistory();
    log(`[KRAKEN] Found ${newTradesCount} new trades (total: ${state.fullTradeHistory.totalCount})`);
  }
  
  buildCostBasis();
  updateRecentTrades();
  
  return state.fullTradeHistory;
}

async function fetchFullTradeHistory() {
  let offset = 0;
  let hasMore = true;
  
  while (hasMore) {
    await waitForRateLimit(2);
    
    const result = await new Promise((resolve) => {
      const { getClient } = require('./api');
      getClient().api('TradesHistory', { ofs: offset, trades: true }, (error, data) => {
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

module.exports = {
  updateRecentTrades,
  fetchAllTradeHistory,
  fetchNewTrades,
  fetchFullTradeHistory
};