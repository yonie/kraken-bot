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
    
    if (parsed.insight && parsed.insight.length > 5) {
      state.insights.unshift({
        insight: parsed.insight,
        time: Date.now(),
        sentiment: parsed.sentiment
      });
      if (state.insights.length > 50) {
        state.insights = state.insights.slice(0, 50);
      }
      saveInsights();
      log(`[AI] New insight stored: ${parsed.insight}`);
    }
    
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
  
  return `=== TIME ===
${ctx.sessionInfo.utcTime}
Session: ${ctx.sessionInfo.session}${ctx.sessionInfo.isWeekend ? ' (Weekend)' : ''}

=== GLOBAL MARKET ===
Market Cap: ${ctx.globalMarket?.marketCap ? `$${(ctx.globalMarket.marketCap / 1e12).toFixed(2)}T` : 'N/A'} (${ctx.globalMarket?.marketCapChange24h?.toFixed(1) || 0}% 24h)
BTC Dominance: ${ctx.globalMarket?.btcDominance?.toFixed(1) || 'N/A'}% | ETH Dominance: ${ctx.globalMarket?.ethDominance?.toFixed(1) || 'N/A'}%
24h Volume: ${ctx.globalMarket?.volume24h ? `$${(ctx.globalMarket.volume24h / 1e9).toFixed(1)}B` : 'N/A'}
Fear/Greed: ${ctx.greedIndex}% (${ctx.greedClass})
Market Breadth: ${ctx.marketBreadth.up} up / ${ctx.marketBreadth.down} down (${ctx.marketBreadth.total} total)

=== BTC ===
Price: ${ctx.btcPrice ? ctx.btcPrice.toFixed(0) + ' EUR' : 'N/A'}
24h Change: ${state.ticker['XXBTZEUR']?.change24hPct >= 0 ? '+' : ''}${state.ticker['XXBTZEUR']?.change24hPct || 0}% | Range: ${state.ticker['XXBTZEUR']?.low24?.toFixed(0) || 'N/A'}-${state.ticker['XXBTZEUR']?.high24?.toFixed(0) || 'N/A'} EUR (${state.ticker['XXBTZEUR']?.range24hPct || 0}%)
${ctx.btcOHLC?.length > 0 ? `7d close: ${ctx.btcOHLC.map(c => c.close.toFixed(0)).join(' -> ')}` : ''}
${btcDepthStr}

=== ETH ===
Price: ${ctx.ethPrice ? ctx.ethPrice.toFixed(0) + ' EUR' : 'N/A'}
24h Change: ${state.ticker['XETHZEUR']?.change24hPct >= 0 ? '+' : ''}${state.ticker['XETHZEUR']?.change24hPct || 0}% | Range: ${state.ticker['XETHZEUR']?.low24?.toFixed(0) || 'N/A'}-${state.ticker['XETHZEUR']?.high24?.toFixed(0) || 'N/A'} EUR (${state.ticker['XETHZEUR']?.range24hPct || 0}%)
${ctx.ethOHLC?.length > 0 ? `7d close: ${ctx.ethOHLC.map(c => c.close.toFixed(0)).join(' -> ')}` : ''}

=== NEWS ===
[WORLD]
${ctx.news.world?.items?.slice(0, 5).map(item => `  ${item.title}${item.age ? ` (${item.age})` : ''}`).join('\n') || '  No recent world news'}
[CRYPTO]
${ctx.news.crypto?.items?.slice(0, 5).map(item => `  ${item.title}${item.age ? ` (${item.age})` : ''}`).join('\n') || '  No recent crypto news'}
[KRAKEN]
${ctx.news.kraken?.items?.slice(0, 5).map(item => `  ${item.title}${item.age ? ` (${item.age})` : ''}`).join('\n') || '  No recent Kraken updates'}

=== PORTFOLIO ===
Total: ${ctx.totalPortfolio} EUR | Cash: ${ctx.eurCash} EUR (${ctx.cashPct}%) | Invested: ${ctx.investedValue} EUR
Unrealized P&L: ${ctx.unrealizedPnL} EUR
7d Change: ${ctx.weekChangeEUR || 'N/A'}% EUR | ${ctx.weekChangeBTC || 'N/A'}% BTC-adjusted
${ctx.balanceHistory.length > 0 ? `History: ${ctx.balanceHistory.map(h => h.eur).join(' -> ')} EUR` : 'No history'}

=== POSITIONS (${ctx.positions.length}) ===
${ctx.positions.map(formatPosition).join('\n\n') || 'None'}

=== YOUR PERFORMANCE (30d) ===
${ctx.analytics.totalTrades || 0} trades | ${ctx.analytics.winRate?.toFixed(0) || 0}% win rate | Realized: ${ctx.analytics.realizedPnL?.toFixed(2) || 0} EUR
By asset: ${Object.entries(ctx.assetPerformance).slice(0, 10).map(([a, s]) => `${a} ${s.winRate}% win (${s.trades}t)`).join(', ') || 'No trades'}

=== OPEN ORDERS (${ctx.openOrders.length}) ===
${ctx.openOrders.map(o => `[${o.id}] ${o.type?.toUpperCase()} ${o.asset}: ${o.volume} @ ${o.price} EUR (placed ${o.created})`).join('\n') || 'None'}

=== TOP 20 BY VOLUME ===
${ctx.topByVolume.slice(0, 20).map(m => {
  const p = m.price < 1 ? 6 : 2;
  const ohlc = ctx.ohlcData && ctx.ohlcData[m.pair] ? ctx.ohlcData[m.pair].map(c => c.close.toFixed(p)).join('->').substring(0, 50) : '';
  return `${m.pair.replace(/Z?EUR$/, '')}: ${m.price?.toFixed(p)} | 24h: ${m.low24?.toFixed(p)}-${m.high24?.toFixed(p)} (range ${m.range24hPct}%) | Vol: ${m.volumeEur?.toFixed(0) || 0} EUR${ohlc ? ` | 7d: ${ohlc}` : ''}`;
}).join('\n')}

=== TOP 10 MOVERS (24h change) ===
${ctx.movers.slice(0, 10).map(m => {
  const p = m.price < 1 ? 6 : 2;
  return `${m.pair.replace(/Z?EUR$/, '')}: ${m.price?.toFixed(p)} (${m.change24hPct >= 0 ? '+' : ''}${m.change24hPct}%) | Vol: ${m.volumeEur?.toFixed(0) || 0} EUR`;
}).join('\n')}

=== RECENT TRADES (7d) ===
${ctx.recentTrades.slice(0, 10).map(t => `[${t.time}] ${t.type.toUpperCase()} ${t.pair}: ${t.volume} @ ${t.price} = ${t.cost} EUR`).join('\n') || 'None'}

${ctx.recentLedgers && ctx.recentLedgers.length > 0 ? `=== DEPOSITS/WITHDRAWALS (7d) ===
${ctx.recentLedgers.map(l => `[${l.timestamp}] ${l.type.toUpperCase()}: ${l.amount.toFixed(l.asset === 'ZEUR' ? 2 : 6)} ${l.asset.replace('Z', '')}${l.fee > 0 ? ` (fee: ${l.fee})` : ''}`).join('\n')}` : ''}

=== PREVIOUS DECISIONS ===
${ctx.previousDecisions.map(d => `[${d.time}] ${d.sentiment}/${d.risk} | ${d.commands}`).join('\n') || 'None'}

=== EXECUTION RESULTS ===
${ctx.recentExecutionResults.map(e => `[${e.time}] ${e.action} -> ${e.result}${e.error ? ` (${e.error})` : ''}`).join('\n') || 'None'}

=== RESPONSE FORMAT ===
SENTIMENT: [bullish/neutral/bearish]
RISK: [low/medium/high]

ANALYSIS: [Your reasoning. Reference specific data.]

INSIGHT: [Optional: ONE trading pattern. Before writing, COMPARE your idea against existing insights below. If your idea is similar to ANY existing insight (same topic, same lesson), skip this field entirely. Only provide an insight that covers a NEW topic not mentioned below. Max 80 chars, no personal pronouns.]
${ctx.insights && ctx.insights.length > 0 ? `
=== EXISTING INSIGHTS (skip if your idea is similar to any of these) ===
${ctx.insights.slice(0, 15).map(i => `• ${i.insight}`).join('\n')}` : ''}

REQUEST: [Optional: ONE piece of data you wish you had for better decisions. Examples: "BTC RSI indicator", "order book depth for XBT", "ETH/BTC correlation". Skip if nothing needed.]

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
  const analysisMatch = response.match(/ANALYSIS:\s*(.+?)(?=\n\s*(COMMANDS|INSIGHT|REQUEST):|\n\n|$)/is);
  const insightMatch = response.match(/INSIGHT:\s*(.+?)(?=\n\s*(COMMANDS|REQUEST):|\n\n|$)/is);
  const requestMatch = response.match(/REQUEST:\s*(.+?)(?=\n\s*(COMMANDS|INSIGHT):|\n\n|$)/is);
  const commandsMatch = response.match(/COMMANDS:\s*([\s\S]*?)(?=\n\n|$)/i);
  
  return {
    sentiment: sentimentMatch?.[1]?.toLowerCase() || null,
    risk: riskMatch?.[1]?.toLowerCase() || null,
    analysis: analysisMatch?.[1]?.trim() || null,
    insight: insightMatch?.[1]?.trim() || null,
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