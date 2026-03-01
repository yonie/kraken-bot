// @ts-check
/**
 * Analysis Module
 * Runs LLM analysis, manages insights and questions
 */

const fs = require('fs');
const path = require('path');
const { state, log, saveLLMAnalysis, saveLLMHistory, saveAIExecutions, saveInsights, saveQuestions, DATA_DIR } = require('../state');
const kraken = require('../kraken');
const { callLLM, setConfig, getConfig } = require('./llm');
const { buildContext } = require('./context');
const { parseCommands, executeCommands } = require('./commands');

let config = {
  provider: 'openrouter',
  apiKey: null,
  model: 'x-ai/grok-3-mini-beta',
  ollamaHost: 'localhost',
  ollamaPort: 11434,
  enabled: true,
  intervalMinutes: 10
};

function init(options = {}) {
  if (typeof options === 'string') {
    config.apiKey = options;
    if (arguments[1]) config.model = arguments[1];
  } else {
    config.provider = options.provider || config.provider;
    config.apiKey = options.apiKey || null;
    config.model = options.model || config.model;
    config.ollamaHost = options.ollamaHost || config.ollamaHost;
    config.ollamaPort = options.ollamaPort || config.ollamaPort;
  }
  
  setConfig({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    ollamaHost: config.ollamaHost,
    ollamaPort: config.ollamaPort
  });
  
  log(`[AI] Initialized with provider: ${config.provider}, model: ${config.model}`);
}

async function runAnalysis(force = false) {
  if (!force && state.llmAnalysis.lastUpdate) {
    const minutes = (Date.now() - state.llmAnalysis.lastUpdate) / 60000;
    if (minutes < config.intervalMinutes) {
      return { skipped: true, reason: 'cooldown' };
    }
  }
  
  log('[AI] Running market analysis...');
  
  await kraken.refreshAll();
  
  const ctx = await buildContext();
  
  if (!ctx.totalPortfolio || !ctx.greedIndex) {
    return { skipped: true, reason: 'insufficient_data' };
  }
  
  const prompt = buildPrompt(ctx);
  
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'llm_prompt_latest.txt'), prompt, 'utf8');
  } catch (e) {}
  
  try {
    const response = await callLLM(prompt);
    
    if (!response) {
      return { success: false, reason: 'empty_response' };
    }
    
    const parsed = parseResponse(response);
    
    state.llmAnalysis = {
      lastUpdate: Date.now(),
      marketSentiment: parsed.sentiment,
      riskAssessment: parsed.risk,
      analysis: parsed.analysis,
      commands: parsed.commands,
      raw: response
    };
    
    saveLLMAnalysis();
    
    if (parsed.request && parsed.request.length > 5) {
      state.questions.unshift({
        request: parsed.request,
        time: Date.now()
      });
      if (state.questions.length > 20) {
        state.questions = state.questions.slice(0, 20);
      }
      saveQuestions();
      log(`[AI] New question stored: ${parsed.request}`);
    }
    
    state.llmHistory.unshift({ ...state.llmAnalysis, id: Date.now() });
    if (state.llmHistory.length > 100) {
      state.llmHistory = state.llmHistory.slice(0, 100);
    }
    saveLLMHistory();
    
    log(`[AI] Analysis: ${state.llmAnalysis.marketSentiment} sentiment, ${state.llmAnalysis.riskAssessment} risk`);
    
    if (config.enabled && state.llmAnalysis.commands !== 'HOLD') {
      const actions = parseCommands(state.llmAnalysis.raw);
      if (actions.length > 0) {
        const results = await executeCommands(actions);
        const success = results.filter(r => r.success).length;
        log(`[AI-EXEC] Executed ${success}/${results.length} trades`);
        
        if (success > 0) {
          setTimeout(() => kraken.refreshAll(), 3000);
        }
        
        return { success: true, analysis: state.llmAnalysis, executions: results };
      }
    }
    
    return { success: true, analysis: state.llmAnalysis };
    
  } catch (e) {
    console.error('[AI] Analysis failed:', e.message);
    return { success: false, error: e.message };
  }
}

