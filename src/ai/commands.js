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
  
  // Track processed lines to avoid double-matching
  const processedLines = new Set();
  const lines = text.split('\n');
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    
    // SELL <ASSET> ALL <PRICE> - sell all holdings
    const allMatch = trimmedLine.match(/^SELL\s+([A-Z0-9]{1,10})\s+ALL\s+(\d+(?:\.\d+)?)/i);
    if (allMatch) {
      const asset = allMatch[1].toUpperCase().replace(/Z?EUR$/, '');
      const price = parseFloat(allMatch[2]);
      if (asset !== 'EUR' && asset.length > 0 && price > 0) {
        actions.push({ action: 'SELL', asset, price, percent: 100 });
        processedLines.add(trimmedLine);
        continue;
      }
    }
    
    // SELL <ASSET> <PERCENT>% <PRICE> - sell partial holdings
    const partialMatch = trimmedLine.match(/^SELL\s+([A-Z0-9]{1,10})\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)/i);
    if (partialMatch) {
      const asset = partialMatch[1].toUpperCase().replace(/Z?EUR$/, '');
      const percent = parseFloat(partialMatch[2]);
      const price = parseFloat(partialMatch[3]);
      if (asset !== 'EUR' && asset.length > 0 && percent > 0 && percent <= 100 && price > 0) {
        actions.push({ action: 'SELL', asset, price, percent });
        processedLines.add(trimmedLine);
        continue;
      }
    }
    
    // SELL <ASSET> <PRICE> - sell all holdings (fallback format)
    const sellMatch = trimmedLine.match(/^SELL\s+([A-Z0-9]{1,10})\s+(\d+(?:\.\d+)?)/i);
    if (sellMatch && !processedLines.has(trimmedLine)) {
      const asset = sellMatch[1].toUpperCase().replace(/Z?EUR$/, '');
      const price = parseFloat(sellMatch[2]);
      if (asset !== 'EUR' && asset !== 'HOLD' && asset.length > 0 && price > 0) {
        actions.push({ action: 'SELL', asset, price, percent: 100 });
        continue;
      }
    }
    
    // BUY <ASSET> <amount_eur> <price>
    const buyMatch = trimmedLine.match(/^BUY\s+([A-Z0-9]{1,10})\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i);
    if (buyMatch) {
      const asset = buyMatch[1].toUpperCase().replace(/Z?EUR$/, '');
      const amountEur = parseFloat(buyMatch[2]);
      const price = parseFloat(buyMatch[3]);
      if (asset !== 'EUR' && asset !== 'HOLD' && asset.length > 0 && amountEur > 0 && price > 0) {
        actions.push({ action: 'BUY', asset, amountEur, price });
        continue;
      }
    }
    
    // HOLD [ASSET] - explicit hold
    const holdMatch = trimmedLine.match(/^HOLD\s*([A-Z0-9]{1,10})?$/i);
    if (holdMatch) {
      const asset = holdMatch[1] ? holdMatch[1].toUpperCase().replace(/Z?EUR$/, '') : 'ALL';
      actions.push({ action: 'HOLD', asset });
      continue;
    }
    
    // CANCEL <order_id>
    const cancelMatch = trimmedLine.match(/^CANCEL\s+([A-Z0-9]{6}-[A-Z0-9]{5}-[A-Z0-9]{6})/i);
    if (cancelMatch) {
      actions.push({ action: 'CANCEL', orderId: cancelMatch[1].toUpperCase() });
      continue;
    }
    
    // CANCEL BUY/SELL <ASSET>
    const cancelAssetMatch = trimmedLine.match(/^CANCEL\s+(BUY|SELL)\s+([A-Z0-9]{1,10})/i);
    if (cancelAssetMatch) {
      const orderType = cancelAssetMatch[1].toLowerCase();
      const asset = cancelAssetMatch[2].toUpperCase().replace(/Z?EUR$/, '');
      if (asset !== 'EUR' && asset.length > 0) {
        actions.push({ action: 'CANCEL_BY_ASSET', orderType, asset });
        continue;
      }
    }
  }
  
  log(`[AI] Parsed ${actions.length} commands: ${JSON.stringify(actions)}`);
  return actions;
}

function cleanAssetName(asset) {
  const krakenPrefixed = ['XXBT', 'XETH', 'XLTC', 'XXRP', 'XXLM', 'XZEC', 'XXMR', 'XETC', 'XREP', 'XMLN', 'ZEUR', 'ZUSD', 'ZGBP', 'ZCAD', 'ZJPY'];
  
  if (krakenPrefixed.includes(asset)) {
    return asset.slice(1);
  }
  
  if (asset.startsWith('XX') && asset.length <= 6) {
    return asset.slice(1);
  }
  
  return asset;
}

