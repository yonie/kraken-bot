// @ts-check
/**
 * HTTP & WebSocket Server
 * Serves the frontend and provides real-time updates
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { state, log } = require('./state');
const kraken = require('./kraken');
const ai = require('./ai');

const PORT = process.env.PORT || 8000;
let wss = null;
const clients = new Set();

// ============================================
// HTTP SERVER
// ============================================

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, '..', 'public', filePath);
  
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'text/plain';
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
}

function handleAPI(req, res, pathname, url) {
  res.setHeader('Content-Type', 'application/json');
  
  // GET endpoints
  if (req.method === 'GET') {
    switch (pathname) {
      case '/api/state':
        return res.end(JSON.stringify(getFullState()));
      
      case '/api/analysis':
        return res.end(JSON.stringify(state.llmAnalysis));
      
      case '/api/history':
        return res.end(JSON.stringify(state.llmHistory.slice(0, 20)));
      
      case '/api/positions':
        return res.end(JSON.stringify(kraken.getEnrichedPositions()));
      
      case '/api/logs':
        return res.end(JSON.stringify(state.logs.slice(0, 100)));
      
      case '/api/balance-history':
        return res.end(JSON.stringify(state.balanceHistory || []));
      
      case '/api/asset-details': {
        const assetParam = url.searchParams.get('asset');
        if (!assetParam) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Missing asset parameter' }));
        }
        return res.end(JSON.stringify(getAssetDetails(assetParam)));
      }
      
      default:
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Not found' }));
    }
  }
  
  // POST endpoints
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        
        switch (pathname) {
          case '/api/analyze':
            const result = await ai.runAnalysis(true);
            broadcast('analysis', state.llmAnalysis);
            return res.end(JSON.stringify(result));
          
          case '/api/refresh':
            await kraken.refreshAll();
            broadcast('state', getFullState());
            return res.end(JSON.stringify({ success: true }));
          
          case '/api/cancel':
            if (data.orderId) {
              const r = await kraken.cancelOrder(data.orderId);
              await kraken.fetchOrders();
              broadcast('orders', state.orders);
              return res.end(JSON.stringify(r));
            }
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'Missing orderId' }));
          
          default:
            res.writeHead(404);
            return res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  
  res.writeHead(405);
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  
  if (pathname.startsWith('/api/')) {
    handleAPI(req, res, pathname, url);
  } else {
    serveStatic(req, res);
  }
});

// ============================================
// WEBSOCKET SERVER
// ============================================

function setupWebSocket() {
  wss = new WebSocket.Server({ server });
  
  wss.on('connection', (ws) => {
    clients.add(ws);
    log(`[WS] Client connected (${clients.size} total)`);
    
    // Send initial state
    ws.send(JSON.stringify({ type: 'state', data: getFullState() }));
    
    ws.on('message', async (msg) => {
      try {
        const { action, data } = JSON.parse(msg);
        
        switch (action) {
          case 'refresh':
            await kraken.refreshAll();
            broadcast('state', getFullState());
            break;
          
          case 'analyze':
            await ai.runAnalysis(true);
            broadcast('analysis', state.llmAnalysis);
            break;
          
          case 'cancel':
            if (data?.orderId) {
              await kraken.cancelOrder(data.orderId);
              await kraken.fetchOrders();
              broadcast('orders', state.orders);
            }
            break;
        }
      } catch (e) {
        console.error('[WS] Error:', e.message);
      }
    });
    
    ws.on('close', () => {
      clients.delete(ws);
      log(`[WS] Client disconnected (${clients.size} total)`);
    });
  });
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ============================================
// STATE HELPERS
// ============================================

/**
 * Get detailed trading information for a specific asset
 */