function buildPrompt(ctx) {
  const formatPosition = (p) => {
    if (p.isCash) {
      return `${p.asset}: ${p.amount} EUR (${p.value} EUR total)`;
    }
    
    const t = p.ticker || {};
    const priceStr = t.price ? (t.price < 1 ? t.price.toFixed(6) : t.price.toFixed(2)) : 'N/A';
    const bidStr = t.bid ? (t.bid < 1 ? t.bid.toFixed(6) : t.bid.toFixed(2)) : 'N/A';
    const askStr = t.ask ? (t.ask < 1 ? t.ask.toFixed(6) : t.ask.toFixed(2)) : 'N/A';
    const lowStr = t.low24 ? (t.low24 < 1 ? t.low24.toFixed(6) : t.low24.toFixed(2)) : 'N/A';
    const highStr = t.high24 ? (t.high24 < 1 ? t.high24.toFixed(6) : t.high24.toFixed(2)) : 'N/A';
    const vwapStr = t.vwap ? (t.vwap < 1 ? t.vwap.toFixed(6) : t.vwap.toFixed(2)) : 'N/A';
    
    let lines = [`${p.asset}: ${p.amount} tokens = ${p.value} EUR`];
    lines.push(`  P&L: ${p.pnl} EUR (${p.pnlPct}) | Held ${p.days}d | Entry: ${p.avgEntry}`);
    lines.push(`  Price: ${priceStr} | Bid: ${bidStr} | Ask: ${askStr} | Spread: ${t.spreadPct?.toFixed(2) || 'N/A'}%`);
    lines.push(`  24h: ${lowStr}-${highStr} (${t.distFromLow || 0}% from low, ${t.range24hPct || 0}% range) | VWAP: ${vwapStr} | Vol: ${t.volumeEur?.toFixed(0) || 'N/A'} EUR`);
    
    if (p.ohlc && p.ohlc.length > 0) {
      lines.push(`  7d close: ${p.ohlc.join(' -> ')}`);
    }
    
    if (p.depth) {
      const bidWalls = p.depth.bidWalls?.map(w => `${w.price.toFixed(t.price < 1 ? 6 : 2)} (${w.volume.toFixed(1)})`).join(', ') || 'none';
      const askWalls = p.depth.askWalls?.map(w => `${w.price.toFixed(t.price < 1 ? 6 : 2)} (${w.volume.toFixed(1)})`).join(', ') || 'none';
      lines.push(`  Depth: ${p.depth.bidDepth5pct?.toFixed(0) || 0} EUR bid / ${p.depth.askDepth5pct?.toFixed(0) || 0} EUR ask to 5%`);
      lines.push(`  Walls - Bid: ${bidWalls} | Ask: ${askWalls}`);
    }
    
    if (p.performance && p.performance.trades > 0) {
      lines.push(`  Your stats: ${p.performance.trades} trades, ${p.performance.winRate}% win, avg +${p.performance.avgWin}/-${p.performance.avgLoss} EUR`);
    }
    
    return lines.join('\n');
  };
  
  const btcDepthStr = ctx.btcDepth ? 
    `Depth: ${(ctx.btcDepth.bidDepth5pct / 1000000).toFixed(2)}M EUR bid / ${(ctx.btcDepth.askDepth5pct / 1000000).toFixed(2)}M EUR ask to 5%` : '';
  
  const newsWorld = ctx.news.world?.items?.slice(0, 5).map(item => item.title) || [];
  const newsCrypto = ctx.news.crypto?.items?.slice(0, 5).map(item => item.title) || [];
  const newsKraken = ctx.news.kraken?.items?.slice(0, 5).map(item => item.title) || [];
  
  const topByVolumeFormatted = ctx.topByVolume.slice(0, 20).map(m => ({
    pair: m.pair.replace(/Z?EUR$/, ''),
    price: m.price,
    low_24h: m.low24,
    high_24h: m.high24,
    range_24h_pct: m.range24hPct,
    volume_eur: m.volumeEur,
    ohlc_7d: ctx.ohlcData && ctx.ohlcData[m.pair] ? ctx.ohlcData[m.pair].map(c => c.close) : null
  }));
  
  const moversFormatted = ctx.movers.slice(0, 10).map(m => ({
    pair: m.pair.replace(/Z?EUR$/, ''),
    price: m.price,
    change_24h_pct: m.change24hPct,
    volume_eur: m.volumeEur
  }));
  
  const recentTradesFormatted = ctx.recentTrades.slice(0, 10).map(t => ({
    time: t.time,
    type: t.type,
    asset: t.pair,
    volume: parseFloat(t.volume),
    price: parseFloat(t.price),
    eur: parseFloat(t.cost)
  }));
  
  const depositsFormatted = (ctx.recentLedgers || []).map(l => ({
    time: l.timestamp,
    type: l.type,
    asset: l.asset.replace('Z', ''),
    amount: l.amount,
    fee: l.fee
  }));
  
  const executionResultsFormatted = ctx.recentExecutionResults.map(e => ({
    time: e.time,
    action: e.action,
    result: e.result,
    error: e.error
  }));
  
  const positionsFormatted = ctx.positions.map(p => {
    if (p.isCash) {
      return { asset: 'EUR', amount: parseFloat(p.amount), value_eur: parseFloat(p.value) };
    }
    const t = p.ticker || {};
    return {
      asset: p.asset,
      amount: p.amount,
      value_eur: parseFloat(p.value),
      unrealized_pnl_eur: parseFloat(p.pnl),
      unrealized_pnl_pct: parseFloat(p.pnlPct.replace('%', '')),
      holding_days: p.days,
      entry_price: parseFloat(p.avgEntry),
      current_price: t.price,
      bid: t.bid,
      ask: t.ask,
      spread_pct: t.spreadPct,
      low_24h: t.low24,
      high_24h: t.high24,
      dist_from_low_pct: t.distFromLow,
      range_24h_pct: t.range24hPct,
      vwap: t.vwap,
      volume_eur: t.volumeEur,
      ohlc_7d: p.ohlc ? p.ohlc.map(c => parseFloat(c)) : null,
      depth: p.depth ? {
        bid_depth_5pct: p.depth.bidDepth5pct,
        ask_depth_5pct: p.depth.askDepth5pct,
        bid_walls: p.depth.bidWalls,
        ask_walls: p.depth.askWalls
      } : null
    };
  });
  
  const jsonData = JSON.stringify({
    strategy: {
      goal: "Outperform BTC. Target +10% portfolio DAILY.",
      approach: "Aggressive swing trading. High risk, quick rewards. Capitalize on crypto volatility.",
      rules: [
        "Spread positions across 5-15 assets (guideline, not strict)",
        "Individual position size: typically €50-500 per asset based on conviction and liquidity",
        "Diversify across assets - avoid over-concentration in any single position",
        "Extreme Fear (<25) is typically a BUY signal - deploy capital across multiple assets",
        "Extreme Greed (>75) is typically a SELL signal - take profits across positions",
        "Cash sitting idle during a dip = missed opportunity, not prudence",
        "Fresh deposits should be deployed quickly when conditions align",
        "HOLD is only acceptable when fully invested in a winning position",
        "Check liquidity before buying - avoid low-volume assets that are hard to exit",
        "Check order book depth before buying - avoid thin order books",
        "High cash position during a dip = missed opportunity"
      ]
    },
    time: {
      utc: ctx.sessionInfo.utcTime,
      session: ctx.sessionInfo.session,
      is_weekend: ctx.sessionInfo.isWeekend
    },
    market: {
      global: {
        market_cap_usd: ctx.globalMarket?.marketCap,
        market_cap_change_24h_pct: ctx.globalMarket?.marketCapChange24h,
        btc_dominance_pct: ctx.globalMarket?.btcDominance,
        eth_dominance_pct: ctx.globalMarket?.ethDominance,
        volume_24h_usd: ctx.globalMarket?.volume24h
      },
      fear_greed_index: ctx.greedIndex,
      fear_greed_index_description: "0-25: Extreme Fear, 26-45: Fear, 46-55: Neutral, 56-75: Greed, 76-100: Extreme Greed",
      market_breadth: {
        up: ctx.marketBreadth.up,
        down: ctx.marketBreadth.down,
        total: ctx.marketBreadth.total
      },
      btc: {
        price_eur: ctx.btcPrice,
        change_24h_pct: state.ticker['XXBTZEUR']?.change24hPct,
        low_24h: state.ticker['XXBTZEUR']?.low24,
        high_24h: state.ticker['XXBTZEUR']?.high24,
        range_24h_pct: state.ticker['XXBTZEUR']?.range24hPct,
        ohlc_7d: ctx.btcOHLC?.slice(-7).map(c => c.close),
        rsi_14: ctx.btcRSI ? Math.round(ctx.btcRSI) : null,
        depth: ctx.btcDepth ? {
          bid_depth_5pct_eur: ctx.btcDepth.bidDepth5pct,
          ask_depth_5pct_eur: ctx.btcDepth.askDepth5pct,
          bid_walls: ctx.btcDepth.bidWalls,
          ask_walls: ctx.btcDepth.askWalls
        } : null
      },
      eth: {
        price_eur: ctx.ethPrice,
        change_24h_pct: state.ticker['XETHZEUR']?.change24hPct,
        low_24h: state.ticker['XETHZEUR']?.low24,
        high_24h: state.ticker['XETHZEUR']?.high24,
        range_24h_pct: state.ticker['XETHZEUR']?.range24hPct,
        ohlc_7d: ctx.ethOHLC?.map(c => c.close)
      }
    },
    news: {
      crypto: newsCrypto,
      world: newsWorld,
      kraken: newsKraken
    },
    portfolio: {
      total_eur: parseFloat(ctx.totalPortfolio),
      cash_eur: parseFloat(ctx.eurCash),
      invested_eur: parseFloat(ctx.investedValue),
      cash_pct: parseFloat(ctx.cashPct),
      unrealized_pnl_eur: parseFloat(ctx.unrealizedPnL)
    },
    performance_7d: {
      portfolio_start_eur: ctx.balanceHistory[0] ? parseFloat(ctx.balanceHistory[0].eur) : null,
      portfolio_end_eur: ctx.balanceHistory[ctx.balanceHistory.length - 1] ? parseFloat(ctx.balanceHistory[ctx.balanceHistory.length - 1].eur) : null,
      net_change_eur: ctx.balanceHistory[0] && ctx.balanceHistory[ctx.balanceHistory.length - 1] 
        ? parseFloat(ctx.balanceHistory[ctx.balanceHistory.length - 1].eur) - parseFloat(ctx.balanceHistory[0].eur) 
        : null,
      deposits_eur: depositsFormatted.filter(d => d.type === 'deposit').reduce((sum, d) => sum + d.amount, 0),
      withdrawals_eur: depositsFormatted.filter(d => d.type === 'withdrawal').reduce((sum, d) => sum + d.amount, 0),
      btc_change_pct: parseFloat(ctx.btcPriceChange),
      explanation: "net_change_eur includes deposits/withdrawals. trading_pnl = net_change - deposits + withdrawals. Compare your trading_pnl to what you would have made if you held BTC instead.",
      history_eur: ctx.balanceHistory.map(h => parseFloat(h.eur))
    },
    positions: positionsFormatted,
    open_orders: ctx.openOrders.map(o => ({
      id: o.id,
      type: o.type,
      asset: o.asset,
      volume: parseFloat(o.volume),
      price: parseFloat(o.price),
      created: o.created
    })),
    top_by_volume: topByVolumeFormatted,
    top_movers_24h: moversFormatted,
    recent_trades_7d: recentTradesFormatted,
    deposits_withdrawals_7d: depositsFormatted,
    execution_results: executionResultsFormatted
  }, null, 2);
  
  return `=== DATA ===
${jsonData}

=== RESPONSE FORMAT ===
SENTIMENT: [bullish/neutral/bearish]
RISK: [low/medium/high]

ANALYSIS: [Your reasoning. Reference specific data. Be decisive.]
DECISION: [What action you're taking and WHY it aligns with the +10% daily goal]

REQUEST: [Optional: ONE piece of data you wish you had. Skip if nothing needed.]

COMMANDS:
[One command per line, or HOLD]

=== COMMAND SYNTAX ===
BUY <ASSET> <eur_amount> <price> - e.g., "BUY ETH 50 3100"
SELL <ASSET> <price> - e.g., "SELL ETH 3200" (sells ALL holdings)
CANCEL BUY <ASSET> - e.g., "CANCEL BUY ETH"
HOLD - no action this time

Note: BUY/SELL cancels existing orders for that asset first.
`;
}

