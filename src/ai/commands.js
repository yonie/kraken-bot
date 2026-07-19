// @ts-check
/**
 * Command Parsing & Execution Module
 * Parses LLM responses into trading commands and executes them
 */

const kraken = require('../kraken');
const { state, log, saveAIExecutions } = require('../state');

function parseCommands(raw) {
  const actions = [];
  
  // Extract commands between ---COMMANDS--- and ---END--- if present
  let text = raw;
  const blockMatch = raw.match(/---COMMANDS---\s*([\s\S]*?)---END---/i);
  if (blockMatch) {
    text = blockMatch[1];
  } else {
    // Fallback: extract from COMMANDS: section
    const commandsMatch = raw.match(/COMMANDS:\s*([\s\S]*?)(?:\n\n|$)/i);
    if (commandsMatch) {
      text = commandsMatch[1];
    }
  }
  
  const lines = text.split('\n');
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    
    // SELL <ASSET> <PRICE> - sell all holdings
    const sellMatch = trimmedLine.match(/^SELL\s+([A-Z0-9]{1,10})\s+(\d+(?:\.\d+)?)/i);
    if (sellMatch) {
      const asset = sellMatch[1].toUpperCase();
      const price = parseFloat(sellMatch[2]);
      if (asset !== 'EUR' && asset !== 'HOLD' && asset.length > 0 && price > 0) {
        actions.push({ action: 'SELL', asset, price });
        continue;
      }
    }
    
    // BUY <ASSET> <EUR> - market buy
    const buyMatch = trimmedLine.match(/^BUY\s+([A-Z0-9]{1,10})\s+(\d+(?:\.\d+)?)/i);
    if (buyMatch) {
      const asset = buyMatch[1].toUpperCase();
      const amountEur = parseFloat(buyMatch[2]);
      if (asset !== 'EUR' && asset !== 'HOLD' && asset.length > 0 && amountEur > 0) {
        actions.push({ action: 'BUY', asset, amountEur });
        continue;
      }
    }
    
    // HOLD - no action
    if (/^HOLD$/i.test(trimmedLine)) {
      actions.push({ action: 'HOLD' });
      continue;
    }
  }
  
  log(`[AI] Parsed ${actions.length} commands: ${JSON.stringify(actions)}`);
  return actions;
}