function getAssetDetails(assetName) {
  // Normalize asset name - remove common prefixes/suffixes
  const normalizedAsset = assetName.toUpperCase()
    .replace(/^[XZ]+/, '')  // Remove X/Z prefixes
    .replace(/\.S$/, '')    // Remove staking suffix
    .trim();
  
  // Find matching pair
  const pair = kraken.findPairForAsset(normalizedAsset);
  
  // Get ticker data
  const ticker = pair ? state.ticker[pair] : null;
  
  // Get position info
  const positions = kraken.getEnrichedPositions();
  let position = null;
  
  // Try to find position with various asset name formats
  for (const key of Object.keys(positions)) {
    const cleanKey = key.replace(/^[XZ]+/, '').replace(/\.S$/, '');
    if (cleanKey === normalizedAsset || key === assetName) {
      position = { asset: key, ...positions[key] };
      break;
    }
  }
  
  // Get cost basis info
  let costBasisInfo = null;
  for (const key of Object.keys(state.costBasis)) {
    const cleanKey = key.replace(/^[XZ]+/, '').replace(/\.S$/, '');
    if (cleanKey === normalizedAsset || key === assetName) {
      const cb = state.costBasis[key];
      costBasisInfo = {
        totalInvested: cb.totalInvested,
        totalReturned: cb.totalReturned,
        realizedPnL: cb.realizedPnL,
        openLots: cb.lots.filter(l => l.remaining > 0).length,
        completedTradesCount: cb.completedTrades.length
      };
      break;
    }
  }
  
  // Get recent trades for this asset (both buys and sells)
  const assetTrades = Object.entries(state.fullTradeHistory.trades)
    .filter(([id, trade]) => {
      const tradePair = trade.pair;
      const tradeAsset = tradePair.replace(/Z?EUR$/, '').replace(/^X+/, '');
      return tradeAsset === normalizedAsset || 
             tradePair === pair ||
             tradePair.includes(normalizedAsset);
    })
    .map(([id, trade]) => ({
      id,
      type: trade.type,
      price: parseFloat(trade.price),
      volume: parseFloat(trade.vol),
      cost: parseFloat(trade.cost),
      time: trade.time,
      pair: trade.pair
    }))
    .sort((a, b) => b.time - a.time)
    .slice(0, 50);
  
  // Get open orders for this asset
  const openOrders = Object.entries(state.orders)
    .filter(([id, order]) => {
      const orderPair = order.descr?.pair || '';
      return orderPair.includes(normalizedAsset) || 
             orderPair === pair?.replace('ZEUR', 'EUR');
    })
    .map(([id, order]) => ({
      id,
      type: order.descr?.type,
      price: parseFloat(order.descr?.price || 0),
      volume: parseFloat(order.vol || 0),
      pair: order.descr?.pair
    }));
  
  // Get recent closed trades P&L for this asset
  const closedPnL = (state.tradeAnalytics.recentActivity || [])
    .filter(t => {
      const cleanAsset = t.asset.replace(/^[XZ]+/, '').replace(/\.S$/, '');
      return cleanAsset === normalizedAsset || t.asset === assetName;
    })
    .slice(0, 20);
  
  // Calculate summary stats
  const buyTrades = assetTrades.filter(t => t.type === 'buy');
  const sellTrades = assetTrades.filter(t => t.type === 'sell');
  const totalBought = buyTrades.reduce((sum, t) => sum + t.cost, 0);
  const totalSold = sellTrades.reduce((sum, t) => sum + t.cost, 0);
  const avgBuyPrice = buyTrades.length > 0 
    ? buyTrades.reduce((sum, t) => sum + t.price * t.volume, 0) / buyTrades.reduce((sum, t) => sum + t.volume, 0)
    : 0;
  const avgSellPrice = sellTrades.length > 0
    ? sellTrades.reduce((sum, t) => sum + t.price * t.volume, 0) / sellTrades.reduce((sum, t) => sum + t.volume, 0)
    : 0;
  
  return {
    asset: normalizedAsset,
    pair,
    
    // Current market data
    ticker: ticker ? {
      price: ticker.price,
      bid: ticker.bid,
      ask: ticker.ask,
      spread: ticker.spread,
      spreadPct: ticker.spreadPct,
      low24: ticker.low24,
      high24: ticker.high24,
      dayMove: ticker.dayMove,
      distFromLow: ticker.distFromLow,
      volume24h: ticker.volume,
      volumeEur24h: ticker.volumeEur,
      trades24h: ticker.trades24h
    } : null,
    
    // Current position
    position,
    
    // Cost basis summary
    costBasis: costBasisInfo,
    
    // Trading summary
    summary: {
      totalBought,
      totalSold,
      avgBuyPrice,
      avgSellPrice,
      buyCount: buyTrades.length,
      sellCount: sellTrades.length,
      totalTrades: assetTrades.length
    },
    
    // Recent activity
    recentTrades: assetTrades.slice(0, 20),
    openOrders,
    closedPnL
  };
}

function getFullState() {
  const positions = kraken.getEnrichedPositions();
  
  return {
    // Balances
    balance: state.tradeBalance,
    wallet: state.wallet,
    
    // Market
    ticker: state.ticker,
    greedIndex: state.greedIndex,
    greedClass: state.greedClassification,
    
    // Trading
    orders: state.orders,
    trades: state.trades.slice(0, 50),
    positions,
    
    // Analytics
    analytics: state.tradeAnalytics.summary,
    recentPnL: state.tradeAnalytics.recentActivity?.slice(0, 50) || [],
    
    // AI
    analysis: state.llmAnalysis,
    
    // Meta
    uptime: Math.floor((Date.now() - state.serverStartTime) / 1000),
    pairsCount: Object.keys(state.pairs).length
  };
}

// ============================================
// START SERVER
// ============================================

function start() {
  setupWebSocket();
  
  // Bind to 0.0.0.0 to accept connections from any interface (not just localhost)
  server.listen(PORT, '0.0.0.0', () => {
    log(`[SERVER] Running on http://0.0.0.0:${PORT}`);
  });
  
  // Periodic state broadcasts to keep frontend in sync
  // Note: This only broadcasts current state, actual data refresh happens in index.js scheduler
  setInterval(() => {
    if (clients.size > 0) {
      broadcast('state', getFullState());
    }
  }, 15000); // Broadcast every 15 seconds to keep frontend responsive
}

module.exports = {
  start,
  broadcast,
  getFullState
};