function parseResponse(response) {
  const sentimentMatch = response.match(/SENTIMENT:\s*(bullish|neutral|bearish)/i);
  const riskMatch = response.match(/RISK:\s*(low|medium|high)/i);
  const analysisMatch = response.match(/ANALYSIS:\s*([\s\S]+?)(?=\n\s*(REQUEST|COMMANDS):)/i);
  const requestMatch = response.match(/REQUEST:\s*(.+?)(?=\n\s*(COMMANDS):|\n\n|$)/is);
  const commandsMatch = response.match(/COMMANDS:\s*([\s\S]*?)(?=\n\n|===|$)/i);
  
  return {
    sentiment: sentimentMatch?.[1]?.toLowerCase() || null,
    risk: riskMatch?.[1]?.toLowerCase() || null,
    analysis: analysisMatch?.[1]?.trim() || null,
    request: requestMatch?.[1]?.trim() || null,
    commands: commandsMatch?.[1]?.trim() || 'HOLD'
  };
}

async function initContext() {
  log('[AI] Fetching initial context (global market, news)...');
  try {
    const { fetchGlobalMarketData } = require('./context');
    const { fetchAllNews } = require('../news');
    await Promise.all([
      fetchGlobalMarketData(),
      fetchAllNews()
    ]);
    log('[AI] Initial context loaded');
  } catch (e) {
    console.error('[AI] Failed to load initial context:', e.message);
  }
}

module.exports = {
  init,
  runAnalysis,
  initContext,
  setEnabled: (enabled) => { config.enabled = enabled; },
  setInterval: (minutes) => { config.intervalMinutes = minutes; }
};