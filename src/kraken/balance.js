// @ts-check
/**
 * Balance, Ledger & Position Management
 */

const { state, log, saveTradeHistory, saveAnalytics } = require('../state');
const { waitForRateLimit, api } = require('./api');
const { findPairForAsset, getAssetFromPair } = require('./pairs');

async function fetchBalance() {
  await waitForRateLimit(1);
  
  return new Promise((resolve) => {
    const { getClient } = require('./api');
    getClient().api('Balance', null, (error, data) => {
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
      
      // Log all non-EUR holdings for debugging
      const holdings = Object.keys(state.wallet).filter(a => a !== 'ZEUR' && a !== 'EUR');
      if (holdings.length > 0) {
        log(`[KRAKEN] Holdings: ${holdings.map(a => `${a}:${state.wallet[a].amount.toFixed(4)}`).join(', ')}`);
      }
      
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

async function fetchLedgers(days = 7) {
  await waitForRateLimit(2);
  
  return new Promise((resolve) => {
    const start = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
    
    const { getClient } = require('./api');
    getClient().api('Ledgers', { start }, (error, data) => {
      if (error) {
        console.error('[KRAKEN] Ledgers error:', error.message);
        return resolve([]);
      }
      
      const ledgers = [];
      const rawLedger = data.result?.ledger || data.result || {};
      
      for (const [id, entry] of Object.entries(rawLedger)) {
        const type = entry.type?.toLowerCase();
        if (type !== 'deposit' && type !== 'withdrawal') continue;
        
        ledgers.push({
          id,
          type: entry.type,
          asset: entry.asset,
          amount: parseFloat(entry.amount),
          fee: parseFloat(entry.fee),
          time: entry.time,
          refid: entry.refid,
          timestamp: new Date(entry.time * 1000).toLocaleString()
        });
      }
      
      ledgers.sort((a, b) => b.time - a.time);
      state.ledgers = ledgers;
      resolve(ledgers);
    });
  });
}

/**
 * Calculate trade analytics from trade history
 * Called after trade history is loaded/updated
 */
function calculateTradeAnalytics() {
  if (!state.fullTradeHistory?.trades) return;
  
  const trades = Object.values(state.fullTradeHistory.trades)
    .sort((a, b) => a.time - b.time);
  
  // Track positions by asset to calculate P&L
  const positions = {};
  
  let totalPnL = 0;
  let wins = 0;
  let losses = 0;
  let weeklyPnL = 0;
  let weeklyWins = 0;
  let weeklyLosses = 0;
  let weeklyTrades = 0;
  const recentActivity = [];
  const oneWeekAgo = (Date.now() - (7 * 24 * 60 * 60 * 1000)) / 1000;
  
  for (const trade of trades) {
    const asset = getAssetFromPair(trade.pair);
    const amount = parseFloat(trade.vol);
    const price = parseFloat(trade.price);
    const cost = parseFloat(trade.cost);
    
    if (!positions[asset]) {
      positions[asset] = { lots: [], totalBought: 0, totalSold: 0 };
    }
    
    const pos = positions[asset];
    
    if (trade.type === 'buy') {
      pos.lots.push({ price, amount, time: trade.time });
      pos.totalBought += amount;
    } else if (trade.type === 'sell') {
      let remaining = amount;
      let costBasisUsed = 0;
      let amountMatched = 0;
      
      // Match against lots (FIFO)
      while (remaining > 0 && pos.lots.length > 0) {
        const lot = pos.lots[0];
        const used = Math.min(remaining, lot.amount);
        costBasisUsed += used * lot.price;
        amountMatched += used;
        lot.amount -= used;
        remaining -= used;
        
        if (lot.amount <= 0.0000001) {
          pos.lots.shift();
        }
      }
      
      pos.totalSold += amount;
      
      const matchedSaleValue = amountMatched > 0 ? (amountMatched / amount) * cost : cost;
      const pnl = matchedSaleValue - costBasisUsed;
      
      if (amountMatched > 0) {
        totalPnL += pnl;
        if (pnl >= 0) wins++;
        else losses++;
        
        if (trade.time >= oneWeekAgo) {
          weeklyTrades++;
          weeklyPnL += pnl;
          if (pnl >= 0) weeklyWins++;
          else weeklyLosses++;
          
          recentActivity.push({
            asset,
            pnl,
            pnlPercent: costBasisUsed > 0 ? (pnl / costBasisUsed) * 100 : 0,
            sellTime: trade.time,
            sellPrice: price
          });
        }
      }
    }
  }
  
  recentActivity.sort((a, b) => b.sellTime - a.sellTime);
  
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
    recentActivity: recentActivity.slice(0, 50)
  };
  
  // Store positions for use in getEnrichedPositions
  state._positionLots = positions;
  
  saveAnalytics();
}

/**
 * Get enriched positions calculated from trade history
 * Calculates avg entry price, P&L, and holding days from actual trade history
 */
function getEnrichedPositions() {
  const positions = {};
  
  if (!state.fullTradeHistory?.trades) {
    return positions;
  }
  
  // First, build position lots from trade history
  const positionLots = {};
  const assetTrades = {};
  
  // Group trades by asset
  for (const [id, trade] of Object.entries(state.fullTradeHistory.trades)) {
    const asset = getAssetFromPair(trade.pair);
    if (!assetTrades[asset]) assetTrades[asset] = [];
    assetTrades[asset].push({
      time: trade.time,
      type: trade.type,
      volume: parseFloat(trade.vol),
      price: parseFloat(trade.price)
    });
  }
  
  // Sort trades by time (oldest first)
  for (const asset in assetTrades) {
    assetTrades[asset].sort((a, b) => a.time - b.time);
  }
  
  // Calculate lots for each asset
  for (const asset in assetTrades) {
    const lots = [];
    for (const trade of assetTrades[asset]) {
      if (trade.type === 'buy') {
        lots.push({ price: trade.price, amount: trade.volume, time: trade.time });
      } else if (trade.type === 'sell') {
        let remaining = trade.volume;
        while (remaining > 0 && lots.length > 0) {
          const lot = lots[0];
          const used = Math.min(remaining, lot.amount);
          lot.amount -= used;
          remaining -= used;
          if (lot.amount <= 0.0000001) {
            lots.shift();
          }
        }
      }
    }
    positionLots[asset] = lots;
  }
  
  // Now enrich wallet positions
  for (const asset in state.wallet) {
    if (asset === 'ZEUR' || asset === 'EUR' || asset === 'ZUSD' || asset === 'USD') continue;
    
    const walletEntry = state.wallet[asset];
    const amount = walletEntry.amount;
    
    if (amount <= 0) continue;
    
    const pair = findPairForAsset(asset);
    const currentPrice = pair && state.ticker[pair] ? state.ticker[pair].price : 0;
    const currentValue = amount * currentPrice;
    
    // Filter by calculated value, not wallet value
    if (currentValue < 1) continue;
    
    // Calculate avg entry price from remaining lots
    const lots = positionLots[asset] || [];
    let totalCost = 0;
    let totalLotAmount = 0;
    let oldestLotTime = null;
    
    for (const lot of lots) {
      if (lot.amount > 0) {
        totalCost += lot.amount * lot.price;
        totalLotAmount += lot.amount;
        if (oldestLotTime === null || lot.time < oldestLotTime) {
          oldestLotTime = lot.time;
        }
      }
    }
    
    // If lot amount is less than wallet amount, trade history is stale
    // The missing portion (likely a recent fill) should use current price as cost estimate
    if (totalLotAmount > 0 && totalLotAmount < amount) {
      const missingAmount = amount - totalLotAmount;
      totalCost += missingAmount * currentPrice;
      totalLotAmount = amount;
    }
    
    const avgCost = totalLotAmount > 0 ? totalCost / totalLotAmount : currentPrice;
    const costBasis = totalLotAmount > 0 ? totalCost : currentValue;
    
    // Calculate holding days by walking trade history backward
    let holdingStartTime = null;
    if (assetTrades[asset] && assetTrades[asset].length > 0) {
      // Walk backward from most recent trade
      const trades = [...assetTrades[asset]].sort((a, b) => b.time - a.time);
      let runningPosition = amount;
      
      for (const trade of trades) {
        if (trade.type === 'buy') {
          runningPosition -= trade.volume;
        } else {
          runningPosition += trade.volume;
        }
        
        if (runningPosition <= 0.0001) {
          // Position was opened after this trade
          holdingStartTime = trade.time;
          break;
        }
      }
      
      // If we never hit zero, position was opened before first trade
      // Use oldest lot time or first trade
      if (holdingStartTime === null) {
        holdingStartTime = oldestLotTime || assetTrades[asset][0].time;
      }
    }
    
    const holdingDays = holdingStartTime 
      ? Math.floor((Date.now() / 1000 - holdingStartTime) / 86400)
      : 0;
    
    // Ensure holdingDays is valid
    const validHoldingDays = holdingDays >= 0 ? holdingDays : 0;
    
    const unrealizedPnL = currentValue - costBasis;
    
    positions[asset] = {
      amount,
      avgCost,
      costBasis,
      currentPrice,
      currentValue,
      unrealizedPnL,
      unrealizedPct: costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0,
      holdingDays: validHoldingDays
    };
  }
  
  return positions;
}

module.exports = {
  fetchBalance,
  fetchLedgers,
  calculateTradeAnalytics,
  getEnrichedPositions
};