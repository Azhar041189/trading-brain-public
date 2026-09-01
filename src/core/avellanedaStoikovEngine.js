/**
 * 🛡️ Avellaneda-Stoikov Adaptive Quoting Engine with Saty ATR Volatility Bounds
 * 
 * Implements the optimal high-frequency / market-making inventory equations:
 * 1. Reservation Price: r(s, q, t) = s - q * gamma * sigma^2 * (T - t)
 *    where:
 *      s = Midpoint price
 *      q = Inventory level (long positive, short negative)
 *      gamma = Risk aversion parameter
 *      sigma = Volatility (scaled via Saty ATR Engine)
 *      (T - t) = Time horizon fraction
 * 
 * 2. Optimal Half-Spread: delta_a + delta_b = gamma * sigma^2 * (T - t) + (2 / gamma) * ln(1 + gamma / kappa)
 * 
 * 3. Saty ATR Skew Barrier:
 *    When Range Utilization >= 61.8% or 100% ATR, quotes dynamically widen to prevent toxic adverse selection.
 */

const { satyAtrEngine } = require('./satyAtrEngine');
const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('AvellanedaStoikovEngine');

class AvellanedaStoikovEngine {
  constructor(config = {}) {
    this.riskAversion = config.riskAversion || 0.1; // Gamma
    this.orderBookDensity = config.orderBookDensity || 1.5; // Kappa
    this.timeHorizon = config.timeHorizon || 1.0; // Normalized session fraction (T - t)
  }

  /**
   * Calculate inventory-skewed optimal quotes
   * @param {number} midPrice - Current fair midpoint price
   * @param {number} inventory - Net inventory holding (-100 to +100)
   * @param {number} atr - Current 14-period ATR
   * @param {number} prevClose - Previous session close for Saty ATR check
   */
  computeOptimalQuotes(midPrice, inventory, atr = 10, prevClose = midPrice) {
    const sigma = atr / midPrice; // Volatility normalized
    const gamma = this.riskAversion;
    const kappa = this.orderBookDensity;

    // 1. Calculate Avellaneda-Stoikov Reservation Price
    const reservationPrice = midPrice - (inventory * gamma * Math.pow(sigma, 2) * this.timeHorizon);

    // 2. Base Optimal Spread
    const optimalSpread = (gamma * Math.pow(sigma, 2) * this.timeHorizon) + ((2 / gamma) * Math.log(1 + (gamma / kappa)));
    let halfSpread = (optimalSpread * midPrice) / 2;

    // 3. Saty ATR Volatility & Range Utilization Skew
    const satyCheck = satyAtrEngine.calculateLevels(prevClose, midPrice, atr);
    let volatilityRegime = satyCheck ? satyCheck.activeZone : 'NEUTRAL_CORE';
    let rangeUtilization = satyCheck ? satyCheck.rangeUtilizationPct : 50;

    // If intraday volatility expands beyond 61.8% ATR target, widen spread against the trend
    if (rangeUtilization >= 61.8) {
      halfSpread *= 1.35; // 35% safety widening
    }
    if (rangeUtilization >= 100.0) {
      halfSpread *= 1.80; // 80% extreme barrier widening
    }

    const optimalBid = parseFloat(Math.max(0.01, reservationPrice - halfSpread).toFixed(2));
    const optimalAsk = parseFloat((reservationPrice + halfSpread).toFixed(2));

    return {
      midPrice: parseFloat(midPrice.toFixed(2)),
      inventory,
      reservationPrice: parseFloat(reservationPrice.toFixed(2)),
      optimalBid,
      optimalAsk,
      spreadUSD: parseFloat((optimalAsk - optimalBid).toFixed(2)),
      volatilityRegime,
      rangeUtilizationPct: rangeUtilization,
      quoteSkew: inventory > 0 ? 'SKEW_LOWER_TO_SELL' : (inventory < 0 ? 'SKEW_HIGHER_TO_BUY' : 'SYMMETRIC')
    };
  }
}

const avellanedaStoikovEngine = new AvellanedaStoikovEngine();

module.exports = {
  AvellanedaStoikovEngine,
  avellanedaStoikovEngine
};
