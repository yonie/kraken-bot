// @ts-check
/**
 * Shared State Management
 * Central state store for all bot data
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============================================
// STATE
// ============================================

const state = {
  // Kraken data
  pairs: {},              // Trading pairs info
  assetToPairMap: {},     // Asset -> pair mapping (e.g., "ETH" -> "XETHZEUR")
  ticker: {},             // Current prices
  wallet: {},             // Balances
  orders: {},             // Open orders
  trades: [],             // Recent trades
  tradeBalance: 0,        // Total EUR balance
  
  // Market data
  greedIndex: null,
  greedClassification: null,
  
  // Balance history for charts (7-day portfolio tracking)
  balanceHistory: [],     // Array of { timestamp, balanceEUR, balanceBTC, btcPrice }
  
  // Analytics
  fullTradeHistory: { trades: {}, lastFetchTime: null, totalCount: 0 },
  costBasis: {},
  tradeAnalytics: {
    lastUpdate: null,
    summary: { totalTrades: 0, realizedPnL: 0, winningTrades: 0, losingTrades: 0 },
    recentActivity: []
  },
  // AI state
  llmAnalysis: { lastUpdate: null, marketSentiment: null, analysis: null, commands: null, raw: null },
  llmHistory: [],
  aiExecutionHistory: { executions: [], dailyCount: 0, lastResetDate: null },
  
  // Server state
  logs: [],
  serverStartTime: Date.now()
};

// ============================================
// PERSISTENCE
// ============================================

const FILES = {
  tradeHistory: path.join(DATA_DIR, 'full_trade_history.json'),
  costBasis: path.join(DATA_DIR, 'cost_basis.json'),
  analytics: path.join(DATA_DIR, 'trade_analytics.json'),
  llmAnalysis: path.join(DATA_DIR, 'llm_analysis.json'),
  llmHistory: path.join(DATA_DIR, 'llm_history.json'),
  aiExecutions: path.join(DATA_DIR, 'ai_executions.json'),
  balanceHistory: path.join(DATA_DIR, 'balance_history.json')
};

function loadJSON(file, defaultValue = {}) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error(`Error loading ${file}:`, e.message);
  }
  return defaultValue;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Error saving ${file}:`, e.message);
  }
}

function loadAllState() {
  state.fullTradeHistory = loadJSON(FILES.tradeHistory, state.fullTradeHistory);
  state.costBasis = loadJSON(FILES.costBasis, {});
  state.tradeAnalytics = loadJSON(FILES.analytics, state.tradeAnalytics);
  state.llmAnalysis = loadJSON(FILES.llmAnalysis, state.llmAnalysis);
  state.llmHistory = loadJSON(FILES.llmHistory, []);
  state.aiExecutionHistory = loadJSON(FILES.aiExecutions, state.aiExecutionHistory);
  
  // Load balance history with migration from old object format to new array format
  const loadedHistory = loadJSON(FILES.balanceHistory, []);
  if (Array.isArray(loadedHistory)) {
    state.balanceHistory = loadedHistory;
  } else if (typeof loadedHistory === 'object' && loadedHistory !== null) {
    // Migrate from old format: { "2026-01-12T22": "3498.10", ... } to new array format
    state.balanceHistory = Object.entries(loadedHistory).map(([dateKey, value]) => {
      // Parse the date key (format: "2026-01-12T22" means Jan 12, 2026 at 22:00)
      const timestamp = new Date(dateKey + ':00:00').getTime();
      const balanceEUR = parseFloat(value);
      return {
        timestamp,
        balanceEUR,
        balanceBTC: 0, // Old format didn't store BTC
        btcPrice: 0
      };
    }).filter(entry => !isNaN(entry.timestamp) && !isNaN(entry.balanceEUR))
      .sort((a, b) => a.timestamp - b.timestamp);
    console.log(`[STATE] Migrated ${state.balanceHistory.length} balance history entries to new format`);
  } else {
    state.balanceHistory = [];
  }
  
  console.log('[STATE] Loaded persisted state');
}

function saveTradeHistory() { saveJSON(FILES.tradeHistory, state.fullTradeHistory); }
function saveCostBasis() { saveJSON(FILES.costBasis, state.costBasis); }
function saveAnalytics() { saveJSON(FILES.analytics, state.tradeAnalytics); }
function saveLLMAnalysis() { saveJSON(FILES.llmAnalysis, state.llmAnalysis); }
function saveLLMHistory() { saveJSON(FILES.llmHistory, state.llmHistory); }
function saveAIExecutions() { saveJSON(FILES.aiExecutions, state.aiExecutionHistory); }
function saveBalanceHistory() { saveJSON(FILES.balanceHistory, state.balanceHistory); }

/**
 * Record current balance snapshot for chart history
 * Stores EUR balance, BTC equivalent, and BTC price
 * Keeps only last 7 days of hourly data points
 */
function recordBalanceSnapshot(balanceEUR, btcPrice) {
  const now = Date.now();
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
  
  // Calculate BTC equivalent
  const balanceBTC = btcPrice > 0 ? balanceEUR / btcPrice : 0;
  
  // Add new snapshot
  state.balanceHistory.push({
    timestamp: now,
    balanceEUR,
    balanceBTC,
    btcPrice
  });
  
  // Remove entries older than 7 days
  state.balanceHistory = state.balanceHistory.filter(entry => entry.timestamp > sevenDaysAgo);
  
  // Save to disk
  saveBalanceHistory();
}

// ============================================
// LOGGING
// ============================================

const MAX_LOGS = 500;

function log(message, pair = '') {
  const timestamp = new Date().toLocaleString();
  const fullMessage = `${timestamp} ${pair ? pair + ' ' : ''}${message}`;
  console.log(fullMessage);
  state.logs.unshift(fullMessage);
  if (state.logs.length > MAX_LOGS) {
    state.logs = state.logs.slice(0, MAX_LOGS);
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  state,
  DATA_DIR,
  
  // Persistence
  loadAllState,
  saveTradeHistory,
  saveCostBasis,
  saveAnalytics,
  saveLLMAnalysis,
  saveLLMHistory,
  saveAIExecutions,
  saveBalanceHistory,
  recordBalanceSnapshot,
  
  // Logging
  log
};
