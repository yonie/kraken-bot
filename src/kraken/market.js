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
        if (error.message && error.message.includes('Unknown asset pair')) {
          identifyAndRemoveInvalidPairs();
        }
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

async function identifyAndRemoveInvalidPairs() {
  const { log } = require('../state');
  const { waitForRateLimit } = require('./api');
  
  if (!state.pairs || Object.keys(state.pairs).length === 0) {
    log('[KRAKEN] No pairs to validate, will reinitialize pairs...');
    return;
  }

  log('[KRAKEN] Starting pair validation to identify stale pairs...');
  
  const pairKeys = Object.keys(state.pairs);
  const batchSize = 20;
  let currentBatch = 0;
  let removedPairs = [];
  
  async function testBatch() {
    const startIndex = currentBatch * batchSize;
    const endIndex = Math.min(startIndex + batchSize, pairKeys.length);
    const batchPairs = pairKeys.slice(startIndex, endIndex);
    
    if (batchPairs.length === 0) {
      if (removedPairs.length > 0) {
        log(`[KRAKEN] Removed ${removedPairs.length} invalid pairs: ${removedPairs.join(', ')}`);
        log(`[KRAKEN] Now trading on ${Object.keys(state.pairs).length} pairs`);
      } else {
        log(`[KRAKEN] Pair validation complete. All ${Object.keys(state.pairs).length} pairs valid.`);
      }
      return;
    }
    
    const batchString = batchPairs.join(',');
    
    await waitForRateLimit(1);
    
    return new Promise((resolve) => {
      const { getClient } = require('./api');
      getClient().api('Ticker', { pair: batchString }, (error, tickerdata) => {
        if (error && error.message && error.message.includes('API:Rate limit exceeded')) {
          log('[KRAKEN] Rate limit hit during validation, waiting 60s...');
          setTimeout(() => testBatch().then(resolve), 60000);
          return;
        }
        
        if (error && error.message && error.message.includes('Unknown asset pair')) {
          log(`[KRAKEN] Batch ${currentBatch + 1} contains invalid pairs, testing individually...`);
          testPairsIndividually(batchPairs, () => {
            currentBatch++;
            setTimeout(() => testBatch().then(resolve), 5000);
          });
        } else if (error) {
          console.error('[KRAKEN] Error testing batch:', error.message);
          currentBatch++;
          setTimeout(() => testBatch().then(resolve), 5000);
        } else {
          currentBatch++;
          setTimeout(() => testBatch().then(resolve), 3000);
        }
      });
    });
  }
  
  function testPairsIndividually(pairsToTest, callback) {
    let index = 0;
    const { log } = require('../state');
    
    async function testNextPair() {
      if (index >= pairsToTest.length) {
        callback();
        return;
      }
      
      const pair = pairsToTest[index];
      
      await waitForRateLimit(1);
      
      return new Promise((resolve) => {
        const { getClient } = require('./api');
        getClient().api('Ticker', { pair: pair }, (error, tickerdata) => {
          if (error && error.message && error.message.includes('API:Rate limit exceeded')) {
            log('[KRAKEN] Rate limit during individual test, waiting 30s...');
            setTimeout(() => testNextPair().then(resolve), 30000);
            return;
          }
          
          if (error && error.message && error.message.includes('Unknown asset pair')) {
            const asset = state.pairs[pair]?.base || 'unknown';
            log(`[KRAKEN] Removing invalid pair: ${pair} (asset: ${asset})`);
            delete state.pairs[pair];
            delete state.assetToPairMap[asset];
            removedPairs.push(pair);
          } else if (error) {
            console.error(`[KRAKEN] Error testing pair ${pair}:`, error.message);
          }
          
          index++;
          setTimeout(() => testNextPair().then(resolve), 1000);
        });
      });
    }
    
    testNextPair().then(resolve);
  }
  
  log('[KRAKEN] Starting conservative pair validation to avoid rate limits...');
  setTimeout(() => testBatch(), 2000);
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
          
          const candles = ohlcData.slice(-30).map(c => ({
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
  fetchDepthForPairs,
  identifyAndRemoveInvalidPairs
};