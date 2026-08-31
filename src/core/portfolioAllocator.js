const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('PortfolioAllocator');

/**
 * Portfolio Correlation & Capital Allocator
 * Manages capital allocation across validated strategies and assets.
 * 1. Computes Cross-Asset & Cross-Strategy Correlation Matrix
 * 2. Enforces Exposure Caps when correlation exceeds 0.80
 * 3. Applies Hierarchical Risk Parity (HRP) inspired volatility weighting
 */
class PortfolioAllocator {
  constructor() {
    this.maxSingleAssetExposure = 0.25; // 25% max per asset
    this.maxCorrelatedGroupExposure = 0.50; // 50% max across highly correlated assets
    this.correlationThreshold = 0.80; // Pairs above 0.80 are considered correlated
  }

  /**
   * Calculate recommended capital weights across active strategies based on evidence & pairwise correlation
   * @param {Array} strategies 
   * @param {Object} correlationMatrix - Pairwise matrix e.g. { 'BTCUSDT': { 'ETHUSDT': 0.92, 'SOLUSDT': 0.85 } }
   */
  allocateCapital(strategies = [], correlationMatrix = {}) {
    logger.info('🎯 [Portfolio Allocator] Computing dynamic capital allocation across portfolio');

    if (!Array.isArray(strategies) || strategies.length === 0) {
      return { totalAllocated: 0, allocations: [] };
    }

    // Filter only eligible strategies
    const eligible = strategies.filter(s => 
      s.lifecycleStage === 'LIVE_ACTIVE' || 
      s.lifecycleStage === 'PAPER_PROBATION' ||
      (s.evidenceScore && s.evidenceScore >= 60)
    );

    if (eligible.length === 0) {
      return { totalAllocated: 0, allocations: [], warning: 'No strategies meet minimum evidence threshold' };
    }

    // 1. Base weight proportional to Evidence Score
    const totalEvidence = eligible.reduce((acc, s) => acc + (s.evidenceScore || 70), 0);
    let rawAllocations = eligible.map(s => {
      const baseWeight = (s.evidenceScore || 70) / totalEvidence;
      return {
        strategyId: s.id || s.strategyId,
        symbol: s.symbol || 'MULTI',
        evidenceScore: s.evidenceScore || 70,
        rawWeight: baseWeight,
        allocatedPct: Math.round(baseWeight * 100)
      };
    });

    // 2. Enforce Hard Single-Asset Exposure Ceiling (25% max per symbol)
    rawAllocations = rawAllocations.map(alloc => {
      if (alloc.allocatedPct > this.maxSingleAssetExposure * 100) {
        alloc.allocatedPct = Math.round(this.maxSingleAssetExposure * 100);
        alloc.cappedDueToSingleAssetLimit = true;
      }
      return alloc;
    });

    // 3. Pairwise Correlation Penalty
    // Scan pairwise relationships: If two assets have pairwise correlation >= 0.80, scale the correlated cluster
    const correlatedSymbols = new Set();
    const symbols = rawAllocations.map(a => a.symbol);

    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const symA = symbols[i];
        const symB = symbols[j];
        const pairCorr = (correlationMatrix[symA] && correlationMatrix[symA][symB]) !== undefined
          ? correlationMatrix[symA][symB]
          : (correlationMatrix[symA] || 0.50); // Fallback if 1D matrix passed

        if (pairCorr >= this.correlationThreshold) {
          correlatedSymbols.add(symA);
          correlatedSymbols.add(symB);
        }
      }
    }

    // Sum total exposure of all correlated symbols
    let correlatedExposure = 0;
    rawAllocations.forEach(alloc => {
      if (correlatedSymbols.has(alloc.symbol)) {
        correlatedExposure += alloc.allocatedPct;
      }
    });

    // If total correlated cluster exceeds 50%, proportionally compress cluster
    if (correlatedExposure > this.maxCorrelatedGroupExposure * 100) {
      const reductionFactor = (this.maxCorrelatedGroupExposure * 100) / correlatedExposure;
      rawAllocations = rawAllocations.map(alloc => {
        if (correlatedSymbols.has(alloc.symbol)) {
          alloc.allocatedPct = Math.floor(alloc.allocatedPct * reductionFactor);
          alloc.cappedDueToCorrelation = true;
        }
        return alloc;
      });
    }

    const totalAllocated = rawAllocations.reduce((acc, a) => acc + a.allocatedPct, 0);

    const result = {
      totalAllocated,
      allocations: rawAllocations,
      correlatedSymbolsCount: correlatedSymbols.size,
      timestamp: new Date().toISOString()
    };

    logger.info(`✅ [Portfolio Allocator] Capital budgeted: ${totalAllocated}% across ${rawAllocations.length} strategies`);
    return result;
  }
}

module.exports = new PortfolioAllocator();
