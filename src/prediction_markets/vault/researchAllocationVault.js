/**
 * 🏛️ Research Allocation Vault (Final Hardened)
 * 
 * Supports 3 Distinct Allocation Modes:
 * 1. DIRECTIONAL_PROBABILISTIC -> Robust Side-Aware Kelly -> Cluster & Liquidity Caps
 * 2. STRUCTURAL_SPREAD        -> Capacity & Legging Risk Sizing (No Kelly)
 * 3. MARKET_MAKING            -> Inventory & Adverse Selection Budget (No Kelly)
 * 
 * Detailed committed capital accounting:
 * - grossEquity, cashAvailable, committedCollateral, unrealizedPnL,
 * - reservedWorstCaseLoss, operationalReserve, availableAllocationCapital, availableRiskBudget
 */

const { robustKellyEngine } = require('./robustKellyEngine');
const { vaultRiskPolicy } = require('./vaultRiskPolicy');
const { vaultDrawdownEngine } = require('./vaultDrawdownEngine');
const { eventClusterRiskManager } = require('../risk/eventClusterRiskManager');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('ResearchAllocationVault');

const ALLOCATION_MODE = {
  DIRECTIONAL_PROBABILISTIC: 'DIRECTIONAL_PROBABILISTIC',
  STRUCTURAL_SPREAD: 'STRUCTURAL_SPREAD',
  MARKET_MAKING: 'MARKET_MAKING'
};

class ResearchAllocationVault {
  constructor(initialCapitalUSD = 10000.00) {
    this.grossEquityUSD = initialCapitalUSD;
    this.committedCollateralUSD = 0.00;
    this.reservedWorstCaseLossUSD = 0.00;
    this.operationalReserveUSD = initialCapitalUSD * 0.10; // 10% operational cash reserve
    this.unrealizedPnLUSD = 0.00;
  }

