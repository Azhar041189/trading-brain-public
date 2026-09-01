/**
 * 🛡️ Dual-Control Vault Drawdown & Circuit Breaker Engine (Stage 3)
 * 
 * Separates:
 * 1. Daily Loss Limit: Resets at governed session boundary (00:00 UTC).
 * 2. Portfolio Peak High-Water Mark Drawdown: Never resets automatically.
 * 
 * States:
 * - NORMAL
 * - RISK_REDUCED
 * - NEW_RISK_HALTED
 * - EMERGENCY_FLATTEN
 */

const { vaultRiskPolicy } = require('./vaultRiskPolicy');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('VaultDrawdownEngine');

const DRAWDOWN_STATE = {
  NORMAL: 'NORMAL',
  RISK_REDUCED: 'RISK_REDUCED',
  NEW_RISK_HALTED: 'NEW_RISK_HALTED',
  EMERGENCY_FLATTEN: 'EMERGENCY_FLATTEN'
};

class VaultDrawdownEngine {
  constructor(initialCapitalUSD = 10000.00) {
    this.policy = vaultRiskPolicy.getPolicy();
    this.highWaterMarkUSD = initialCapitalUSD;
    this.dayStartEquityUSD = initialCapitalUSD;
    this.currentEquityUSD = initialCapitalUSD;
    this.lastSessionResetTimestamp = new Date().toISOString();
    this.state = DRAWDOWN_STATE.NORMAL;
  }

  /**
   * Update equity and evaluate daily vs portfolio drawdowns
   */
  updateEquity(newEquityUSD) {
    this.currentEquityUSD = newEquityUSD;

    // Check if new High-Water Mark achieved
    if (this.currentEquityUSD > this.highWaterMarkUSD) {
      this.highWaterMarkUSD = this.currentEquityUSD;
    }

    // 1. Daily Loss Drawdown
    const dailyDrawdownPct = Math.max(0, (this.dayStartEquityUSD - this.currentEquityUSD) / this.dayStartEquityUSD);

    // 2. Portfolio Peak Drawdown
    const portfolioDrawdownPct = Math.max(0, (this.highWaterMarkUSD - this.currentEquityUSD) / this.highWaterMarkUSD);

    // 3. State Evaluation
    if (portfolioDrawdownPct >= this.policy.maxPortfolioDrawdown) {
      this.state = DRAWDOWN_STATE.EMERGENCY_FLATTEN;
      logger.error(`🚨 [VaultDrawdown] PORTFOLIO PEAK DRAWDOWN BREACHED (${(portfolioDrawdownPct * 100).toFixed(2)}% >= ${(this.policy.maxPortfolioDrawdown * 100).toFixed(2)}%) -> EMERGENCY_FLATTEN!`);
    } else if (dailyDrawdownPct >= this.policy.dailyLossLimit) {
      this.state = DRAWDOWN_STATE.NEW_RISK_HALTED;
      logger.warn(`🛑 [VaultDrawdown] DAILY LOSS LIMIT HIT (${(dailyDrawdownPct * 100).toFixed(2)}% >= ${(this.policy.dailyLossLimit * 100).toFixed(2)}%) -> NEW RISK HALTED!`);
    } else if (dailyDrawdownPct >= this.policy.dailyLossLimit * 0.70) {
      this.state = DRAWDOWN_STATE.RISK_REDUCED;
    } else {
      this.state = DRAWDOWN_STATE.NORMAL;
    }

    return {
      state: this.state,
      currentEquityUSD: parseFloat(this.currentEquityUSD.toFixed(2)),
      highWaterMarkUSD: parseFloat(this.highWaterMarkUSD.toFixed(2)),
      dailyDrawdownPct: parseFloat((dailyDrawdownPct * 100).toFixed(2)),
      portfolioDrawdownPct: parseFloat((portfolioDrawdownPct * 100).toFixed(2)),
      isNewAllocationAllowed: this.state === DRAWDOWN_STATE.NORMAL || this.state === DRAWDOWN_STATE.RISK_REDUCED
    };
  }

  /**
   * Reset session boundary daily equity (UTC 00:00)
   */
  resetDailySession() {
    this.dayStartEquityUSD = this.currentEquityUSD;
    this.lastSessionResetTimestamp = new Date().toISOString();
    if (this.state === DRAWDOWN_STATE.NEW_RISK_HALTED) {
      this.state = DRAWDOWN_STATE.NORMAL;
    }
    logger.info(`🌅 [VaultDrawdown] Daily session reset at ${this.lastSessionResetTimestamp} (Day Start Equity: $${this.dayStartEquityUSD})`);
  }

  getState() {
    return {
      state: this.state,
      currentEquityUSD: parseFloat(this.currentEquityUSD.toFixed(2)),
      highWaterMarkUSD: parseFloat(this.highWaterMarkUSD.toFixed(2)),
      dayStartEquityUSD: parseFloat(this.dayStartEquityUSD.toFixed(2)),
      isNewAllocationAllowed: this.state === DRAWDOWN_STATE.NORMAL || this.state === DRAWDOWN_STATE.RISK_REDUCED
    };
  }
}

const vaultDrawdownEngine = new VaultDrawdownEngine();
module.exports = { VaultDrawdownEngine, vaultDrawdownEngine, DRAWDOWN_STATE };
