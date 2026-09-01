const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('DynamicKellyEngine');

/**
 * DynamicKellyEngine - Adaptive Fractional Kelly Position Sizing
 * 
 * Formula:
 * f* = (p * b - q) / b
 * where:
 * - p = rolling win rate (e.g. 0.62)
 * - q = 1 - p (e.g. 0.38)
 * - b = win / loss ratio (e.g. 1.85)
 * 
 * Scaled by Rolling Sharpe Ratio:
 * Fraction = Clamp(f* * 0.35, minFraction: 0.015, maxFraction: 0.06)
 */
class DynamicKellyEngine {
  constructor() {
    this.minKellyFraction = 0.015; // Minimum 1.5% capital risk
    this.maxKellyFraction = 0.055; // Maximum 5.5% capital risk (safety bound)
  }

  /**
   * Computes optimal capital allocation per trade based on rolling metrics
   */
  calculateSizing(params = {}) {
    const {
      compoundedEquity = 100000,
      winRate = 0.60,
      profitFactor = 1.80,
      rollingSharpe = 1.85,
      regime = 'RANGING_CHOPPY'
    } = params;

    const p = Math.max(0.35, Math.min(0.85, winRate));
    const q = 1 - p;
    const b = Math.max(1.1, profitFactor);

    // Full Kelly fraction
    const fullKelly = (p * b - q) / b;

    // Scale conservative fractional Kelly (0.25 to 0.40 Kelly based on Sharpe)
    let kellyMultiplier = 0.25;
    if (rollingSharpe >= 2.0) kellyMultiplier = 0.38;
    else if (rollingSharpe >= 1.5) kellyMultiplier = 0.30;
    else if (rollingSharpe < 1.0) kellyMultiplier = 0.18;

    // Regime safety haircut (reduce size by 40% in choppy / high volatility markets)
    let regimeDiscount = 1.0;
    if (regime === 'RANGING_CHOPPY' || regime === 'HIGH_VOLATILITY_EXPANSION') {
      regimeDiscount = 0.60;
    }

    let optimalFraction = fullKelly * kellyMultiplier * regimeDiscount;
    optimalFraction = Math.max(this.minKellyFraction, Math.min(this.maxKellyFraction, optimalFraction));

    const capitalRiskUSD = Math.round(compoundedEquity * optimalFraction);
    const leverageAllowed = regime === 'TRENDING_BULL' || regime === 'TRENDING_BEAR' ? 3.0 : 1.5;
    const maxPositionNotional = Math.round(capitalRiskUSD * leverageAllowed * 5);

    const result = {
      fullKelly: parseFloat(fullKelly.toFixed(3)),
      appliedKellyFraction: parseFloat(optimalFraction.toFixed(4)),
      capitalRiskAmount: capitalRiskUSD,
      maxPositionNotional,
      leverageAllowed,
      regimeDiscountApplied: regimeDiscount < 1.0,
      rationale: `f* ${(fullKelly * 100).toFixed(1)}% scaled to ${(optimalFraction * 100).toFixed(2)}% via ${kellyMultiplier}x Sharpe multiplier (${rollingSharpe} Sharpe, ${regime})`
    };

    logger.info(`💰 [Dynamic Kelly Sizing] Capital: ₹${compoundedEquity.toLocaleString()} ➔ Allocating ${(optimalFraction * 100).toFixed(2)}% (Max Notional: ₹${maxPositionNotional.toLocaleString()})`);

    return result;
  }
}

module.exports = new DynamicKellyEngine();
