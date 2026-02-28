// @ts-check
/**
 * Market Data Fetching
 * Ticker, OHLC, Order Book Depth, Fear & Greed Index
 */

const https = require('https');
const { state } = require('../state');
const { waitForRateLimit } = require('./api');
const { findPairForAsset } = require('./pairs');

async function fetchTicker() {
  if (!state.pairs || Object.keys(state.pairs).length === 0) return;
  
  const pairList = Object.keys(state.pairs).join(',');
  
  return new Promise((resolve) => {
    const { getClient } = require('./api');
    getClient().api('Ticker', { pair: pairList }, (error, data) => {
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
        const range24hPct = low24 > 0 ? Math.round((range / low24) * 100) : 0;
        const openPrice = parseFloat(t.o);
        const change24hPct = openPrice > 0 ? Math.round(((price - openPrice) / openPrice) * 100) : 0;
        
        const askPrice = parseFloat(t.a[0]);
        const askVolume = parseFloat(t.a[2]);
        const bidPrice = parseFloat(t.b[0]);
        const bidVolume = parseFloat(t.b[2]);
        const spread = askPrice - bidPrice;
        const spreadPct = bidPrice > 0 ? ((spread / bidPrice) * 100) : 0;
        
        state.ticker[pair] = {
          price,
          lastVolume: parseFloat(t.c[1]),
          ask: askPrice,
          askVolume,
          bid: bidPrice,
          bidVolume,
          spread,
          spreadPct,
          low24,
          high24,
          lowToday: parseFloat(t.l[0]),
          highToday: parseFloat(t.h[0]),
          distFromLow,
          range24hPct,
          change24hPct,
          volume: parseFloat(t.v[1]),
          volumeToday: parseFloat(t.v[0]),
          volumeEur: parseFloat(t.v[1]) * parseFloat(t.p[1]),
          volumeEurToday: parseFloat(t.v[0]) * parseFloat(t.p[0]),
          vwap: parseFloat(t.p[1]),
          vwapToday: parseFloat(t.p[0]),
          trades24h: t.t[1],
          tradesToday: t.t[0],
          open: parseFloat(t.o),
          display: `${price.toFixed(price < 1 ? 6 : 2)} (${change24hPct >= 0 ? '+' : ''}${change24hPct}%, ${distFromLow}%-${100-distFromLow}%)`
        };
      }
      
      resolve(state.ticker);
    });
  });
}

async function fetchGreedIndex() {
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

async function fetchOHLC(pair, interval = 1440) {
  return new Promise((resolve) => {
    const krakenPair = pair.startsWith('X') || pair.endsWith('EUR') ? pair : findPairForAsset(pair);
    if (!krakenPair) return resolve(null);
    
    const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=${interval}`;
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error && json.error.length > 0) {
            return resolve(null);
          }
          
          const result = json.result;
          const pairKey = Object.keys(result)[0];
          const ohlcData = result[pairKey];
          
          if (!ohlcData || ohlcData.length === 0) {
            return resolve(null);
          }
          
          const candles = ohlcData.slice(-7).map(c => ({
            time: parseInt(c[0]) * 1000,
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            vwap: parseFloat(c[5]),
            volume: parseFloat(c[6])
          }));
          
          resolve(candles);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function fetchOHLCForPairs(pairs) {
  const results = {};
  
  for (const pair of pairs) {
    try {
      const ohlc = await fetchOHLC(pair);
      if (ohlc) {
        results[pair] = ohlc;
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      // Continue on error
    }
  }
  
  return results;
}

async function fetchDepth(pair, count = 20) {
  return new Promise((resolve) => {
    const krakenPair = pair.startsWith('X') || pair.endsWith('EUR') ? pair : findPairForAsset(pair);
    if (!krakenPair) return resolve(null);
    
    const url = `https://api.kraken.com/0/public/Depth?pair=${krakenPair}&count=${count}`;
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error && json.error.length > 0) {
            return resolve(null);
          }
          
          const result = json.result;
          const pairKey = Object.keys(result)[0];
          const depth = result[pairKey];
          
          if (!depth) {
            return resolve(null);
          }
          
          const bids = (depth.bids || []).map(b => ({
            price: parseFloat(b[0]),
            volume: parseFloat(b[1]),
            timestamp: parseInt(b[2])
          }));
          
          const asks = (depth.asks || []).map(a => ({
            price: parseFloat(a[0]),
            volume: parseFloat(a[1]),
            timestamp: parseInt(a[2])
          }));
          
          const currentPrice = bids.length > 0 ? bids[0].price : (asks.length > 0 ? asks[0].price : 0);
          
          let bidDepth5pct = 0;
          let askDepth5pct = 0;
          const targetPrice = currentPrice * 0.05;
          
          for (const b of bids) {
            if (currentPrice - b.price <= targetPrice) {
              bidDepth5pct += b.volume * b.price;
            }
          }
          for (const a of asks) {
            if (a.price - currentPrice <= targetPrice) {
              askDepth5pct += a.volume * a.price;
            }
          }
          
          const bidWalls = bids.slice(0, 10).sort((a, b) => b.volume - a.volume).slice(0, 3)
            .map(w => ({ price: w.price, volume: w.volume }));
          const askWalls = asks.slice(0, 10).sort((a, b) => b.volume - a.volume).slice(0, 3)
            .map(w => ({ price: w.price, volume: w.volume }));
          
          resolve({
            bids,
            asks,
            bidDepth5pct,
            askDepth5pct,
            bidWalls,
            askWalls,
            spread: asks.length > 0 && bids.length > 0 ? asks[0].price - bids[0].price : 0
          });
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function fetchDepthForPairs(pairs) {
  const results = {};
  
  for (const pair of pairs) {
    try {
      const depth = await fetchDepth(pair);
      if (depth) {
        results[pair] = depth;
      }
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      // Continue on error
    }
  }
  
  return results;
}

module.exports = {
  fetchTicker,
  fetchGreedIndex,
  fetchOHLC,
  fetchOHLCForPairs,
  fetchDepth,
  fetchDepthForPairs
};