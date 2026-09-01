/**
 * 🏛️ Institutional Fund & Kelly Vault Engine (Stage 3)
 * 
 * Manages institutional risk-budgeting, fractional Kelly sizing,
 * high-water mark tracking, and portfolio drawdown protection.
 */

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('InstitutionalVaultEngine');

class InstitutionalVaultEngine {
  constructor(config = {}) {
    this.totalVaultCapitalUSD = config.totalVaultCapitalUSD || 10000.00; // Simulated $10,000 baseline vault
    this.highWaterMarkUSD = this.totalVaultCapitalUSD;
    this.maxDailyDrawdownPct = config.maxDailyDrawdownPct || 0.05; // 5% max daily drawdown stop
    this.maxClusterRiskPct = config.maxClusterRiskPct || 0.05; // 5% max exposure per event cluster
    this.maxSingleTradePct = config.maxSingleTradePct || 0.02; // 2% max per single market
    this.kellyMultiplier = config.kellyMultiplier || 0.25; // Quarter-Kelly (κ = 0.25)
    this.isCircuitBreakerTripped = false;
    this.clusterAllocations = new Map(); // clusterName -> currentCapitalUSD
  }

  /**
   * Calculate Fractional Kelly Position Size
   * @param {number} p - Estimated true probability of winning (0 to 1)
   * @param {number} marketAsk - Current decimal price to buy outcome (e.g. 0.40)
   * @returns {Object} { shares, capitalToRiskUSD, rawKellyFraction, fractionalKellyFraction }
   */
  calculateKellySize(p, marketAsk) {
    if (this.isCircuitBreakerTripped) {
      return { shares: 0, capitalToRiskUSD: 0, reason: 'CIRCUIT_BREAKER_ACTIVE' };
    }

    if (p <= marketAsk || marketAsk <= 0 || marketAsk >= 1) {
      return { shares: 0, capitalToRiskUSD: 0, reason: 'NO_POSITIVE_EDGE' };
    }

    // Odds b = (Payout - Cost) / Cost = (1.00 - marketAsk) / marketAsk
    const b = (1.00 - marketAsk) / marketAsk;
    const q = 1.00 - p;

    // Full Kelly fraction f* = (b * p - q) / b
    const rawKelly = (b * p - q) / b;

    if (rawKelly <= 0) {
      return { shares: 0, capitalToRiskUSD: 0, reason: 'NEGATIVE_KELLY' };
    }

    // Apply Fractional Kelly safety scaling (e.g. 0.25)
    let fractionalKelly = rawKelly * this.kellyMultiplier;

    // Bound by single-trade maximum risk limit (e.g. 2% of vault)
    fractionalKelly = Math.min(fractionalKelly, this.maxSingleTradePct);

    const capitalToRiskUSD = parseFloat((this.totalVaultCapitalUSD * fractionalKelly).toFixed(2));
    const shares = Math.floor(capitalToRiskUSD / marketAsk);

    return {
      p,
      marketAsk,
      b: parseFloat(b.toFixed(3)),
      rawKellyFraction: parseFloat(rawKelly.toFixed(4)),
      fractionalKellyFraction: parseFloat(fractionalKelly.toFixed(4)),
      capitalToRiskUSD,
      shares,
      reason: 'OPTIMAL_FRACTIONAL_KELLY'
    };
  }

  /**
   * Evaluate if a trade complies with institutional cluster exposure caps
   */
  validateClusterExposure(clusterName, capitalUSD) {
    const current = this.clusterAllocations.get(clusterName) || 0;
    const maxAllowed = this.totalVaultCapitalUSD * this.maxClusterRiskPct;

    if (current + capitalUSD > maxAllowed) {
      return {
        allowed: false,
        reason: `CLUSTER_CAP_EXCEEDED (Current: $${current.toFixed(2)}, Requested: $${capitalUSD.toFixed(2)}, Cap: $${maxAllowed.toFixed(2)})`
      };
    }

    return { allowed: true, currentAllocationUSD: current, remainingUSD: maxAllowed - current };
  }

  /**
   * Update vault state with PnL and check High-Water Mark / Drawdown
   */
  recordTradePnl(pnlUSD) {
    this.totalVaultCapitalUSD += pnlUSD;

    if (this.totalVaultCapitalUSD > this.highWaterMarkUSD) {
      this.highWaterMarkUSD = this.totalVaultCapitalUSD;
    }

    const currentDrawdownPct = (this.highWaterMarkUSD - this.totalVaultCapitalUSD) / this.highWaterMarkUSD;

    if (currentDrawdownPct >= this.maxDailyDrawdownPct) {
      this.isCircuitBreakerTripped = true;
      logger.warn(`🚨 [InstitutionalVault] CIRCUIT BREAKER TRIPPED! Drawdown: ${(currentDrawdownPct * 100).toFixed(2)}% >= Cap: ${(this.maxDailyDrawdownPct * 100).toFixed(2)}%`);
    }

    return {
      totalVaultCapitalUSD: parseFloat(this.totalVaultCapitalUSD.toFixed(2)),
      highWaterMarkUSD: parseFloat(this.highWaterMarkUSD.toFixed(2)),
      currentDrawdownPct: parseFloat((currentDrawdownPct * 100).toFixed(2)),
      isCircuitBreakerTripped: this.isCircuitBreakerTripped
    };
  }

  getVaultStatus() {
    const drawdownPct = ((this.highWaterMarkUSD - this.totalVaultCapitalUSD) / this.highWaterMarkUSD) * 100;
    return {
      totalVaultCapitalUSD: parseFloat(this.totalVaultCapitalUSD.toFixed(2)),
      highWaterMarkUSD: parseFloat(this.highWaterMarkUSD.toFixed(2)),
      currentDrawdownPct: parseFloat(Math.max(0, drawdownPct).toFixed(2)),
      kellySafetyMultiplier: this.kellyMultiplier,
      maxSingleTradeRiskUSD: parseFloat((this.totalVaultCapitalUSD * this.maxSingleTradePct).toFixed(2)),
      isCircuitBreakerTripped: this.isCircuitBreakerTripped,
      clusterAllocations: Object.fromEntries(this.clusterAllocations)
    };
  }
}

const institutionalVaultEngine = new InstitutionalVaultEngine();
module.exports = { InstitutionalVaultEngine, institutionalVaultEngine };
