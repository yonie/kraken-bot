// @ts-check
/**
 * Asset Pair Utilities
 */

const { state } = require('../state');
const { getClient, getCountryCode } = require('./api');

function findPairForAsset(assetName) {
  if (!state.pairs || !assetName) return null;
  const normalized = assetName.toUpperCase().trim();
  
  if (state.assetToPairMap[normalized]) {
    return state.assetToPairMap[normalized];
  }
  
  const variations = [
    normalized + 'EUR',
    normalized + 'ZEUR', 
    'X' + normalized + 'ZEUR',
    'XX' + normalized.slice(1) + 'ZEUR'
  ];
  
  for (const v of variations) {
    if (state.pairs[v]) return v;
  }
  
  for (const pair in state.pairs) {
    const base = state.pairs[pair].base;
    if (base === normalized || base === 'X' + normalized || base === 'XX' + normalized.slice(1)) {
      if (pair.endsWith('EUR') || pair.endsWith('ZEUR')) {
        return pair;
      }
    }
  }
  
  return null;
}

function getAssetFromPair(pair) {
  if (state.pairs?.[pair]?.base) return state.pairs[pair].base;
  return pair.replace(/Z?EUR$/, '').replace(/\.S$/, '');
}

async function fetchPairs() {
  const params = getCountryCode() ? { country_code: getCountryCode() } : null;
  
  return new Promise((resolve, reject) => {
    getClient().api('AssetPairs', params, (error, data) => {
      if (error) return reject(error);
      
      const { state, log } = require('../state');
      state.pairs = {};
      state.assetToPairMap = {};
      
      for (const pair in data.result) {
        const info = data.result[pair];
        if ((pair.endsWith('EUR') || pair.endsWith('ZEUR')) && !pair.includes('.')) {
          state.pairs[pair] = info;
          
          const base = info.base;
          state.assetToPairMap[base] = pair;
          
          if (base.startsWith('X') && base.length <= 5) {
            state.assetToPairMap[base.slice(1)] = pair;
          }
          if (base.startsWith('XX') && base.length <= 6) {
            state.assetToPairMap[base.slice(1)] = pair;
            state.assetToPairMap[base.slice(2)] = pair;
          }
        }
      }
      
      log(`[KRAKEN] Loaded ${Object.keys(state.pairs).length} EUR pairs${getCountryCode() ? ` (filtered for ${getCountryCode()})` : ''}`);
      resolve(state.pairs);
    });
  });
}

module.exports = {
  findPairForAsset,
  getAssetFromPair,
  fetchPairs
};