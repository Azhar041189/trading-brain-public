/**
 * ⚡ Cross-Venue Structural Spread Scanner (Final Frozen Specification)
 * 
 * Enforces:
 * 1. Semantic Equivalence Gate (EXACT_EQUIVALENT required).
 * 2. Robust RTT Latency Uncertainty Skew Gate:
 *    nominalSkew + polyRTTUncertainty + kalshiRTTUncertainty <= allowedCrossVenueSkewMs
 * 3. Lifecycle States:
 *    THEORETICAL_SPREAD ➔ EXACT_CONTRACT_MATCH ➔ EXECUTABLE_BOTH_VENUES ➔
 *    PAPER_LOCK_ATTEMPT ➔ BOTH_LEGS_FILLED ➔ PAPER_LOCKED_SPREAD / RESOLUTION_DIVERGENCE_RISK
 */

const { polymarketProvider } = require('../providers/polymarketProvider');
const { kalshiProvider } = require('../providers/kalshiProvider');
const { crossVenueContractEquivalenceEngine } = require('../contracts/crossVenueContractEquivalenceEngine');
const { kalshiFeeScheduleEngine } = require('../contracts/kalshiFeeScheduleEngine');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('CrossVenueStructuralSpreadScanner');

const SPREAD_STATUS = {
  THEORETICAL_SPREAD: 'THEORETICAL_SPREAD',
  EXACT_CONTRACT_MATCH: 'EXACT_CONTRACT_MATCH',
  EXECUTABLE_BOTH_VENUES: 'EXECUTABLE_BOTH_VENUES',
  PAPER_LOCK_ATTEMPT: 'PAPER_LOCK_ATTEMPT',
  BOTH_LEGS_FILLED: 'BOTH_LEGS_FILLED',
  PAPER_LOCKED_SPREAD: 'PAPER_LOCKED_SPREAD',
  LEG_ONE_FILLED: 'LEG_ONE_FILLED',
  LEGGING_RISK: 'LEGGING_RISK',
  REJECTED_RULE_MISMATCH: 'REJECTED_RULE_MISMATCH',
  INSUFFICIENT_DEPTH: 'INSUFFICIENT_DEPTH',
  NEGATIVE_ROBUST_SPREAD: 'NEGATIVE_ROBUST_SPREAD',
  STALE_MARKET_PAIR: 'STALE_MARKET_PAIR',
  RESOLUTION_DIVERGENCE_RISK: 'RESOLUTION_DIVERGENCE_RISK'
};

class CrossVenueStructuralSpreadScanner {
  constructor(config = {}) {
    this.minimumResearchEdge = config.minimumResearchEdge || 0.010; // 1.0% min robust edge
    this.allowedCrossVenueSkewMs = config.allowedCrossVenueSkewMs || 1500; // 1.5s robust skew threshold
    this.basisStress = config.basisStress || 0.0020; // 20 bps basis stress buffer
    this.executionLatencyBuffer = config.executionLatencyBuffer || 0.0030; // 30 bps legging buffer
    this.testQuantities = config.testQuantities || [1, 10, 50, 100];
    this.opportunities = [];
    this.paperLockedSpreads = new Map(); // spreadId -> LockedSpreadRecord
  }

  async scanStructuralSpreads() {
    try {
      logger.info('🔍 [CrossVenueScanner] Starting structural spread scan across Polymarket & Kalshi...');

      const [polyMarkets, kalshiMarkets] = await Promise.all([
        polymarketProvider.getMarkets({ limit: 40, active: true, closed: false }),
        kalshiProvider.getMarkets({ limit: 40, status: 'open' })
      ]);

      const opportunities = [];

      for (const pMarket of polyMarkets) {
        for (const kMarket of kalshiMarkets) {
          const snapshotA = this._buildPolySnapshot(pMarket);
          const snapshotB = this._buildKalshiSnapshot(kMarket);

          const equiv = crossVenueContractEquivalenceEngine.evaluateEquivalence(snapshotA, snapshotB);

          if (equiv.classification !== 'EXACT_EQUIVALENT') {
            continue;
          }

          const evaluation = await this.evaluateSpreadDepth(pMarket, kMarket, equiv);
          if (evaluation) {
            opportunities.push(evaluation);
          }
        }
      }

      this.opportunities = opportunities;
      logger.info(`🎯 [CrossVenueScanner] Found ${opportunities.length} validated cross-venue structural spreads.`);
      return opportunities;
    } catch (err) {
      logger.error(`❌ [CrossVenueScanner] Scan failed: ${err.message}`);
      return [];
    }
  }

