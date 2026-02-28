// @ts-check
/**
 * Kraken API Client & Rate Limiting
 */

const KrakenClient = require('kraken-api');

let kraken = null;
let countryCode = null;

const rateLimit = {
  counter: 0,
  maxCounter: 15,
  lastDecay: Date.now(),
  decayRate: 0.33,
};

function decayCounter() {
  const now = Date.now();
  const elapsed = (now - rateLimit.lastDecay) / 1000;
  const decay = elapsed * rateLimit.decayRate;
  rateLimit.counter = Math.max(0, rateLimit.counter - decay);
  rateLimit.lastDecay = now;
}

async function waitForRateLimit(cost) {
  decayCounter();
  
  while (rateLimit.counter + cost > rateLimit.maxCounter) {
    const waitTime = Math.ceil((rateLimit.counter + cost - rateLimit.maxCounter) / rateLimit.decayRate) * 1000 + 500;
    const { log } = require('../state');
    log(`[RATE LIMIT] Counter at ${rateLimit.counter.toFixed(1)}, waiting ${waitTime}ms before +${cost} call`);
    await new Promise(r => setTimeout(r, waitTime));
    decayCounter();
  }
  
  rateLimit.counter += cost;
}

function init(apiKey, apiSecret, country = null) {
  kraken = new KrakenClient(apiKey, apiSecret);
  countryCode = country;
  const { log } = require('../state');
  if (countryCode) {
    log(`[KRAKEN] API initialized with country filter: ${countryCode}`);
  } else {
    log('[KRAKEN] API initialized');
  }
}

function getClient() {
  return kraken;
}

function getCountryCode() {
  return countryCode;
}

async function api(method, params = null) {
  return new Promise((resolve, reject) => {
    kraken.api(method, params, (error, data) => {
      if (error) return reject(error);
      resolve(data);
    });
  });
}

module.exports = {
  init,
  getClient,
  getCountryCode,
  waitForRateLimit,
  api
};