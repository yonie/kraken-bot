// @ts-check
/**
 * Kraken Pair Naming Convention
 * 
 * Kraken uses TWO names for each trading pair:
 * - Internal key (e.g., XETHZEUR): Used in API responses (Ticker, Depth, AssetPairs)
 * - Altname (e.g., ETHEUR): Used in order responses (OpenOrders)
 * 
 * We use INTERNAL KEYS throughout the codebase for consistency.
 * state.pairAliases maps altname -> internal key for conversion.
 * 
 * Examples:
 *   Internal: XETHZEUR, XXRPZEUR, XXBTZEUR
 *   Altname:  ETHEUR,  XRPEUR,  XBTEUR
 *   (some pairs like SUIEUR have no X prefix - same for both)
 */

const { state } = require('../state');
const { getClient, getCountryCode } = require('./api');

/**
 * Display Name Mapping
 * Maps internal asset names (XXBT) to Kraken altnames (XBT)
 * Fetched from Kraken Assets API and cached.
 */
state.assetDisplayNames = {};  // internal -> display (e.g., XXBT -> XBT)
state.internalFromDisplay = {}; // display -> internal (e.g., XBT -> XXBT)

/**
 * Fetch asset display name mapping from Kraken Assets API.
 * This gives us the altname field which is the human-readable name.
 */
async function fetchAssetDisplayNames() {
  return new Promise((resolve, reject) => {
    getClient().api('Assets', null, (error, data) => {
      if (error) {
        console.error('[KRAKEN] Assets API error:', error.message);
        return resolve(null);
      }
      
      state.assetDisplayNames = {};
      state.internalFromDisplay = {};
      
      for (const [asset, info] of Object.entries(data.result)) {
        if (info.altname && info.altname !== asset) {
          state.assetDisplayNames[asset] = info.altname;
          state.internalFromDisplay[info.altname] = asset;
        }
      }
      
      console.log(`[KRAKEN] Loaded ${Object.keys(state.assetDisplayNames).length} asset display name mappings`);
      resolve(state.assetDisplayNames);
    });
  });
}

/**
 * Get display name for an internal asset name.
 * e.g., getAssetDisplayName('XXBT') → 'XBT'
 */
function getAssetDisplayName(asset) {
  if (!asset) return asset;
  return state.assetDisplayNames[asset] || asset;
}

/**
 * Get internal asset name from a display name.
 * e.g., getInternalFromDisplay('XBT') → 'XXBT'
 */
function getInternalFromDisplay(displayName) {
  if (!displayName) return displayName;
  return state.internalFromDisplay[displayName] || displayName;
}

/**
 * Convert altname to internal key.
 * Orders use altname (ETHEUR), we need internal key (XETHZEUR).
 */
function toInternalPair(pairName) {
  if (!pairName) return null;
  if (state.pairAliases?.[pairName]) return state.pairAliases[pairName];
  if (state.pairs?.[pairName]) return pairName;
  return pairName;
}

/**
 * Find pair for asset using assetToPairMap (populated from Kraken API).
 * Accepts BOTH internal names (XXBT) AND display names (XBT).
 */
function findPairForAsset(assetName) {
  if (!state.assetToPairMap) return null;
  const normalized = assetName.toUpperCase().trim();
  
  // First try exact match
  if (state.assetToPairMap[normalized]) {
    return state.assetToPairMap[normalized];
  }
  
  // Try converting display name to internal
  const internal = state.internalFromDisplay[normalized];
  if (internal && state.assetToPairMap[internal]) {
    return state.assetToPairMap[internal];
  }
  
  return null;
}

/**
 * Get asset name from pair - returns Kraken's .base field as-is.
 */
function getAssetFromPair(pair) {
  const internalPair = toInternalPair(pair);
  const info = state.pairs?.[internalPair];
  
  return info?.base || pair;
}

async function fetchPairs() {
  const params = getCountryCode() ? { country_code: getCountryCode() } : null;
  
  return new Promise((resolve, reject) => {
    getClient().api('AssetPairs', params, (error, data) => {
      if (error) return reject(error);
      
      const { state, log } = require('../state');
      state.pairs = {};
      state.pairAliases = {};
      state.assetToPairMap = {};
      
      for (const pair in data.result) {
        const info = data.result[pair];
        if ((pair.endsWith('EUR') || pair.endsWith('ZEUR')) && !pair.includes('.')) {
          // Store by internal key ONLY
          state.pairs[pair] = info;
          
          // Map altname -> internal key (for order conversion)
          if (info.altname && info.altname !== pair) {
            state.pairAliases[info.altname] = pair;
          }
          
          // Map asset to internal key (use Kraken's base name exactly)
          const base = info.base;
          state.assetToPairMap[base] = pair;
        }
      }
      
      log(`[KRAKEN] Loaded ${Object.keys(state.pairs).length} EUR pairs${getCountryCode() ? ` (filtered for ${getCountryCode()})` : ''}`);
      resolve(state.pairs);
    });
  });
}

module.exports = {
  toInternalPair,
  findPairForAsset,
  getAssetFromPair,
  getAssetDisplayName,
  getInternalFromDisplay,
  fetchAssetDisplayNames,
  fetchPairs
};