  async evaluateSpreadDepth(polyMarket, kalshiMarket, equivRecord) {
    try {
      const polyYesTokenId = polyMarket.tokenIds?.yes;
      if (!polyYesTokenId) return null;

      const [polyBook, kalshiBook] = await Promise.all([
        polymarketProvider.getOrderBook(polyYesTokenId),
        kalshiProvider.getOrderBook(kalshiMarket.ticker)
      ]);

      // Robust Latency Uncertainty Calculation
      const polyTime = new Date(polyBook.timestamp || polyBook.observedAt || Date.now()).getTime();
      const kalshiTime = new Date(kalshiBook.timestamp || kalshiBook.observedAt || Date.now()).getTime();
      const nominalSkewMs = Math.abs(polyTime - kalshiTime);

      const polyRTTUncertaintyMs = polyBook.timestampUncertaintyMs || 25;
      const kalshiRTTUncertaintyMs = kalshiBook.timestampUncertaintyMs || 100;
      const robustWorstCaseSkewMs = nominalSkewMs + polyRTTUncertaintyMs + kalshiRTTUncertaintyMs;

      if (robustWorstCaseSkewMs > this.allowedCrossVenueSkewMs) {
        return {
          id: `xspread_stale_${Date.now()}`,
          polyMarket: { id: polyMarket.id, question: polyMarket.question || polyMarket.title },
          kalshiMarket: { ticker: kalshiMarket.ticker, title: kalshiMarket.title },
          status: SPREAD_STATUS.STALE_MARKET_PAIR,
          nominalSkewMs,
          robustWorstCaseSkewMs,
          allowedSkewLimitMs: this.allowedCrossVenueSkewMs,
          reasonCodes: ['CROSS_VENUE_SNAPSHOT_STALE', `Worst-case skew ${robustWorstCaseSkewMs}ms exceeds limit ${this.allowedCrossVenueSkewMs}ms`],
          depthCurve: []
        };
      }

      const depthEvaluations = [];

      for (const q of this.testQuantities) {
        const polyCost = this._computePolyAcquisitionCost(polyBook, 'YES', q, polyMarket.category);
        const kalshiCost = this._computeKalshiAcquisitionCost(kalshiBook, 'NO', q);

        if (!polyCost.hasDepth || !kalshiCost.hasDepth) {
          depthEvaluations.push({
            quantity: q,
            status: SPREAD_STATUS.INSUFFICIENT_DEPTH,
            reasonCodes: [!polyCost.hasDepth ? 'POLY_INSUFFICIENT_DEPTH' : 'KALSHI_INSUFFICIENT_DEPTH'],
            robustSpread: 0
          });
          continue;
        }

        const lockedGrossValue = q * 1.00;
        const totalAllInCost = polyCost.totalCostUSD + kalshiCost.totalCostUSD;
        const nominalSpread = (lockedGrossValue - totalAllInCost) / lockedGrossValue;
        const robustSpread = nominalSpread - this.basisStress - this.executionLatencyBuffer;
        const isExecutable = robustSpread >= this.minimumResearchEdge;

        depthEvaluations.push({
          quantity: q,
          polyAvgPrice: polyCost.avgPrice,
          kalshiAvgPrice: kalshiCost.avgPrice,
          polyTotalCostUSD: polyCost.totalCostUSD,
          kalshiTotalCostUSD: kalshiCost.totalCostUSD,
          nominalSpread: parseFloat(nominalSpread.toFixed(4)),
          robustSpread: parseFloat(robustSpread.toFixed(4)),
          status: isExecutable ? SPREAD_STATUS.EXECUTABLE_BOTH_VENUES : SPREAD_STATUS.NEGATIVE_ROBUST_SPREAD,
          reasonCodes: isExecutable ? ['ROBUST_EDGE_PASSED'] : ['NEGATIVE_AFTER_FEES_AND_BASIS_STRESS'],
          isExecutable
        });
      }

      const bestDepth = depthEvaluations.find(d => d.isExecutable) || depthEvaluations[0];

      return {
        id: `xspread_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        polyMarket: { id: polyMarket.id, question: polyMarket.question || polyMarket.title },
        kalshiMarket: { ticker: kalshiMarket.ticker, title: kalshiMarket.title },
        equivalenceClassification: equivRecord.classification,
        nominalSkewMs,
        robustWorstCaseSkewMs,
        bestExecutableDepth: bestDepth,
        depthCurve: depthEvaluations,
        timestamp: new Date().toISOString()
      };
    } catch (e) {
      logger.warn(`⚠️ [CrossVenueScanner] Depth evaluation error: ${e.message}`);
      return null;
    }
  }

  /**
   * Monitor Paper Locked Spreads for semantic mutation / resolution divergence
   */
  monitorPaperLockedSpreads(spreadRecord, currentSnapshotA, currentSnapshotB) {
    const currentEquiv = crossVenueContractEquivalenceEngine.evaluateEquivalence(currentSnapshotA, currentSnapshotB);
    
    if (currentEquiv.classification !== 'EXACT_EQUIVALENT') {
      spreadRecord.status = SPREAD_STATUS.RESOLUTION_DIVERGENCE_RISK;
      spreadRecord.reasonCodes.push('SEMANTIC_MUTATION_DETECTED', `Drift: ${currentEquiv.classification}`);
      logger.error(`🚨 [CrossVenueScanner] POST-LOCK RESOLUTION DIVERGENCE DETECTED for spread ${spreadRecord.id}!`);
      return spreadRecord;
    }

    spreadRecord.status = SPREAD_STATUS.PAPER_LOCKED_SPREAD;
    return spreadRecord;
  }

  _computePolyAcquisitionCost(book, side, quantity, category) {
    const asks = side === 'YES' ? book.asks : book.bids;
    let remaining = quantity;
    let totalCostUSD = 0;

    for (const level of (asks || [])) {
      const take = Math.min(remaining, level.size);
      const levelPrice = side === 'YES' ? level.price : (1.0 - level.price);
      totalCostUSD += take * levelPrice;
      remaining -= take;
      if (remaining <= 0) break;
    }

    if (remaining > 0) return { hasDepth: false };

    const avgPrice = totalCostUSD / quantity;
    const feeRate = (category || '').toLowerCase().includes('crypto') ? 0.07 : 0.00;
    const feeUSD = quantity * feeRate * avgPrice * (1.0 - avgPrice);

    return {
      hasDepth: true,
      avgPrice: parseFloat(avgPrice.toFixed(4)),
      rawCostUSD: parseFloat(totalCostUSD.toFixed(2)),
      feeUSD: parseFloat(feeUSD.toFixed(3)),
      totalCostUSD: parseFloat((totalCostUSD + feeUSD).toFixed(2))
    };
  }

  _computeKalshiAcquisitionCost(book, side, quantity) {
    const asks = side === 'YES' ? book.asks : (book.noAsks || book.asks);
    let remaining = quantity;
    let totalCostUSD = 0;

    for (const level of (asks || [])) {
      const take = Math.min(remaining, level.size);
      totalCostUSD += take * level.price;
      remaining -= take;
      if (remaining <= 0) break;
    }

    if (remaining > 0) return { hasDepth: false };

    const avgPrice = totalCostUSD / quantity;
    const feeRes = kalshiFeeScheduleEngine.calculateTakerFee({ price: avgPrice, shares: quantity });

    return {
      hasDepth: true,
      avgPrice: parseFloat(avgPrice.toFixed(4)),
      rawCostUSD: parseFloat(totalCostUSD.toFixed(2)),
      feeUSD: feeRes.totalFeeUSD,
      totalCostUSD: parseFloat((totalCostUSD + feeRes.totalFeeUSD).toFixed(2))
    };
  }

  _buildPolySnapshot(m) {
    return {
      venue: 'POLYMARKET',
      marketId: m.id,
      title: m.question || m.title || '',
      resolutionSource: m.resolutionSource || 'Official Government / UMA',
      resolutionEndTimestamp: m.endDate || m.resolutionTime,
      timezone: 'UTC',
      outcomes: ['YES', 'NO'],
      resolutionRules: m.rulesText || m.description || ''
    };
  }

  _buildKalshiSnapshot(m) {
    return {
      venue: 'KALSHI',
      marketId: m.ticker,
      title: m.title,
      resolutionSource: m.settlementSource || 'Official Government / UMA',
      resolutionEndTimestamp: m.expirationTime,
      timezone: 'UTC',
      outcomes: ['YES', 'NO'],
      resolutionRules: m.rulesText || m.subtitle || ''
    };
  }

  getOpportunities() {
    return this.opportunities;
  }
}

const crossVenueStructuralSpreadScanner = new CrossVenueStructuralSpreadScanner();
module.exports = { CrossVenueStructuralSpreadScanner, crossVenueStructuralSpreadScanner, SPREAD_STATUS };
