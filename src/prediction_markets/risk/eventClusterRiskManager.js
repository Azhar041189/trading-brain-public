/**
 * 🛡️ Prediction Market Event Cluster & Hierarchical Risk Manager (Phase P2.5)
 * 
 * Prevents disguised macro concentration and pseudo-diversification across prediction markets.
 * Enforces hierarchical exposure caps and evaluates Joint Worst-Case Scenario Loss across correlated clusters.
 */

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('EventClusterRiskManager');

class EventClusterRiskManager {
  constructor(config = {}) {
    this.totalPaperBankrollUSD = config.totalPaperBankrollUSD || 10000.0;
    
    // Risk Constraints (% of paper bankroll)
    this.maxSingleMarketRiskPct = config.maxSingleMarketRiskPct || 0.02; // Max 2% per single market
    this.maxSubClusterRiskPct = config.maxSubClusterRiskPct || 0.06;     // Max 6% per sub-cluster
    this.maxParentFactorRiskPct = config.maxParentFactorRiskPct || 0.12; // Max 12% per parent factor
    this.maxSourceConcentrationPct = config.maxSourceConcentrationPct || 0.10; // Max 10% on single resolution source

    this.activePositions = new Map(); // positionId -> PositionRecord
  }

  /**
   * Evaluate whether a proposed prediction market position passes hierarchical cluster caps
   * @param {Object} proposed - { marketId, side, stakeUSD, subCluster, parentFactor, resolutionSource }
   * @returns {Object} { permitted: boolean, status: string, reason?: string, currentExposures: Object }
   */
  evaluatePositionRisk(proposed) {
    if (!proposed || !proposed.stakeUSD || proposed.stakeUSD <= 0) {
      return { permitted: false, status: 'INVALID_STAKE', reason: 'Stake must be positive' };
    }

    const stakeUSD = proposed.stakeUSD;
    const subCluster = proposed.subCluster || 'UNCLASSIFIED';
    const parentFactor = proposed.parentFactor || 'GENERAL_FACTORS';
    const source = proposed.resolutionSource || 'DEFAULT_ORACLE';
    const marketId = proposed.marketId || 'UNKNOWN_MARKET';

    // 1. Single Market Risk Cap
    const currentMarketStake = this._getCurrentMarketExposure(marketId);
    const maxSingleMarketUSD = this.totalPaperBankrollUSD * this.maxSingleMarketRiskPct;
    if (currentMarketStake + stakeUSD > maxSingleMarketUSD) {
      return {
        permitted: false,
        status: 'SINGLE_MARKET_CAP_EXCEEDED',
        reason: `Proposed stake ($${stakeUSD}) exceeds max single market limit of $${maxSingleMarketUSD.toFixed(2)} (Current: $${currentMarketStake.toFixed(2)})`
      };
    }

    // 2. Sub-Cluster Risk Cap (e.g. FED_POLICY)
    const currentSubClusterStake = this._getClusterExposure('subCluster', subCluster);
    const maxSubClusterUSD = this.totalPaperBankrollUSD * this.maxSubClusterRiskPct;
    if (currentSubClusterStake + stakeUSD > maxSubClusterUSD) {
      return {
        permitted: false,
        status: 'SUB_CLUSTER_CAP_EXCEEDED',
        reason: `Sub-cluster '${subCluster}' exposure ($${(currentSubClusterStake + stakeUSD).toFixed(2)}) exceeds cap of $${maxSubClusterUSD.toFixed(2)}`
      };
    }

    // 3. Parent Factor Risk Cap (e.g. GLOBAL_MACRO)
    const currentParentStake = this._getClusterExposure('parentFactor', parentFactor);
    const maxParentUSD = this.totalPaperBankrollUSD * this.maxParentFactorRiskPct;
    if (currentParentStake + stakeUSD > maxParentUSD) {
      return {
        permitted: false,
        status: 'PARENT_FACTOR_CAP_EXCEEDED',
        reason: `Parent factor '${parentFactor}' exposure ($${(currentParentStake + stakeUSD).toFixed(2)}) exceeds cap of $${maxParentUSD.toFixed(2)}`
      };
    }

    // 4. Resolution Source Concentration Cap
    const currentSourceStake = this._getClusterExposure('resolutionSource', source);
    const maxSourceUSD = this.totalPaperBankrollUSD * this.maxSourceConcentrationPct;
    if (currentSourceStake + stakeUSD > maxSourceUSD) {
      return {
        permitted: false,
        status: 'SOURCE_CONCENTRATION_EXCEEDED',
        reason: `Resolution source '${source}' exposure ($${(currentSourceStake + stakeUSD).toFixed(2)}) exceeds cap of $${maxSourceUSD.toFixed(2)}`
      };
    }

    return {
      permitted: true,
      status: 'RISK_PERMITTED',
      currentExposures: {
        marketUSD: currentMarketStake + stakeUSD,
        subClusterUSD: currentSubClusterStake + stakeUSD,
        parentFactorUSD: currentParentStake + stakeUSD,
        sourceUSD: currentSourceStake + stakeUSD
      }
    };
  }

  /**
   * Register an accepted paper position
   */
  registerPosition(position) {
    const posId = position.positionId || `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const record = {
      ...position,
      positionId: posId,
      registeredAt: new Date().toISOString()
    };
    this.activePositions.set(posId, record);
    logger.info(`💼 [EventClusterRisk] Registered position ${posId} in cluster '${record.subCluster}' ($${record.stakeUSD})`);
    return record;
  }

  /**
   * Remove or close a paper position
   */
  removePosition(positionId) {
    return this.activePositions.delete(positionId);
  }

  /**
   * Calculate Joint Worst-Case Scenario Loss across all open positions under correlated state stress
   * @param {string} stressedFactor - Factor assumed to fail/resolve adversely
   */
  calculateJointWorstCaseLoss(stressedFactor = 'GLOBAL_MACRO') {
    let totalWorstCaseLossUSD = 0;
    const affectedPositions = [];

    for (const pos of this.activePositions.values()) {
      if (pos.parentFactor === stressedFactor || pos.subCluster === stressedFactor || stressedFactor === 'ALL') {
        totalWorstCaseLossUSD += pos.stakeUSD;
        affectedPositions.push(pos);
      }
    }

    const lossPctOfBankroll = parseFloat(((totalWorstCaseLossUSD / this.totalPaperBankrollUSD) * 100).toFixed(2));

    return {
      stressedFactor,
      affectedPositionsCount: affectedPositions.length,
      totalWorstCaseLossUSD: parseFloat(totalWorstCaseLossUSD.toFixed(2)),
      lossPctOfBankroll,
      isAcceptable: lossPctOfBankroll <= (this.maxParentFactorRiskPct * 100)
    };
  }

  // ============ PRIVATE HELPERS ============

  _getCurrentMarketExposure(marketId) {
    let sum = 0;
    for (const pos of this.activePositions.values()) {
      if (pos.marketId === marketId) sum += pos.stakeUSD;
    }
    return sum;
  }

  _getClusterExposure(property, value) {
    let sum = 0;
    for (const pos of this.activePositions.values()) {
      if (pos[property] === value) sum += pos.stakeUSD;
    }
    return sum;
  }
}

const eventClusterRiskManager = new EventClusterRiskManager();
module.exports = { EventClusterRiskManager, eventClusterRiskManager };
