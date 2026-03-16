// @ts-check
/**
 * Kraken Module Index
 * Re-exports all Kraken functions
 */

const api = require('./api');
const pairs = require('./pairs');
const market = require('./market');
const balance = require('./balance');
const history = require('./history');
const orders = require('./orders');

const { state } = require('../state');

async function refreshAll() {
  await market.fetchTicker();
  await market.fetchGreedIndex();
  
  await balance.fetchBalance();
  await orders.fetchOrders();
  await history.fetchNewTrades();
  
  const lastLedgerFetch = state._lastLedgerFetch || 0;
  if (Date.now() - lastLedgerFetch > 30 * 60 * 1000) {
    await balance.fetchLedgers(7);
    state._lastLedgerFetch = Date.now();
  }
}

module.exports = {
  // Initialization
  init: api.init,
  
  // Pairs
  fetchPairs: pairs.fetchPairs,
  findPairForAsset: pairs.findPairForAsset,
  getAssetFromPair: pairs.getAssetFromPair,
  toInternalPair: pairs.toInternalPair,
  
  // Market data
  fetchTicker: market.fetchTicker,
  fetchGreedIndex: market.fetchGreedIndex,
  fetchOHLC: market.fetchOHLC,
  fetchOHLCForPairs: market.fetchOHLCForPairs,
  fetchDepth: market.fetchDepth,
  fetchDepthForPairs: market.fetchDepthForPairs,
  
  // Balance & positions
  fetchBalance: balance.fetchBalance,
  fetchLedgers: balance.fetchLedgers,
  getEnrichedPositions: balance.getEnrichedPositions,
  calculateTradeAnalytics: balance.calculateTradeAnalytics,
  
  // Trade history
  fetchAllTradeHistory: history.fetchAllTradeHistory,
  fetchNewTrades: history.fetchNewTrades,
  
  // Orders
  fetchOrders: orders.fetchOrders,
  limitBuy: orders.limitBuy,
  limitSell: orders.limitSell,
  marketBuy: orders.marketBuy,
  cancelOrder: orders.cancelOrder,
  
  // Refresh all
  refreshAll
};