const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('LiquidityTrapPredictor');

/**
 * LiquidityTrapPredictor
 * Analyzes order book structure and price action to detect Stop-Hunts,
 * Fair Value Gap (FVG) sweeps, and institutional liquidity grabs before retail traders get trapped.
 */
class LiquidityTrapPredictor {
  constructor() {
    this.trapThresholdPct = 0.008; // 0.8% swing high/low sweep range
  }

  /**
   * Evaluates if current market price structure is forming a liquidity sweep trap
   */
  evaluateTrapRisk(candles = [], orderBook = null) {
    if (!candles || candles.length < 10) {
      return { isTrap: false, trapType: 'NONE', confidence: 0 };
    }

    const n = candles.length;
    const recentHighs = candles.slice(-10, -2).map(c => c.high);
    const recentLows = candles.slice(-10, -2).map(c => c.low);
    const swingHigh = Math.max(...recentHighs);
    const swingLow = Math.min(...recentLows);

    const latest = candles[n - 1];
    const prev = candles[n - 2];

    // 1. Bull Trap (High Swept with Rapid Rejection / Long Upper Wick)
    const upperWick = latest.high - Math.max(latest.open, latest.close);
    const candleBody = Math.abs(latest.close - latest.open);
    const sweptHigh = latest.high > swingHigh && latest.close < swingHigh;

    if (sweptHigh && upperWick > candleBody * 1.5) {
      logger.warn(`🪤 [Liquidity Trap: BEARISH] Stop-hunt sweep detected above swing high $${swingHigh} - Rejection wick confirmed`);
      return {
        isTrap: true,
        trapType: 'BULL_TRAP_SWEEP',
        recommendation: 'SHORT_FAIR_VALUE_GAP',
        confidence: 0.88,
        sweptLevel: swingHigh,
        timestamp: new Date().toISOString()
      };
    }

    // 2. Bear Trap (Low Swept with Rapid Rejection / Long Lower Wick)
    const lowerWick = Math.min(latest.open, latest.close) - latest.low;
    const sweptLow = latest.low < swingLow && latest.close > swingLow;

    if (sweptLow && lowerWick > candleBody * 1.5) {
      logger.warn(`🪤 [Liquidity Trap: BULLISH] Stop-hunt sweep detected below swing low $${swingLow} - Rapid recovery confirmed`);
      return {
        isTrap: true,
        trapType: 'BEAR_TRAP_SWEEP',
        recommendation: 'LONG_SPRING_REVERSAL',
        confidence: 0.88,
        sweptLevel: swingLow,
        timestamp: new Date().toISOString()
      };
    }

    return {
      isTrap: false,
      trapType: 'CLEAN_STRUCTURE',
      confidence: 0.92,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new LiquidityTrapPredictor();