async function executeCommands(actions) {
  const results = [];
  
  for (const action of actions) {
    if (action.action === 'HOLD') {
      results.push({ action: 'HOLD', success: true });
      continue;
    }
    
    const pair = kraken.findPairForAsset(action.asset);
    if (!pair) {
      log(`[AI-EXEC] No pair found for ${action.asset}`);
      results.push({ ...action, success: false, error: 'pair_not_found' });
      continue;
    }
    
    try {
      // Cancel existing orders for this pair
      // Convert both to internal keys for comparison
      const internalPair = kraken.toInternalPair(pair);
      const existingOrders = Object.entries(state.orders).filter(([id, order]) => {
        const orderPair = order.descr?.pair;
        if (!orderPair) return false;
        const internalOrderPair = kraken.toInternalPair(orderPair);
        return internalPair && internalOrderPair && internalPair === internalOrderPair;
      });

      for (const [orderId, order] of existingOrders) {
        log(`[AI-EXEC] Cancelling existing ${order.descr?.type} order for ${pair}: ${orderId}`);
        const cancelResult = await kraken.cancelOrder(orderId);
        if (cancelResult.success) {
          log(`[AI-EXEC] Cancelled order ${orderId}`);
          delete state.orders[orderId];
        } else {
          log(`[AI-EXEC] Failed to cancel order ${orderId}: ${cancelResult.error}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }

      let result;

      if (action.action === 'SELL') {
        const baseAsset = state.pairs[pair]?.base;
        // Check for staked/standard variants (DOT.S, DOT.P, DOT)
        let holding = state.wallet[baseAsset];
        if (!holding || holding.amount <= 0) {
          // Try staked variants
          for (const suffix of ['.S', '.P']) {
            const stakedAsset = baseAsset + suffix;
            if (state.wallet[stakedAsset]?.amount > 0) {
              log(`[AI-EXEC] Found staked asset ${stakedAsset} instead of ${baseAsset}`);
              holding = state.wallet[stakedAsset];
              break;
            }
          }
        }

        log(`[AI-EXEC] SELL ${action.asset}: pair=${pair}, baseAsset=${baseAsset}, holding=${holding?.amount}, price=${action.price}`);

        if (!holding || holding.amount <= 0) {
          results.push({ ...action, success: false, error: 'no_holdings' });
          continue;
        }

        // GUARDRAIL: Never sell below avg entry price + fees (~0.48% round trip, enforcing 1% floor)
        const SELL_FLOOR_MULTIPLIER = 1.08; // 8% above entry = meaningful profit floor
        const enrichedPositions = kraken.getEnrichedPositions();
        const enrichedPos = enrichedPositions[baseAsset];
        if (enrichedPos && enrichedPos.avgCost > 0) {
          const minSellPrice = enrichedPos.avgCost * SELL_FLOOR_MULTIPLIER;
          if (action.price < minSellPrice) {
            const reason = `sell_below_floor: your limit ${action.price.toFixed(4)} < min ${minSellPrice.toFixed(4)} (entry ${enrichedPos.avgCost.toFixed(4)} + 8%). Raise your sell price.`;
            log(`[GUARDRAIL] SELL ${action.asset} blocked: ${reason}`);
            state.aiExecutionHistory.executions.push({ timestamp: Date.now(), action: 'SELL', asset: action.asset, result: 'rejected', error: reason });
            saveAIExecutions();
            results.push({ ...action, success: false, error: reason });
            continue;
          }
        }

        const volumeAttempts = [1.0, 0.999, 0.99];
        for (const multiplier of volumeAttempts) {
          const volume = holding.amount * multiplier;
          log(`[AI-EXEC] Attempting SELL: ${volume.toFixed(8)} ${baseAsset} @ ${action.price}`);
          result = await kraken.limitSell(pair, volume, action.price);
          if (result?.success) {
            if (multiplier < 1.0) {
              console.log(`[AI-EXEC] Sell succeeded at ${multiplier * 100}% volume`);
            }
            break;
          }
          // Retry on volume errors OR insufficient funds (Kraken floating-point precision issue)
          const errMsg = result?.error || '';
          if (multiplier < 0.99 || (!errMsg.includes('volume') && !errMsg.includes('Insufficient funds'))) {
            break;
          }
          console.log(`[AI-EXEC] Sell at ${multiplier * 100}% failed (${errMsg}), retrying with less...`);
          await new Promise(r => setTimeout(r, 500));
        }
        
      } else if (action.action === 'BUY') {
        // GUARDRAIL: Don't take on positions smaller than 300 EUR
        const MIN_POSITION_EUR = 300;
        if (action.amountEur < MIN_POSITION_EUR) {
          const reason = `buy_below_min_position: ${action.amountEur.toFixed(2)} EUR < min ${MIN_POSITION_EUR} EUR. Size up or skip this entry.`;
          log(`[GUARDRAIL] BUY ${action.asset} blocked: ${reason}`);
          state.aiExecutionHistory.executions.push({ timestamp: Date.now(), action: 'BUY', asset: action.asset, result: 'rejected', error: reason });
          saveAIExecutions();
          results.push({ ...action, success: false, error: reason });
          continue;
        }

        // Kraken wallet uses ZEUR for EUR
        const available = state.wallet['ZEUR']?.amount || state.wallet['EUR']?.amount || 0;

        if (available < action.amountEur) {
          results.push({ ...action, success: false, error: 'insufficient_balance' });
          continue;
        }

        // GUARDRAIL: Don't re-buy above the price we last sold this asset for
        const allTrades = Object.values(state.fullTradeHistory?.trades || {});
        const internalPair = kraken.toInternalPair(pair);
        const pairTrades = allTrades
          .filter(t => kraken.toInternalPair(t.pair) === internalPair)
          .sort((a, b) => b.time - a.time);
        const lastSellTrade = pairTrades.find(t => t.type === 'sell');
        if (lastSellTrade) {
          const lastSellPrice = parseFloat(lastSellTrade.price);
          const maxReentryPrice = lastSellPrice * 0.92; // must be at least 8% below last exit
          const currentPrice = state.ticker[pair]?.price || 0;
          if (currentPrice > maxReentryPrice) {
            const reason = `buy_above_reentry_ceiling: current price ${currentPrice.toFixed(4)} > max re-entry ${maxReentryPrice.toFixed(4)} (last sell ${lastSellPrice.toFixed(4)} - 8%). Wait for a deeper dip before re-entering.`;
            log(`[GUARDRAIL] BUY ${action.asset} blocked: ${reason}`);
            state.aiExecutionHistory.executions.push({ timestamp: Date.now(), action: 'BUY', asset: action.asset, result: 'rejected', error: reason });
            saveAIExecutions();
            results.push({ ...action, success: false, error: reason });
            continue;
          }
        }

        result = await kraken.marketBuy(pair, action.amountEur);
      }
      
      const execRecord = {
        timestamp: Date.now(),
        action: action.action,
        asset: action.asset,
        result: result?.success ? 'success' : 'failed',
        error: result?.error || null
      };
      if (action.price) execRecord.price = action.price;
      if (action.amountEur) execRecord.amountEur = action.amountEur;
      
      state.aiExecutionHistory.executions.push(execRecord);
      if (result?.success) {
        state.aiExecutionHistory.dailyCount++;
      }
      saveAIExecutions();
      
      results.push({ ...action, ...result });
      
      await new Promise(r => setTimeout(r, 1000));
      
    } catch (e) {
      console.error(`[AI-EXEC] Error:`, e.message);
      results.push({ ...action, success: false, error: e.message });
    }
  }
  
  return results;
}

module.exports = {
  parseCommands,
  executeCommands
};