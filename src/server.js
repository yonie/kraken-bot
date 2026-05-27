// @ts-check
/**
 * HTTP & WebSocket Server
 * Serves the frontend and provides real-time updates
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { state, log, DATA_DIR, config } = require('./state');
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
      
      case '/api/news':
        return res.end(JSON.stringify(state.news || { crypto: [], kraken: [], world: [], lastUpdate: null }));
      
      case '/api/insights':
        return res.end(JSON.stringify(state.insights || []));
      
      case '/api/ledgers':
        return res.end(JSON.stringify(state.ledgers || []));
      
      case '/api/strategy':
        return res.end(JSON.stringify({ strategy: getStrategy() }));
      
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
          
          case '/api/strategy':
            return res.end(JSON.stringify(handleStrategyUpdate(data)));

          case '/api/sell':
            return res.end(JSON.stringify(await handleMarketSell(data)));

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
  
  setInterval(() => {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, 30000);
  
  wss.on('connection', (ws) => {
    clients.add(ws);
    //log(`[WS] Client connected (${clients.size} total)`);
    
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
            // log('[WS] Analyze request received');
            await ai.runAnalysis(true);
            // log('[WS] Broadcasting state update');
            broadcast('state', getFullState());
            break;
          
          case 'cancel':
            if (data?.orderId) {
              await kraken.cancelOrder(data.orderId);
              await kraken.fetchOrders();
              broadcast('state', getFullState());
            }
            break;
        }
      } catch (e) {
        console.error('[WS] Error:', e.message);
      }
    });
    
    ws.on('close', () => {
      clients.delete(ws);
      //log(`[WS] Client disconnected (${clients.size} total)`);
    });
  });
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  // let sent = 0;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
      // sent++;
    }
  }
  // log(`[WS] Broadcast '${type}' to ${sent} clients`);
}

// ============================================
// STATE HELPERS
// ============================================

function getStrategy() {
  try {
    const userPath = path.join(DATA_DIR, 'strategy.md');
    const defaultPath = path.join(DATA_DIR, 'strategy.example.md');
    
    if (fs.existsSync(userPath)) {
      return { content: fs.readFileSync(userPath, 'utf8'), isUser: true };
    }
    if (fs.existsSync(defaultPath)) {
      return { content: fs.readFileSync(defaultPath, 'utf8'), isUser: false };
    }
    return { content: '# No strategy file found', isUser: false };
  } catch (e) {
    return { content: `# Error reading strategy: ${e.message}`, isUser: false };
  }
}

function handleStrategyUpdate(data) {
  const { password, content } = data;
  
  if (!config.editPassword) {
    return { success: false, error: 'Password protection not configured. Set EDIT_PASSWORD in environment.' };
  }
  
  if (!password || password !== config.editPassword) {
    return { success: false, error: 'Invalid password' };
  }
  
  if (!content || typeof content !== 'string') {
    return { success: false, error: 'Invalid strategy content' };
  }
  
  const userPath = path.join(DATA_DIR, 'strategy.md');
  try {
    fs.writeFileSync(userPath, content, 'utf8');
    log('[SERVER] Strategy updated via web interface');
    return { success: true };
  } catch (e) {
    return { success: false, error: `Failed to save: ${e.message}` };
  }
}

async function handleMarketSell(data) {
  const { asset, password } = data;

  if (!config.editPassword) {
    return { success: false, error: 'Password protection not configured. Set EDIT_PASSWORD in environment.' };
  }
  if (!password || password !== config.editPassword) {
    return { success: false, error: 'Invalid password' };
  }
  if (!asset) {
    return { success: false, error: 'Missing asset' };
  }

  const pair = kraken.findPairForAsset(asset);
  if (!pair) {
    return { success: false, error: `No trading pair found for ${asset}` };
  }

  const positions = kraken.getEnrichedPositions();
  const position = positions[asset];
  if (!position || position.amount <= 0) {
    return { success: false, error: `No position found for ${asset}` };
  }

  const internalPair = kraken.toInternalPair(pair);
  const existingOrders = Object.entries(state.orders).filter(([id, order]) => {
    const orderPair = order.descr?.pair;
    if (!orderPair) return false;
    return kraken.toInternalPair(orderPair) === internalPair;
  });

  // Fast path: if there's a stop-loss sell on this pair, nudge its trigger to
  // current price. Kraken fires it as a market order immediately — one API call
  // instead of cancel+market, and no racing with the stop.
  const currentPrice = state.ticker[pair]?.price;
  const activeStop = existingOrders.find(([id, o]) =>
    o.descr?.type === 'sell' && (o.descr?.ordertype || '').startsWith('stop')
  );
  if (activeStop && currentPrice > 0) {
    const [stopId] = activeStop;
    log(`[SELL-UI] Nudging stop ${stopId} for ${asset} to current price ${currentPrice}`);
    const edit = await kraken.editOrder(stopId, pair, currentPrice);
    if (edit.success) {
      await new Promise(r => setTimeout(r, 2000));
      await kraken.fetchNewTrades();
      await kraken.fetchBalance();
      await kraken.fetchOrders();
      broadcast('state', getFullState());
      return { success: true, asset, message: `Triggered stop for ${position.displayName}` };
    }
    log(`[SELL-UI] Stop nudge failed (${edit.error}), falling back to cancel+market`);
  }

  // Fallback: cancel everything, then market sell
  for (const [orderId] of existingOrders) {
    log(`[SELL-UI] Cancelling existing order ${orderId} for ${asset}`);
    await kraken.cancelOrder(orderId);
    delete state.orders[orderId];
    await new Promise(r => setTimeout(r, 500));
  }

  // Market sell with volume retry for precision
  const volumeAttempts = [1.0, 0.999, 0.99];
  for (const multiplier of volumeAttempts) {
    const volume = position.amount * multiplier;
    log(`[SELL-UI] Market SELL ${volume.toFixed(8)} ${asset} (${multiplier * 100}% of position)`);
    const result = await kraken.marketSell(pair, volume);
    if (result?.success) {
      log(`[SELL-UI] Successfully sold ${asset} at market`);
      await new Promise(r => setTimeout(r, 2000));
      await kraken.fetchNewTrades();
      await kraken.fetchBalance();
      await kraken.fetchOrders();
      broadcast('state', getFullState());
      return { success: true, asset, message: `Sold all ${position.displayName} at market` };
    }
    const errMsg = result?.error || '';
    if (multiplier < 0.99 || (!errMsg.includes('volume') && !errMsg.includes('Insufficient funds'))) {
      return { success: false, error: `Sell failed: ${errMsg}` };
    }
    log(`[SELL-UI] Sell at ${multiplier * 100}% failed (${errMsg}), retrying...`);
    await new Promise(r => setTimeout(r, 500));
  }

  return { success: false, error: 'Sell failed after all volume attempts' };
}

/**
 * Get detailed trading information for a specific asset
 */
