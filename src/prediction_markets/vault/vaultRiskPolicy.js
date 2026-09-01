/**
 * 📜 Versioned Vault Risk Policy (Stage 3)
 */

const crypto = require('crypto');

const RISK_POLICY_DEFAULTS = {
  policyVersion: 'risk_policy_v2026_q3',
  effectiveFrom: '2026-08-01T00:00:00Z',
  singleMarketRiskCap: 0.02,       // 2% max per single market
  clusterRiskCap: 0.05,            // 5% max per correlated event cluster
  parentFactorRiskCap: 0.12,       // 12% max across all macro
  dailyLossLimit: 0.05,            // 5% daily loss cutoff (session UTC reset)
  maxPortfolioDrawdown: 0.10,      // 10% peak portfolio drawdown breaker
  quarterKellyFraction: 0.25,      // κ = 0.25
  absoluteDollarTradeCapUSD: 250.00
};

class VaultRiskPolicy {
  constructor(config = {}) {
    this.policy = { ...RISK_POLICY_DEFAULTS, ...config };
    this.parameterHash = crypto.createHash('sha256').update(JSON.stringify(this.policy)).digest('hex').slice(0, 16);
  }

  getPolicy() {
    return {
      ...this.policy,
      parameterHash: this.parameterHash
    };
  }
}

const vaultRiskPolicy = new VaultRiskPolicy();
module.exports = { VaultRiskPolicy, vaultRiskPolicy, RISK_POLICY_DEFAULTS };