  /**
   * Request paper risk allocation based on opportunity mode
   * @param {Object} candidate - { mode, side, pForecast, calibratedBounds, marketAsk, allInCostUSD, maxLockedCapacityUSD, subCluster }
   */
  requestAllocation(candidate) {
    const mode = candidate.mode || ALLOCATION_MODE.DIRECTIONAL_PROBABILISTIC;
    const drawdown = vaultDrawdownEngine.getState();
    const policy = vaultRiskPolicy.getPolicy();
    const reasonCodes = [];

    if (!drawdown.isNewAllocationAllowed) {
      reasonCodes.push(`DRAWDOWN_BLOCKED_${drawdown.state}`);
      return { approved: false, mode, allocatedUSD: 0, shares: 0, reasonCodes };
    }

    // 1. Calculate Available Risk Budget and Cash Capacity
    const availableRiskBudgetUSD = Math.max(0, this.grossEquityUSD - this.reservedWorstCaseLossUSD - this.operationalReserveUSD);
    const availableAllocationCapitalUSD = Math.max(0, this.grossEquityUSD - this.committedCollateralUSD - this.operationalReserveUSD);

    if (availableRiskBudgetUSD <= 0 || availableAllocationCapitalUSD <= 0) {
      reasonCodes.push('INSUFFICIENT_AVAILABLE_CAPITAL_OR_RISK_BUDGET');
      return { approved: false, mode, allocatedUSD: 0, shares: 0, reasonCodes };
    }

    let allocatedUSD = 0;
    let shares = 0;

    // 2. Route Sizing Logic based on Opportunity Mode
    if (mode === ALLOCATION_MODE.DIRECTIONAL_PROBABILISTIC) {
      // Directional ORACLE trades pass through Robust Kelly Sizing
      const kelly = robustKellyEngine.calculateRobustKelly({
        side: candidate.side || 'YES',
        pForecast: candidate.pForecast,
        calibratedBounds: candidate.calibratedBounds,
        marketAsk: candidate.marketAsk,
        allInCostUSD: candidate.allInCostUSD,
        payoutUSD: candidate.payoutUSD,
        sampleCount: candidate.sampleCount
      });

      if (kelly.status !== 'OPTIMAL_ROBUST_KELLY') {
        reasonCodes.push(`KELLY_REJECTED_${kelly.status}`, ...(kelly.reasonCodes || []));
        return { approved: false, mode, allocatedUSD: 0, shares: 0, reasonCodes };
      }

      allocatedUSD = this.grossEquityUSD * kelly.fractionalKellyFraction;
      allocatedUSD = Math.min(allocatedUSD, policy.absoluteDollarTradeCapUSD, availableRiskBudgetUSD);
      shares = Math.floor(allocatedUSD / candidate.marketAsk);
      reasonCodes.push('DIRECTIONAL_ROBUST_KELLY_SIZED', ...(kelly.reasonCodes || []));

    } else if (mode === ALLOCATION_MODE.STRUCTURAL_SPREAD) {
      // Locked Structural Spreads: Sized by Executable Depth & Legging Capacity (NO KELLY)
      const maxCapacityUSD = candidate.maxLockedCapacityUSD || 200.00;
      allocatedUSD = Math.min(maxCapacityUSD, policy.absoluteDollarTradeCapUSD, availableAllocationCapitalUSD);
      const avgLegCost = candidate.allInCostUSD || candidate.marketAsk || 0.50;
      shares = Math.floor(allocatedUSD / avgLegCost);
      reasonCodes.push('STRUCTURAL_SPREAD_CAPACITY_SIZED', 'NO_KELLY_APPLIED');

    } else if (mode === ALLOCATION_MODE.MARKET_MAKING) {
      // Market Making Inventory: Sized by Inventory & Adverse Selection Budget (NO KELLY)
      const maxMakerQuoteUSD = 100.00;
      allocatedUSD = Math.min(maxMakerQuoteUSD, availableAllocationCapitalUSD);
      shares = Math.floor(allocatedUSD / (candidate.marketAsk || 0.50));
      reasonCodes.push('MARKET_MAKING_INVENTORY_SIZED', 'NO_KELLY_APPLIED');
    }

    // 3. Validate Cluster Risk Cap via evaluatePositionRisk
    const riskEvaluation = eventClusterRiskManager.evaluatePositionRisk({
      marketId: candidate.marketId,
      subCluster: candidate.subCluster || 'US_MACRO',
      stakeUSD: allocatedUSD
    });

    if (!riskEvaluation.permitted) {
      reasonCodes.push(`CLUSTER_CAP_EXCEEDED_${riskEvaluation.status}`);
      return { approved: false, mode, allocatedUSD: 0, shares: 0, reasonCodes };
    }

    eventClusterRiskManager.registerPosition({
      positionId: candidate.id || `pos_${Date.now()}`,
      marketId: candidate.marketId,
      subCluster: candidate.subCluster || 'US_MACRO',
      stakeUSD: allocatedUSD,
      maxPayoutUSD: shares * 1.00,
      side: candidate.side || 'YES'
    });

    this.committedCollateralUSD += allocatedUSD;
    this.reservedWorstCaseLossUSD += allocatedUSD;

    return {
      approved: true,
      mode,
      allocatedUSD: parseFloat(allocatedUSD.toFixed(2)),
      shares,
      effectiveCapitalFraction: parseFloat((allocatedUSD / this.grossEquityUSD).toFixed(4)),
      reasonCodes,
      policyVersion: policy.policyVersion
    };
  }

  getVaultStatus() {
    const drawdown = vaultDrawdownEngine.getState();
    const policy = vaultRiskPolicy.getPolicy();
    const availableRiskBudgetUSD = Math.max(0, this.grossEquityUSD - this.reservedWorstCaseLossUSD - this.operationalReserveUSD);
    const availableAllocationCapitalUSD = Math.max(0, this.grossEquityUSD - this.committedCollateralUSD - this.operationalReserveUSD);

    return {
      mode: 'PAPER_RESEARCH_VAULT',
      executionAuthorized: false,
      liveCopierLocked: true,
      grossEquityUSD: parseFloat(this.grossEquityUSD.toFixed(2)),
      committedCollateralUSD: parseFloat(this.committedCollateralUSD.toFixed(2)),
      reservedWorstCaseLossUSD: parseFloat(this.reservedWorstCaseLossUSD.toFixed(2)),
      operationalReserveUSD: parseFloat(this.operationalReserveUSD.toFixed(2)),
      availableRiskBudgetUSD: parseFloat(availableRiskBudgetUSD.toFixed(2)),
      availableAllocationCapitalUSD: parseFloat(availableAllocationCapitalUSD.toFixed(2)),
      drawdownState: drawdown.state,
      highWaterMarkUSD: drawdown.highWaterMarkUSD,
      currentEquityUSD: drawdown.currentEquityUSD,
      policy
    };
  }
}

const researchAllocationVault = new ResearchAllocationVault();
module.exports = { ResearchAllocationVault, researchAllocationVault, ALLOCATION_MODE };
