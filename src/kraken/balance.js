// @ts-check
/**
 * Balance, Ledger & Position Management
 */

const { state, log, saveTradeHistory, saveCostBasis, saveAnalytics } = require('../state');
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
      
      const matchedSaleValue = amountMatched > 0 ? (amountMatched / amount) * cost : 0;
      const pnl = matchedSaleValue - costBasisUsed;
      
      if (amountMatched > 0) {
        cb.realizedPnL += pnl;
      }
      cb.totalReturned += cost;
      
      cb.completedTrades.push({
        sellTime: trade.time,
        sellPrice: price,
        amount,
        amountMatched,
        pnl: amountMatched > 0 ? pnl : 0,
        pnlPercent: costBasisUsed > 0 ? (pnl / costBasisUsed) * 100 : 0
      });
    }
  }
  
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
  
  saveCostBasis();
  saveAnalytics();
}

function getEnrichedPositions() {
  const positions = {};
  
  for (const asset in state.wallet) {
    if (asset === 'ZEUR' || asset === 'EUR' || asset === 'ZUSD' || asset === 'USD') continue;
    
    const walletEntry = state.wallet[asset];
    const amount = walletEntry.amount;
    
    if (amount <= 0 || walletEntry.value < 0.01) continue;
    
    const pair = findPairForAsset(asset);
    const currentPrice = pair && state.ticker[pair] ? state.ticker[pair].price : 0;
    const currentValue = amount * currentPrice;
    
    if (currentValue < 1) continue;
    
    const cb = state.costBasis[asset];
    let avgCost = currentPrice;
    let costBasis = currentValue;
    let oldestTime = Date.now();
    
    if (cb && cb.lots && cb.lots.length > 0) {
      let totalCost = 0;
      let totalAmount = 0;
      
      for (const lot of cb.lots) {
        if (lot.remaining > 0) {
          totalAmount += lot.remaining;
          totalCost += lot.remaining * lot.price;
          const lotTime = lot.time > 1e12 ? lot.time : lot.time * 1000;
          oldestTime = Math.min(oldestTime, lotTime);
        }
      }
      
      if (totalAmount > 0) {
        avgCost = totalCost / totalAmount;
        costBasis = totalCost;
      }
    }
    
    let holdingStartTime = oldestTime;
    if (state.fullTradeHistory && state.fullTradeHistory.trades) {
      const assetTrades = Object.entries(state.fullTradeHistory.trades)
        .filter(([id, trade]) => {
          const tradePair = trade.pair;
          const tradeAsset = tradePair.replace(/Z?EUR$/, '').replace(/^X+/, '');
          return tradeAsset === asset || tradePair.includes(asset);
        })
        .map(([id, trade]) => ({
          time: trade.time > 1e12 ? trade.time : trade.time * 1000,
          volume: parseFloat(trade.vol),
          type: trade.type
        }))
        .sort((a, b) => b.time - a.time);
      
      let runningPosition = amount;
      for (const trade of assetTrades) {
        if (trade.type === 'buy') {
          runningPosition -= trade.volume;
        } else {
          runningPosition += trade.volume;
        }
        if (runningPosition <= 0.0001) {
          holdingStartTime = trade.time;
          break;
        }
        holdingStartTime = trade.time;
      }
    }
    
    const unrealizedPnL = currentValue - costBasis;
    const holdingDays = Math.floor((Date.now() - holdingStartTime) / (86400 * 1000));
    
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

module.exports = {
  fetchBalance,
  fetchLedgers,
  buildCostBasis,
  getEnrichedPositions
};