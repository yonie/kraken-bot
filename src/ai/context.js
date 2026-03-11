// @ts-check
/**
 * Context Building Module
 * Builds the context data for LLM prompts
 */

const https = require('https');
const kraken = require('../kraken');
const { state } = require('../state');
const { fetchAllNews } = require('../news');
const { cleanAssetName } = require('./commands');

let lastGlobalMarketFetch = 0;
const GLOBAL_MARKET_CACHE_TTL = 30000;

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
  
  for (const asset in assetStats) {
    const s = assetStats[asset];
    s.winRate = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : 0;
    s.avgWin = s.wins > 0 ? (s.totalWin / s.wins).toFixed(0) : 0;
    s.avgLoss = s.losses > 0 ? (s.totalLoss / s.losses).toFixed(0) : 0;
    s.totalPnL = s.totalWin - s.totalLoss;
  }
  
  return assetStats;
}

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
  
  const eurCash = state.wallet['ZEUR']?.amount || state.wallet['EUR']?.amount || 0;
  const totalPortfolio = state.tradeBalance;
  const investedValue = totalPortfolio - eurCash;
  
  const [globalMarket, news, sessionInfo, assetPerformance] = await Promise.all([
    fetchGlobalMarketData(),
    fetchAllNews(),
    Promise.resolve(getSessionInfo()),
    Promise.resolve(computeAssetPerformance())
  ]);
  
  if (news) {
    state.news = {
      crypto: news.crypto?.items || [],
      kraken: news.kraken?.items || [],
      world: news.world?.items || [],
      lastUpdate: Date.now()
    };
  }
  
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
  
  const ohlcData = await kraken.fetchOHLCForPairs([...positionPairs]);
  
  // Calculate 7-day momentum from OHLC (formation period per Tzouvanas et al.)
  // This is critical: we rank by 7-day returns, NOT 24h spikes
  const ohlcReturns = {};
  for (const [pair, candles] of Object.entries(ohlcData)) {
    if (candles && candles.length >= 7) {
      const currentPrice = candles[candles.length - 1].close;
      const price7dAgo = candles[candles.length - 7].close;
      if (price7dAgo > 0) {
        ohlcReturns[pair] = ((currentPrice - price7dAgo) / price7dAgo) * 100;
      }
    }
  }
  
  // Rank by 7-day momentum (correct implementation per academic research)
  // Filter out assets without 7-day data, then sort by formation period returns
  const movers = Object.entries(state.ticker)
    .map(([pair, t]) => ({
      pair,
      ...t,
      change7dPct: ohlcReturns[pair] !== undefined ? ohlcReturns[pair] : null
    }))
    .filter(m => m.change7dPct !== null && !isNaN(m.change7dPct))
    .sort((a, b) => b.change7dPct - a.change7dPct)
    .slice(0, 20);
  
  const positionPairsArray = [...positionPairs].filter(p => {
    const asset = p.replace(/Z?EUR$/, '').replace(/^X+/, '');
    return enriched[asset] || enriched['X' + asset] || enriched['XX' + asset];
  });
  
  // Always fetch depth for BTC, ETH, and top movers by volume
  const depthPairs = new Set(['XXBTZEUR', 'XETHZEUR']);
  
  // Add depth for held positions
  Object.keys(enriched).forEach(a => {
    const pair = kraken.findPairForAsset(a);
    if (pair) depthPairs.add(pair);
  });
  
  // Add depth for top 20 by volume
  topByVolume.slice(0, 20).forEach(m => {
    if (m.pair) depthPairs.add(m.pair);
  });
  
  // Add depth for top 10 movers (potential breakout plays)
  movers.slice(0, 10).forEach(m => {
    if (m.pair && (m.volumeEur || 0) > 100000) { // Only if volume > €100k
      depthPairs.add(m.pair);
    }
  });
  
  const depthData = await kraken.fetchDepthForPairs([...depthPairs]);
  
  let assetsUp = 0;
  let assetsDown = 0;
  for (const [pair, t] of Object.entries(state.ticker)) {
    const change = ((t.price - t.open) / t.open) * 100;
    if (change > 0) assetsUp++;
    else if (change < 0) assetsDown++;
  }
  const marketBreadth = { up: assetsUp, down: assetsDown, total: assetsUp + assetsDown };
  
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
          range24hPct: ticker?.range24hPct,
          change24hPct: ticker?.change24hPct,
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
  
  positions.sort((a, b) => {
    if (a.isCash) return -1;
    if (b.isCash) return 1;
    return parseFloat(b.value) - parseFloat(a.value);
  });
  
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
  
  const analytics = state.tradeAnalytics.summary;
  const unrealizedPnL = positions.reduce((sum, p) => sum + parseFloat(p.pnl), 0);
  const cashPct = totalPortfolio > 0 ? ((eurCash / totalPortfolio) * 100).toFixed(1) : '0';
  
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
  
  const btcOHLC = ohlcData['XXBTZEUR'] || [];
  const ethOHLC = ohlcData['XETHZEUR'] || [];
  const recentLedgers = state.ledgers.slice(0, 10);
  
  // Calculate RSI from OHLC closes
  function calculateRSI(closes, period) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
  
  const btcCloses = btcOHLC.map(c => c.close);
  const btcRSI = btcCloses.length >= 15 ? calculateRSI(btcCloses, 14) : null;
  
  let weekChangeEUR = null;
  let weekChangeExclDeposits = null;
  let btcPriceChange = null;
  
  if (balanceHistory.length >= 2) {
    const oldest = balanceHistory[0];
    const newest = balanceHistory[balanceHistory.length - 1];
    const oldEUR = parseFloat(oldest.eur);
    const newEUR = parseFloat(newest.eur);
    if (!isNaN(oldEUR) && !isNaN(newEUR) && oldEUR > 0) {
      weekChangeEUR = ((newEUR - oldEUR) / oldEUR * 100).toFixed(2);
      
      // Calculate deposits/withdrawals in 7d window
      const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const recentDeposits = state.ledgers
        .filter(l => l.time * 1000 >= weekAgo)
        .reduce((sum, l) => {
          const amt = parseFloat(l.amount) || 0;
          return l.type === 'deposit' ? sum + amt : sum - amt;
        }, 0);
      
      const perfBase = oldEUR + recentDeposits;
      if (perfBase > 0) {
        weekChangeExclDeposits = ((newEUR - oldEUR - recentDeposits) / perfBase * 100).toFixed(2);
      }
    }
  }
  
  if (btcOHLC.length >= 2) {
    const startPrice = btcOHLC[0].close;
    const endPrice = btcOHLC[btcOHLC.length - 1].close;
    if (startPrice > 0) {
      btcPriceChange = ((endPrice - startPrice) / startPrice * 100).toFixed(2);
    }
  }
  
  // Market regime filter: pause momentum during extreme fear + high BTC dominance
  // Per academic research: momentum strategies crash during risk-off regimes
  const fearIndex = state.greedIndex || 50;
  const btcDom = globalMarket?.btcDominance || 0;
  const shouldPauseMomentum = fearIndex < 25 && btcDom > 55;
  
  const regimeWarning = shouldPauseMomentum ? {
    active: true,
    fear_index: fearIndex,
    btc_dominance_pct: btcDom,
    condition: 'Fear < 25 AND BTC dominance > 55%',
    recommendation: 'MOMENTUM PAUSE: Consider HOLD/SELL only, no new entries. Capital flight to BTC makes altcoin momentum unreliable.'
  } : { active: false };
  
  return {
    sessionInfo,
    globalMarket,
    marketBreadth,
    greedIndex: state.greedIndex,
    greedClass: state.greedClassification,
    btcPrice: state.ticker['XXBTZEUR']?.price,
    ethPrice: state.ticker['XETHZEUR']?.price,
    btcOHLC,
    ethOHLC,
    btcRSI,
    btcDepth: depthData['XXBTZEUR'] || null,
    ethDepth: depthData['XETHZEUR'] || null,
    ohlcData,
    news,
    totalPortfolio: totalPortfolio.toFixed(2),
    eurCash: eurCash.toFixed(2),
    investedValue: investedValue.toFixed(2),
    cashPct,
    unrealizedPnL: unrealizedPnL.toFixed(2),
    positions,
    movers,
    topByVolume,
    recentTrades,
    recentLedgers,
    openOrders,
    recentExecutionResults,
    analytics,
    assetPerformance,
    balanceHistory,
    weekChangeEUR,
    weekChangeExclDeposits,
    btcPriceChange,
    regimeWarning
  };
}

module.exports = {
  fetchGlobalMarketData,
  computeAssetPerformance,
  getSessionInfo,
  buildContext
};