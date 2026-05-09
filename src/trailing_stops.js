// @ts-check
/**
 * Trailing Stop-Loss Manager
 *
 * Per-position rule (runs every refresh cycle):
 *   - Activate when pnl_pct >= 8% OR pnl_eur >= 100
 *   - Place stop-loss at highest achievable floor: max(entry*1.08, entry + 100/amount)
 *     clamped safely below current price
 *   - Trail upward: each cycle, if current*(1-TRAIL_GAP) exceeds existing stop by
 *     HYSTERESIS, edit the stop upward
 *   - Never lower an existing stop
 *
 * All decisions are in-memory (reads state.wallet, state.ticker, state.orders).
 * Kraken API is only called when an order is placed or edited.
 */

const kraken = require('./kraken');
const { state, log } = require('./state');

const ACTIVATION_PCT = 8;          // qualify at +8%
const FLOOR_PCT = 1.06;            // stop floor = entry × 1.06 (2% buffer below activation)
const ACTIVATION_EUR = 100;        // or +€100 profit, whichever first
const FLOOR_EUR = 75;              // stop floor locks in at least €75 (€25 buffer)
const TRAIL_GAP = 0.04;            // stop sits 4% below current
const HYSTERESIS = 0.01;           // only raise stop if bump >= 1%
const SAFE_BELOW_CURRENT = 0.995;  // stop must be <= current * 0.995 to avoid instant trigger

function findSellOrderForPair(pair) {
  const internalPair = kraken.toInternalPair(pair);
  for (const [id, o] of Object.entries(state.orders || {})) {
    if (o.descr?.type !== 'sell') continue;
    const orderPair = kraken.toInternalPair(o.descr?.pair);
    if (orderPair === internalPair) {
      return {
        id,
        ordertype: o.descr?.ordertype || 'limit',
        isStop: (o.descr?.ordertype || '').startsWith('stop'),
        price: parseFloat(o.descr?.price),
        vol: parseFloat(o.vol),
      };
    }
  }
  return null;
}

function decide(asset, position, existing) {
  const amount = position.amount;
  const entry = position.avgCost;
  const current = position.currentPrice;
  if (!(amount > 0) || !(entry > 0) || !(current > 0)) return null;

  const pnlPct = ((current - entry) / entry) * 100;
  const pnlEur = (current - entry) * amount;
  const qualifies = pnlPct >= ACTIVATION_PCT || pnlEur >= ACTIVATION_EUR;
  if (!qualifies) return null;

  const trailPrice = current * (1 - TRAIL_GAP);
  const maxSafe = current * SAFE_BELOW_CURRENT;

  if (!existing || !existing.isStop) {
    // No managed stop yet. Pick the highest achievable floor.
    const floorPct = entry * FLOOR_PCT;
    const floorEur = entry + FLOOR_EUR / amount;
    const achievable = [floorPct, floorEur].filter(f => f < maxSafe);
    if (achievable.length === 0) {
      // Position is qualifying but too close to floors to place safely this tick
      return null;
    }
    const baseline = Math.max(...achievable);
    const target = Math.min(Math.max(trailPrice, baseline), maxSafe);
    return { action: 'place', price: target, cancelOrder: existing?.id || null };
  }

  // Existing stop present — trail up only
  const candidate = Math.min(Math.max(trailPrice, existing.price), maxSafe);
  if (candidate > existing.price * (1 + HYSTERESIS)) {
    return { action: 'edit', id: existing.id, price: candidate };
  }
  return null;
}

async function placeStopWithRetry(asset, pair, amount, price, priorCancelled) {
  // Retries the stopLoss placement up to 3 times with backoff.
  // Critical when priorCancelled=true — the position is uncovered until we succeed.
  const delays = [0, 1500, 4000];
  let lastErr = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    const result = await kraken.stopLoss(pair, amount, price);
    if (result.success) return true;
    lastErr = result.error;
    log(`[TSTOP] Place attempt ${i + 1}/${delays.length} failed for ${asset}: ${lastErr}`);
  }
  if (priorCancelled) {
    log(`[TSTOP] CRITICAL: ${asset} uncovered after ${delays.length} attempts. Last error: ${lastErr}. Will retry next cycle (60s).`);
  } else {
    log(`[TSTOP] Place failed for ${asset} after ${delays.length} attempts: ${lastErr}`);
  }
  return false;
}

async function manageTrailingStops() {
  try {
    const positions = kraken.getEnrichedPositions();
    for (const [asset, p] of Object.entries(positions)) {
     try {
      if (!p || !(p.amount > 0)) continue;
      const pair = state.assetToPairMap[asset];
      if (!pair) continue;

      const existing = findSellOrderForPair(pair);
      const decision = decide(asset, p, existing);
      if (!decision) continue;

      if (decision.action === 'place') {
        if (decision.cancelOrder) {
          log(`[TSTOP] Cancelling existing limit for ${asset}: ${decision.cancelOrder}`);
          const cx = await kraken.cancelOrder(decision.cancelOrder);
          if (!cx.success) {
            log(`[TSTOP] Cancel failed for ${asset}: ${cx.error}`);
            continue;
          }
          delete state.orders[decision.cancelOrder];
          await new Promise(r => setTimeout(r, 500));
        }
        const ok = await placeStopWithRetry(asset, pair, p.amount, decision.price, !!decision.cancelOrder);
        if (ok) {
          log(`[TSTOP] Placed stop for ${asset} @ ${decision.price.toFixed(6)} (entry ${p.avgCost.toFixed(6)}, current ${p.currentPrice.toFixed(6)})`);
        }
        await new Promise(r => setTimeout(r, 500));
      } else if (decision.action === 'edit') {
        // kraken-api client doesn't support EditOrder/AmendOrder — cancel + replace instead
        const cx = await kraken.cancelOrder(decision.id);
        if (!cx.success) {
          log(`[TSTOP] Trail cancel failed for ${asset}: ${cx.error}`);
          continue;
        }
        delete state.orders[decision.id];
        await new Promise(r => setTimeout(r, 500));
        const ok = await placeStopWithRetry(asset, pair, p.amount, decision.price, true);
        if (ok) {
          log(`[TSTOP] Trailed stop for ${asset} -> ${decision.price.toFixed(6)} (was ${existing.price.toFixed(6)})`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
     } catch (e) {
       console.error(`[TSTOP] error for ${asset}:`, e.message);
     }
    }
  } catch (e) {
    console.error('[TSTOP] manageTrailingStops error:', e.message);
  }
}

module.exports = { manageTrailingStops };
