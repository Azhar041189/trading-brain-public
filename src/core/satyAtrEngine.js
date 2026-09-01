/**
 * 📈 Saty ATR Levels & Volatility Range Utilization Engine
 * 
 * Implements Saty Mahajan's ATR Levels methodology:
 * Projects Fibonacci ratio bands from previous period close scaled by ATR(14).
 * 
 * Bands & Reaction Targets:
 *  - Trigger Cloud: ±0.236 ATR (Long/Short Breakout Trigger)
 *  - Half-Range / Pullback: ±0.382 ATR & ±0.500 ATR
 *  - Key Mid-Target: ±0.618 ATR (Golden Ratio Mean Reversion Target)
 *  - Full 1-ATR Target: ±1.000 ATR (Expected Daily Volatility Ceiling/Floor)
 *  - Trend Extensions: ±1.236, ±1.382, ±1.618, ±2.000, ±3.000 ATR
 */

const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('SatyAtrEngine');

class SatyAtrEngine {
  constructor(config = {}) {
    this.atrPeriod = config.atrPeriod || 14;
    this.fibRatios = [0.236, 0.382, 0.500, 0.618, 0.786, 1.000, 1.236, 1.382, 1.618, 2.000, 3.000];
  }

  /**
   * Calculate True Range for a series of candles
   * @param {Array<Object>} candles - Array of { open, high, low, close }
   */
  calculateAtr(candles, period = this.atrPeriod) {
    if (!candles || candles.length < 2) return 0;

    const trValues = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - prev.close),
        Math.abs(current.low - prev.close)
      );
      trValues.push(tr);
    }

    if (trValues.length < period) {
      return trValues.reduce((a, b) => a + b, 0) / trValues.length;
    }

    // Wilder's Smoothing / RMA for ATR
    let atr = trValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }

    return parseFloat(atr.toFixed(4));
  }

  /**
   * Compute full Saty ATR Levels grid based on previous close and current ATR
   * @param {number} prevClose - Previous session close price
   * @param {number} currentPrice - Live market price
   * @param {number} atrValue - Current ATR(14)
   */
  calculateLevels(prevClose, currentPrice, atrValue) {
    if (!prevClose || !atrValue || atrValue <= 0) {
      return null;
    }

    const upperLevels = {};
    const lowerLevels = {};

    this.fibRatios.forEach(ratio => {
      const key = `${(ratio * 100).toFixed(1)}%`;
      upperLevels[key] = parseFloat((prevClose + (ratio * atrValue)).toFixed(2));
      lowerLevels[key] = parseFloat((prevClose - (ratio * atrValue)).toFixed(2));
    });

    // Calculate Range Utilization (% of 1-ATR moved from previous close)
    const priceDelta = currentPrice - prevClose;
    const rangeUtilizationPct = parseFloat(((Math.abs(priceDelta) / atrValue) * 100).toFixed(1));

    // Determine current regime / zone
    let activeZone = 'NEUTRAL_CORE';
    if (priceDelta > 0) {
      if (currentPrice >= upperLevels['161.8%']) activeZone = 'EXTREME_EXPANSION_LONG';
      else if (currentPrice >= upperLevels['100.0%']) activeZone = 'FULL_ATR_EXHAUSTION_LONG';
      else if (currentPrice >= upperLevels['61.8%']) activeZone = 'MID_TARGET_LONG';
      else if (currentPrice >= upperLevels['23.6%']) activeZone = 'TRIGGER_EXPANSION_LONG';
    } else {
      if (currentPrice <= lowerLevels['161.8%']) activeZone = 'EXTREME_EXPANSION_SHORT';
      else if (currentPrice <= lowerLevels['100.0%']) activeZone = 'FULL_ATR_EXHAUSTION_SHORT';
      else if (currentPrice <= lowerLevels['61.8%']) activeZone = 'MID_TARGET_SHORT';
      else if (currentPrice <= lowerLevels['23.6%']) activeZone = 'TRIGGER_EXPANSION_SHORT';
    }

    return {
      prevClose: parseFloat(prevClose.toFixed(2)),
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      atr: parseFloat(atrValue.toFixed(2)),
      rangeUtilizationPct,
      activeZone,
      triggerCloud: {
        longTrigger: upperLevels['23.6%'],
        shortTrigger: lowerLevels['23.6%']
      },
      targets: {
        longMid: upperLevels['61.8%'],
        shortMid: lowerLevels['61.8%'],
        longFullAtr: upperLevels['100.0%'],
        shortFullAtr: lowerLevels['100.0%'],
        longExtension: upperLevels['161.8%'],
        shortExtension: lowerLevels['161.8%']
      },
      grid: {
        upper: upperLevels,
        lower: lowerLevels
      }
    };
  }
}

const satyAtrEngine = new SatyAtrEngine();

module.exports = {
  SatyAtrEngine,
  satyAtrEngine
};
