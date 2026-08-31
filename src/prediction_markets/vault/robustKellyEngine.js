/**
 * 🎯 Side-Aware Robust Kelly Sizing Engine (Final Hardened)
 * 
 * Enforces:
 * - Side-Aware Probability Sizing:
 *   YES side: pSizing = calibratedLowerBound
 *   NO side:  pSizing = 1.0 - calibratedUpperBound
 * - Explicit fail-closed states:
 *   KELLY_NO_BET & KELLY_UNAVAILABLE
 * - Structured reasonCodes[]
 */

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('RobustKellyEngine');

class RobustKellyEngine {
  constructor(config = {}) {
    this.maxKellyMultiplier = config.maxKellyMultiplier || 0.25; // Quarter-Kelly (κ <= 0.25)
    this.singleMarketRiskCap = config.singleMarketRiskCap || 0.02; // 2% single contract risk cap
    this.minObservationsForKelly = config.minObservationsForKelly || 5;
  }

  /**
   * Calculate Side-Aware Robust Kelly Position Sizing
   * @param {Object} params - { side, pForecast, calibratedBounds: { lower, upper }, marketAsk, allInCostUSD, payoutUSD, sampleCount }
   */
  calculateRobustKelly(params) {
    const { side = 'YES', pForecast, calibratedBounds, marketAsk, allInCostUSD, payoutUSD, sampleCount } = params;

    const reasonCodes = [];

    if (sampleCount !== undefined && sampleCount < this.minObservationsForKelly) {
      reasonCodes.push('INSUFFICIENT_CALIBRATION_SAMPLE');
      return {
        status: 'KELLY_UNAVAILABLE',
        reasonCodes,
        shares: 0,
        fractionalKellyFraction: 0,
        capitalToRiskUSD: 0
      };
    }

    if (!marketAsk || marketAsk <= 0 || marketAsk >= 1) {
      reasonCodes.push('INVALID_MARKET_PRICE');
      return { status: 'KELLY_NO_BET', reasonCodes, shares: 0, capitalToRiskUSD: 0 };
    }

    // 1. Side-Aware Robust Lower Bound Calculation
    let pSizing = 0;
    if (side === 'YES') {
      pSizing = (calibratedBounds && calibratedBounds.lower !== undefined)
        ? Math.max(0.01, calibratedBounds.lower)
        : Math.max(0.01, pForecast - 0.08);
    } else {
      // NO side uses 1 - upper bound
      pSizing = (calibratedBounds && calibratedBounds.upper !== undefined)
        ? Math.max(0.01, 1.0 - calibratedBounds.upper)
        : Math.max(0.01, (1.0 - pForecast) - 0.08);
    }

    // 2. Net Payoff Ratio after all-in fees
    const maxLoss = allInCostUSD || marketAsk;
    const netProfitIfWin = (payoutUSD || 1.00) - maxLoss;

    if (netProfitIfWin <= 0 || maxLoss <= 0) {
      reasonCodes.push('NEGATIVE_NET_PAYOFF');
      return { status: 'KELLY_NO_BET', reasonCodes, shares: 0, capitalToRiskUSD: 0 };
    }

    const b = netProfitIfWin / maxLoss;
    const q = 1.0 - pSizing;

    // 3. Full Robust Kelly
    const rawRobustKelly = (b * pSizing - q) / b;

    if (rawRobustKelly <= 0) {
      reasonCodes.push('NEGATIVE_OR_ZERO_ROBUST_EDGE');
      return {
        status: 'KELLY_NO_BET',
        reasonCodes,
        rawRobustKelly: parseFloat(rawRobustKelly.toFixed(4)),
        pSizing: parseFloat(pSizing.toFixed(4)),
        shares: 0,
        capitalToRiskUSD: 0
      };
    }

    // 4. Apply Quarter-Kelly Multiplier (κ <= 0.25) & Single-Market Risk Cap (2%)
    let fractionalKelly = rawRobustKelly * this.maxKellyMultiplier;
    fractionalKelly = Math.min(fractionalKelly, this.singleMarketRiskCap);

    reasonCodes.push('OPTIMAL_ROBUST_KELLY_PASSED');
    if (fractionalKelly === this.singleMarketRiskCap) {
      reasonCodes.push('SINGLE_MARKET_CAP_ENFORCED');
    }

    return {
      status: 'OPTIMAL_ROBUST_KELLY',
      side,
      pSizing: parseFloat(pSizing.toFixed(4)),
      b: parseFloat(b.toFixed(3)),
      rawRobustKelly: parseFloat(rawRobustKelly.toFixed(4)),
      fractionalKellyFraction: parseFloat(fractionalKelly.toFixed(4)),
      reasonCodes,
      singleMarketRiskCapEnforced: fractionalKelly === this.singleMarketRiskCap
    };
  }
}

const robustKellyEngine = new RobustKellyEngine();
module.exports = { RobustKellyEngine, robustKellyEngine };
