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
        // Kraken wallet uses ZEUR for EUR
        const available = state.wallet['ZEUR']?.amount || state.wallet['EUR']?.amount || 0;
        
        if (available < action.amountEur) {
          results.push({ ...action, success: false, error: 'insufficient_balance' });
          continue;
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