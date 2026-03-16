// @ts-check
/**
 * Order Management
 * Fetching orders, placing orders, cancelling orders
 */

const { state, log } = require('../state');
const { waitForRateLimit } = require('./api');

async function fetchOrders(retries = 2) {
  await waitForRateLimit(1);
  
  return new Promise((resolve) => {
    const { getClient } = require('./api');
    getClient().api('OpenOrders', null, async (error, data) => {
      if (error) {
        if (error.message?.includes('nonce') && retries > 0) {
          await new Promise(r => setTimeout(r, 500));
          return resolve(fetchOrders(retries - 1));
        }
        console.error('[KRAKEN] Orders error:', error.message);
        return resolve(state.orders);
      }
      
      const newOrders = data.result?.open || {};
      state.orders = newOrders;
      resolve(state.orders);
    });
  });
}

async function limitBuy(pair, amountEUR, price) {
  const { getClient } = require('./api');
  const pairInfo = state.pairs[pair];
  if (!pairInfo) throw new Error(`Unknown pair: ${pair}`);
  
  const pairDecimals = pairInfo.pair_decimals || 2;
  const lotDecimals = pairInfo.lot_decimals || 8;
  const formattedPrice = Number(price.toFixed(pairDecimals));
  
  let volume = amountEUR / formattedPrice;
  volume = Number(volume.toFixed(lotDecimals));
  
  if (pairInfo.ordermin) {
    volume = Math.max(volume, parseFloat(pairInfo.ordermin));
  }
  
  log(`[ORDER] Limit BUY: ${volume} ${pair} @ ${formattedPrice} EUR`);
  
  return new Promise((resolve) => {
    getClient().api('AddOrder', {
      pair,
      type: 'buy',
      ordertype: 'limit',
      volume,
      price: formattedPrice
    }, (error, data) => {
      if (error) {
        log(`[ORDER] Buy failed: ${error.message}`);
        resolve({ success: false, error: error.message });
      } else {
        log(`[ORDER] Buy success: ${data.result?.descr?.order}`);
        resolve({ success: true, order: data.result });
      }
    });
  });
}

async function limitSell(pair, volume, price) {
  const { getClient } = require('./api');
  const pairInfo = state.pairs[pair];
  if (!pairInfo) throw new Error(`Unknown pair: ${pair}`);
  
  const pairDecimals = pairInfo.pair_decimals || 2;
  const lotDecimals = pairInfo.lot_decimals || 8;
  const formattedPrice = Number(price.toFixed(pairDecimals));
  const formattedVolume = Number(volume.toFixed(lotDecimals));
  
  log(`[ORDER] Limit SELL: ${formattedVolume} ${pair} @ ${formattedPrice} EUR`);
  
  return new Promise((resolve) => {
    getClient().api('AddOrder', {
      pair,
      type: 'sell',
      ordertype: 'limit',
      volume: formattedVolume,
      price: formattedPrice
    }, (error, data) => {
      if (error) {
        log(`[ORDER] Sell failed: ${error.message}`);
        resolve({ success: false, error: error.message });
      } else {
        log(`[ORDER] Sell success: ${data.result?.descr?.order}`);
        resolve({ success: true, order: data.result });
      }
    });
  });
}

async function marketBuy(pair, amountEUR) {
  const { getClient } = require('./api');
  const pairInfo = state.pairs[pair];
  if (!pairInfo) throw new Error(`Unknown pair: ${pair}`);
  
  const ticker = state.ticker[pair];
  if (!ticker?.price) {
    return { success: false, error: 'no_price_data' };
  }
  
  const price = ticker.price;
  const lotDecimals = pairInfo.lot_decimals || 8;
  let volume = amountEUR / price;
  volume = Number(volume.toFixed(lotDecimals));
  
  if (pairInfo.ordermin) {
    const minVolume = parseFloat(pairInfo.ordermin);
    if (volume < minVolume) {
      log(`[ORDER] Market BUY below minimum: ${volume} < ${minVolume}, adjusting`);
      volume = minVolume;
    }
  }
  
  log(`[ORDER] Market BUY: ${volume} ${pair} (~${amountEUR} EUR at ${price})`);
  
  return new Promise((resolve) => {
    getClient().api('AddOrder', {
      pair,
      type: 'buy',
      ordertype: 'market',
      volume
    }, (error, data) => {
      if (error) {
        log(`[ORDER] Market buy failed: ${error.message}`);
        resolve({ success: false, error: error.message });
      } else {
        log(`[ORDER] Market buy success: ${data.result?.descr?.order}`);
        resolve({ success: true, order: data.result });
      }
    });
  });
}

async function cancelOrder(orderId) {
  const { getClient } = require('./api');
  
  return new Promise((resolve) => {
    getClient().api('CancelOrder', { txid: orderId }, (error, data) => {
      if (error) {
        resolve({ success: false, error: error.message });
      } else {
        resolve({ success: true });
      }
    });
  });
}

module.exports = {
  fetchOrders,
  limitBuy,
  limitSell,
  marketBuy,
  cancelOrder
};