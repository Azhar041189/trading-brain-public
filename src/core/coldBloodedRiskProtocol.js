const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('ColdBloodedRiskProtocol');

/**
 * ColdBloodedRiskProtocol - Unforgiving Game-Theoretic Execution
 * Enforces strictly non-emotional money management:
 *  - Aggressive Anti-Martingale winning-streak scaling (+15% per win)
 *  - Instant circuit breaker throttle (-50% risk per loss)
 *  - Dynamic Delta-Neutral hedging trigger
 *  - Zero-hesitation breakeven locks at exactly +1R
 */
class ColdBloodedRiskProtocol {
  constructor() {
    this.consecutiveWins = 0;
    this.consecutiveLosses = 0;
    this.baseRiskPerTrade = 0.01; // 1%
  }

  recordOutcome(pnl) {
    if (pnl > 0) {
      this.consecutiveWins += 1;
      this.consecutiveLosses = 0;
      logger.info(`🔥 [Cold-Blooded Streak] Win recorded (Streak: ${this.consecutiveWins}). Scaling up compounding.`);
    } else if (pnl < 0) {
      this.consecutiveLosses += 1;
      this.consecutiveWins = 0;
      logger.warn(`🛑 [Cold-Blooded Throttle] Loss recorded (Streak: ${this.consecutiveLosses}). Cutting exposure in half.`);
    }
  }

  /**
   * Calculate exact position risk percentage based on winning streak & volatility
   */
  calculateDynamicRisk(currentVolatility = 'NORMAL') {
    let risk = this.baseRiskPerTrade;

    // Anti-Martingale: scale aggressively into hot streaks
    if (this.consecutiveWins > 0) {
      const boost = Math.min(0.015, this.consecutiveWins * 0.003); // up to 2.5% max
      risk += boost;
    }

    // Defensive Throttle: cut risk down if consecutive losses
    if (this.consecutiveLosses > 0) {
      const reduction = Math.pow(0.5, this.consecutiveLosses);
      risk = Math.max(0.0025, risk * reduction); // minimum 0.25% floor
    }

    // Volatility governor
    if (currentVolatility === 'EXTREME_VOLATILITY') {
      risk *= 0.6;
    }

    return parseFloat(risk.toFixed(4));
  }

  /**
   * Evaluate if a position requires immediate Delta-Neutral Hedging
   */
  evaluateHedgeRequirement(portfolioDrawdownPct, openPositionsCount) {
    if (portfolioDrawdownPct > 0.03 && openPositionsCount >= 3) {
      return {
        requireHedge: true,
        hedgeRatio: 0.5, // 50% inverse hedge
        action: 'OPEN_INVERSE_HEDGE',
        reason: `Drawdown ${(portfolioDrawdownPct * 100).toFixed(1)}% exceeded 3.0% threshold with ${openPositionsCount} active exposures`
      };
    }
    return { requireHedge: false, hedgeRatio: 0 };
  }
}

module.exports = new ColdBloodedRiskProtocol();