async function executeCommands(actions) {
  const results = [];
  
  for (const action of actions) {
    // CANCEL by order ID
    if (action.action === 'CANCEL') {
      try {
        log(`[AI-EXEC] Cancelling order: ${action.orderId}`);
        const cancelResult = await kraken.cancelOrder(action.orderId);
        if (cancelResult.success) {
          log(`[AI-EXEC] Cancelled order ${action.orderId}`);
          delete state.orders[action.orderId];
          state.aiExecutionHistory.executions.push({
            timestamp: Date.now(),
            action: 'CANCEL',
            orderId: action.orderId,
            result: 'success'
          });
          state.aiExecutionHistory.dailyCount++;
          saveAIExecutions();
          results.push({ ...action, success: true });
        } else {
          log(`[AI-EXEC] Failed to cancel order ${action.orderId}: ${cancelResult.error}`);
          results.push({ ...action, success: false, error: cancelResult.error });
        }
      } catch (e) {
        console.error(`[AI-EXEC] Cancel error:`, e.message);
        results.push({ ...action, success: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    
    // CANCEL by asset
    if (action.action === 'CANCEL_BY_ASSET') {
      const pair = kraken.findPairForAsset(action.asset);
      if (!pair) {
        log(`[AI-EXEC] No pair found for ${action.asset}`);
        results.push({ ...action, success: false, error: 'pair_not_found' });
        continue;
      }
      
      const matchingOrders = Object.entries(state.orders).filter(([id, o]) => {
        const orderPair = o.descr?.pair;
        const orderType = o.descr?.type;
        const orderAsset = cleanAssetName(orderPair?.replace(/Z?EUR$/, '') || '');
        const pairMatch = orderPair === pair || 
                          orderPair === pair.replace('ZEUR', 'EUR') ||
                          orderPair === pair.replace('EUR', 'ZEUR') ||
                          orderAsset === action.asset;
        return pairMatch && orderType === action.orderType;
      });
      
      if (matchingOrders.length === 0) {
        log(`[AI-EXEC] No ${action.orderType} orders found for ${action.asset}`);
        results.push({ ...action, success: false, error: 'no_matching_orders' });
        continue;
      }
      
      let cancelledCount = 0;
      for (const [orderId, order] of matchingOrders) {
        try {
          log(`[AI-EXEC] Cancelling ${action.orderType} order for ${action.asset}: ${orderId}`);
          const cancelResult = await kraken.cancelOrder(orderId);
          if (cancelResult.success) {
            log(`[AI-EXEC] Cancelled order ${orderId}`);
            delete state.orders[orderId];
            cancelledCount++;
          } else {
            log(`[AI-EXEC] Failed to cancel order ${orderId}: ${cancelResult.error}`);
          }
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error(`[AI-EXEC] Cancel error:`, e.message);
        }
      }
      
      if (cancelledCount > 0) {
        state.aiExecutionHistory.executions.push({
          timestamp: Date.now(),
          action: 'CANCEL_BY_ASSET',
          orderType: action.orderType,
          asset: action.asset,
          count: cancelledCount,
          result: 'success'
        });
        state.aiExecutionHistory.dailyCount++;
        saveAIExecutions();
      }
      results.push({ ...action, success: cancelledCount > 0, cancelled: cancelledCount });
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
      const existingOrders = Object.entries(state.orders).filter(([id, order]) => {
        const orderPair = order.descr?.pair;
        return orderPair === pair || 
               orderPair === pair.replace('ZEUR', 'EUR') ||
               orderPair === pair.replace('EUR', 'ZEUR');
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
        
        // Calculate volume based on percent (default 100%)
        const percent = action.percent || 100;
        const sellRatio = percent / 100;
        const targetVolume = holding.amount * sellRatio;
        
        const volumeAttempts = [1.0, 0.999, 0.99];
        for (const multiplier of volumeAttempts) {
          const volume = targetVolume * multiplier;
          log(`[AI-EXEC] Attempting SELL: ${volume.toFixed(8)} ${baseAsset} @ ${action.price}`);
          result = await kraken.limitSell(pair, volume, action.price);
          if (result?.success) {
            if (multiplier < 1.0) {
              console.log(`[AI-EXEC] Sell succeeded at ${multiplier * 100}% volume`);
            }
            if (percent < 100) {
              log(`[AI-EXEC] Sold ${percent}% of ${baseAsset} (${volume.toFixed(8)} units)`);
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
        const available = state.wallet['ZEUR']?.amount || 0;
        
        if (available < action.amountEur) {
          results.push({ ...action, success: false, error: 'insufficient_balance' });
          continue;
        }
        
        result = await kraken.limitBuy(pair, action.amountEur, action.price);
      }
      
      state.aiExecutionHistory.executions.push({
        timestamp: Date.now(),
        action: action.action,
        asset: action.asset,
        price: action.price,
        result: result?.success ? 'success' : 'failed',
        error: result?.error || null
      });
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
  cleanAssetName,
  executeCommands
};