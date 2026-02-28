#!/usr/bin/env node
// @ts-check
/**
 * Kraken Trading Bot - Entry Point
 * Clean architecture with modular components
 */

require('dotenv').config();

const { state, log, loadAllState, recordBalanceSnapshot } = require('./src/state');
const kraken = require('./src/kraken');
const ai = require('./src/ai');
const server = require('./src/server');

// ============================================
// CONFIGURATION
// ============================================

const config = {
  krakenKey: process.env.KRAKEN_KEY,
  krakenSecret: process.env.KRAKEN_PASSCODE,
  llmProvider: process.env.LLM_PROVIDER || 'ollama',
  openrouterKey: process.env.OPENROUTER_API_KEY,
  llmModel: process.env.LLM_MODEL || 'qwen3.5:cloud',
  ollamaHost: process.env.OLLAMA_HOST || 'localhost',
  ollamaPort: parseInt(process.env.OLLAMA_PORT) || 11434,
  port: process.env.PORT || 8000,
  aiEnabled: process.env.AI_ENABLED !== 'false',
  analysisIntervalMinutes: parseFloat(process.env.ANALYSIS_INTERVAL_MINUTES) || 10,
  countryCode: process.env.COUNTRY_CODE || null
};

// ============================================
// VALIDATION
// ============================================

if (!config.krakenKey || !config.krakenSecret) {
  console.error('ERROR: Missing KRAKEN_KEY or KRAKEN_PASSCODE in .env');
  process.exit(1);
}

const canUseAI = config.llmProvider === 'ollama' || config.openrouterKey;
if (!canUseAI) {
  console.warn('WARNING: No LLM provider configured - AI analysis will be disabled');
}

// ============================================
// INITIALIZATION
// ============================================

async function init() {
  log('='.repeat(50));
  log('Kraken Trading Bot Starting...');
  log('='.repeat(50));
  
  // Load persisted state
  loadAllState();
  
  // Initialize Kraken API
  kraken.init(config.krakenKey, config.krakenSecret, config.countryCode);
  
  // Initialize AI module
  if (canUseAI) {
    ai.init({
      provider: config.llmProvider,
      apiKey: config.openrouterKey,
      model: config.llmModel,
      ollamaHost: config.ollamaHost,
      ollamaPort: config.ollamaPort
    });
    ai.setEnabled(config.aiEnabled);
    ai.setInterval(config.analysisIntervalMinutes);
  }
  
  // Fetch initial data
  log('[INIT] Fetching trading pairs...');
  await kraken.fetchPairs();
  
  log('[INIT] Fetching market data...');
  await kraken.refreshAll();
  
  // Fetch initial context (global market, news) for dashboard
  if (canUseAI) {
    await ai.initContext();
  }
  
  // Start HTTP/WebSocket server immediately
  server.start();
  
  // Fetch trade history in background (can take a while)
  log('[INIT] Fetching trade history (background)...');
  kraken.fetchAllTradeHistory().then(() => {
    log('[INIT] Trade history loaded');
    server.broadcast('state', server.getFullState());
  });
  
  log('[INIT] Bot ready!');
  log(`[INIT] Balance: ${state.tradeBalance.toFixed(2)} EUR`);
  log(`[INIT] Pairs: ${Object.keys(state.pairs).length}`);
  log(`[INIT] Greed Index: ${state.greedIndex}% (${state.greedClassification})`);
}

// ============================================
// SCHEDULED TASKS
// ============================================

function startScheduledTasks() {
  log('[SCHEDULER] Starting scheduled tasks...');
  
  // Refresh all data every 60 seconds, then broadcast once
  const refreshInterval = setInterval(async () => {
    try {
      await kraken.fetchTicker();
      await kraken.fetchBalance();
      await kraken.fetchOrders();
      await kraken.fetchGreedIndex();
      server.broadcast('state', server.getFullState());
    } catch (e) {
      console.error('[SCHEDULER] Refresh error:', e.message);
    }
  }, 60 * 1000);
  
  // Sync new trades every 5 minutes (rate-limited, uses cached data)
  const tradesInterval = setInterval(async () => {
    try {
      await kraken.fetchNewTrades();
      server.broadcast('state', server.getFullState());
    } catch (e) {
      console.error('[SCHEDULER] Trades sync error:', e.message);
    }
  }, 5 * 60 * 1000);
  
  // Record balance snapshot every 30 minutes for 7-day chart
  const balanceSnapshotInterval = setInterval(() => {
    try {
      const btcPrice = state.ticker?.['XXBTZEUR']?.price || 0;
      if (state.tradeBalance > 0) {
        recordBalanceSnapshot(state.tradeBalance, btcPrice);
        log('[SCHEDULER] Balance snapshot recorded for chart');
      }
    } catch (e) {
      console.error('[SCHEDULER] Balance snapshot error:', e.message);
    }
  }, 30 * 60 * 1000); // Every 30 minutes
  
  // Record initial snapshot after data is loaded
  setTimeout(() => {
    try {
      const btcPrice = state.ticker?.['XXBTZEUR']?.price || 0;
      if (state.tradeBalance > 0) {
        recordBalanceSnapshot(state.tradeBalance, btcPrice);
        log('[SCHEDULER] Initial balance snapshot recorded');
      }
    } catch (e) {
      console.error('[SCHEDULER] Initial snapshot error:', e.message);
    }
  }, 5000); // 5 seconds after startup
  
  // Ensure intervals are not garbage collected
  refreshInterval.unref && refreshInterval.ref();
  tradesInterval.unref && tradesInterval.ref();
  balanceSnapshotInterval.unref && balanceSnapshotInterval.ref();
  
  // Run AI analysis based on configured interval
  if (canUseAI && config.aiEnabled) {
    const intervalMs = config.analysisIntervalMinutes * 60 * 1000;
    
    // Run initial analysis after 30 seconds
    setTimeout(async () => {
      try {
        log('[SCHEDULER] Running initial AI analysis...');
        await ai.runAnalysis(true);  // force=true to bypass cooldown
        server.broadcast('state', server.getFullState());
        log('[SCHEDULER] Initial AI analysis complete');
      } catch (e) {
        console.error('[SCHEDULER] AI analysis error:', e.message);
      }
    }, 30 * 1000);
    
    // Then run periodically
    setInterval(async () => {
      try {
        log('[SCHEDULER] Running scheduled AI analysis...');
        await ai.runAnalysis(true);  // force=true to bypass cooldown
        server.broadcast('state', server.getFullState());
        log('[SCHEDULER] Scheduled AI analysis complete');
      } catch (e) {
        console.error('[SCHEDULER] AI analysis error:', e.message);
      }
    }, intervalMs);
    
    log(`[SCHEDULER] AI analysis scheduled every ${config.analysisIntervalMinutes}m (${intervalMs}ms)`);
  } else {
    log(`[SCHEDULER] AI analysis disabled (provider: ${config.llmProvider}, enabled: ${config.aiEnabled})`);
  }
  
  log('[SCHEDULER] Background tasks started');
}

// ============================================
// MAIN
// ============================================

init()
  .then(() => {
    startScheduledTasks();
  })
  .catch((err) => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('[SHUTDOWN] Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('[SHUTDOWN] Received SIGTERM, shutting down...');
  process.exit(0);
});