function getAssetDetails(assetName) {
  const normalizedAsset = assetName.toUpperCase().trim();
  
  // Find matching pair
  const pair = kraken.findPairForAsset(normalizedAsset);
  
  // Get ticker data
  const ticker = pair ? state.ticker[pair] : null;
  
  // Get position info
  const positions = kraken.getEnrichedPositions();
  let position = null;
  
  // Try to find position
  for (const key of Object.keys(positions)) {
    if (key === normalizedAsset) {
      position = { asset: key, ...positions[key] };
      break;
    }
  }
  
  // Get cost basis info from trade analytics
  const assetActivity = (state.tradeAnalytics.recentActivity || [])
    .filter(t => {
      return t.asset === normalizedAsset || t.asset === assetName;
    });
  
  const costBasisInfo = position ? {
    avgEntryPrice: position.avgCost,
    unrealizedPnL: position.unrealizedPnL,
    unrealizedPnLPct: position.unrealizedPct,
    holdingDays: position.holdingDays,
    realizedPnL: assetActivity.reduce((sum, t) => sum + t.pnl, 0),
    completedTradesCount: assetActivity.length
  } : null;
  
  // Get all known trades for this asset (both buys and sells)
  const assetTrades = Object.entries(state.fullTradeHistory.trades)
    .filter(([id, trade]) => {
      const tradePair = trade.pair;
      const tradeAsset = kraken.getAssetFromPair(tradePair);
      return tradeAsset === normalizedAsset || tradePair === pair;
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
    .sort((a, b) => b.time - a.time);
  
  // Get open orders for this asset
  // Orders use altname, convert to internal for comparison
  const internalPair = kraken.toInternalPair(pair);
  const openOrders = Object.entries(state.orders)
    .filter(([id, order]) => {
      const orderPair = order.descr?.pair || '';
      const internalOrderPair = kraken.toInternalPair(orderPair);
      return internalOrderPair === internalPair;
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
      return t.asset === normalizedAsset || t.asset === assetName;
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
    displayName: kraken.getAssetDisplayName(normalizedAsset),
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
      range24hPct: ticker.range24hPct,
      change24hPct: ticker.change24hPct,
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
    
    // All known trades for this asset
    recentTrades: assetTrades,
    openOrders,
    closedPnL
  };
}

function getFullState() {
  const positions = kraken.getEnrichedPositions();
  
  // Transform orders to include displayName
  const ordersWithDisplayNames = {};
  for (const [id, order] of Object.entries(state.orders || {})) {
    const pair = order.descr?.pair || '';
    const internalPair = kraken.toInternalPair(pair);
    const baseAsset = internalPair ? kraken.getAssetFromPair(internalPair) : pair;
    ordersWithDisplayNames[id] = {
      ...order,
      asset: baseAsset,
      displayName: kraken.getAssetDisplayName(baseAsset)
    };
  }
  
  // Transform trades to include displayName
  const tradesWithDisplayNames = (state.trades || []).slice(0, 50).map(t => {
    const internalPair = kraken.toInternalPair(t.pair);
    const baseAsset = internalPair ? kraken.getAssetFromPair(internalPair) : t.pair;
    return {
      ...t,
      asset: baseAsset,
      displayName: kraken.getAssetDisplayName(baseAsset)
    };
  });
  
  // Transform ticker to include displayName for each pair
  const tickerWithDisplayNames = {};
  for (const [pair, data] of Object.entries(state.ticker || {})) {
    const baseAsset = kraken.getAssetFromPair(pair);
    tickerWithDisplayNames[pair] = {
      ...data,
      asset: baseAsset,
      displayName: kraken.getAssetDisplayName(baseAsset)
    };
  }
  
  return {
    // Balances
    balance: state.tradeBalance,
    wallet: state.wallet,
    
    // Market
    ticker: tickerWithDisplayNames,
    greedIndex: state.greedIndex,
    greedClass: state.greedClassification,
    globalMarket: state.globalMarket,
    
    // Trading
    orders: ordersWithDisplayNames,
    trades: tradesWithDisplayNames,
    positions,
    ledgers: state.ledgers || [],
    
    // Analytics
    analytics: state.tradeAnalytics.summary,
    recentPnL: state.tradeAnalytics.recentActivity?.slice(0, 50) || [],
    
    // AI
    analysis: state.llmAnalysis,
    insights: state.insights || [],
    aiExecutions: (state.aiExecutionHistory?.executions || []).slice(-50).reverse(),
    
    // News
    news: state.news || { crypto: [], kraken: [], world: [], lastUpdate: null },
    
    // Balance history for chart
    balanceHistory: state.balanceHistory || [],
    
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
  
  // Periodic state broadcasts to keep frontend responsive
  setInterval(() => {
    if (clients.size > 0) {
      broadcast('state', getFullState());
    }
  }, 15000);
}

module.exports = {
  start,
  broadcast,
  getFullState
};
