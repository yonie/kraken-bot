// @ts-check
/**
 * Command Parsing & Execution Module
 * Parses LLM responses into trading commands and executes them
 */

const kraken = require('../kraken');
const { state, log, saveAIExecutions } = require('../state');

function parseCommands(raw) {
  const actions = [];
  
  const commandsMatch = raw.match(/COMMANDS:\s*([\s\S]*?)(?:\n\n|$)/i);
  const text = commandsMatch ? commandsMatch[1] : raw;
  
  // SELL <ASSET> <price>
  for (const match of text.matchAll(/^SELL\s+([A-Z0-9]{1,10})\s+(\d+(?:\.\d+)?)/gim)) {
    const asset = match[1].toUpperCase().replace(/Z?EUR$/, '');
    const price = parseFloat(match[2]);
    if (asset !== 'EUR' && asset !== 'HOLD' && asset.length > 0 && price > 0) {
      actions.push({ action: 'SELL', asset, price });
    }
  }
  
  // BUY <ASSET> <amount_eur> <price>
  for (const match of text.matchAll(/^BUY\s+([A-Z0-9]{1,10})\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/gim)) {
    const asset = match[1].toUpperCase().replace(/Z?EUR$/, '');
    const amountEur = parseFloat(match[2]);
    const price = parseFloat(match[3]);
    if (asset !== 'EUR' && asset !== 'HOLD' && asset.length > 0 && amountEur > 0 && price > 0) {
      actions.push({ action: 'BUY', asset, amountEur, price });
    }
  }
  
  // CANCEL <order_id>
  for (const match of text.matchAll(/^CANCEL\s+([A-Z0-9]{6}-[A-Z0-9]{5}-[A-Z0-9]{6})/gim)) {
    const orderId = match[1].toUpperCase();
    actions.push({ action: 'CANCEL', orderId });
  }
  
  // CANCEL BUY/SELL <ASSET>
  for (const match of text.matchAll(/^CANCEL\s+(BUY|SELL)\s+([A-Z0-9]{1,10})/gim)) {
    const orderType = match[1].toLowerCase();
    const asset = match[2].toUpperCase().replace(/Z?EUR$/, '');
    if (asset !== 'EUR' && asset.length > 0) {
      actions.push({ action: 'CANCEL_BY_ASSET', orderType, asset });
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
        const asset = state.pairs[pair]?.base;
        const holding = state.wallet[asset];
        
        if (!holding || holding.amount <= 0) {
          results.push({ ...action, success: false, error: 'no_holdings' });
          continue;
        }
        
        const volumeAttempts = [1.0, 0.999, 0.99];
        for (const multiplier of volumeAttempts) {
          const volume = holding.amount * multiplier;
          result = await kraken.limitSell(pair, volume, action.price);
          if (result?.success) {
            if (multiplier < 1.0) {
              console.log(`[AI-EXEC] Sell succeeded at ${multiplier * 100}% volume`);
            }
            break;
          }
          if (multiplier < 0.99 || !result?.error?.includes?.('volume')) {
            break;
          }
          console.log(`[AI-EXEC] Sell at ${multiplier * 100}% failed, retrying with less...`);
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