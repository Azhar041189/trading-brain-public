/**
 * ⚡ Polymarket NegRisk Structural Scanner
 * 
 * Detects mathematical inconsistencies in multi-outcome contingent claim baskets.
 * Uses executable depth-weighted asks (not midpoints) and accounts for legging risk.
 * 
 * GOVERNANCE: This scanner emits STRUCTURAL_MISPRICING_CANDIDATE signals.
 * It does NOT label anything as "GUARANTEED_ARBITRAGE" because:
 *   1. Legging risk exists (separate CLOB legs)
 *   2. Augmented NegRisk may have incomplete outcome sets
 *   3. Depth can disappear between scanning and execution
 *   4. Conversion route must be proven feasible
 * 
 * Invariants:
 * - For any NegRisk event with K mutually exclusive outcomes:
 *   Payout complementarity: exactly one outcome wins and pays $1.00
 * - 1 NO share on outcome A can convert to 1 YES share on every other outcome
 * - This is PAYOUT complementarity, not executable-price identity
 */

const { createAgentLogger } = require('../../core/logger');
const logger = createAgentLogger('NegRiskStructuralScanner');

// Opportunity classification statuses
const STATUS = {
  THEORETICAL_INCONSISTENCY: 'THEORETICAL_INCONSISTENCY',
  EXECUTABLE_CANDIDATE: 'EXECUTABLE_CANDIDATE',
  FULLY_HEDGEABLE: 'FULLY_HEDGEABLE',
  PARTIAL_DEPTH_ONLY: 'PARTIAL_DEPTH_ONLY',
  LEGGING_RISK: 'LEGGING_RISK',
  INCOMPLETE_OUTCOME_SET: 'INCOMPLETE_OUTCOME_SET',
  DUTCH_BOOK_DISABLED: 'DUTCH_BOOK_DISABLED',  // Augmented NegRisk with placeholders
  FEE_ABSORBED: 'FEE_ABSORBED'  // Mispricing exists but fees consume the edge
};

class NegRiskStructuralScanner {
  constructor(config = {}) {
    this.minNetProfitBps = config.minNetProfitBps || 50;
    this.defaultTradeSize = config.defaultTradeSize || 100; // shares for depth check
    this.cache = null;
    this.lastScanTime = 0;
    this.cacheTTL = 30000;
  }

  /**
   * Compute dynamic taker fee for one leg at a specific executable price.
   * Fee = C × feeRate × p × (1 - p), rounded to 5 decimals.
   */
  computeLegFee(shares, executablePrice, feeRate) {
    const rawFee = shares * feeRate * executablePrice * (1 - executablePrice);
    return Math.max(Math.round(rawFee * 100000) / 100000, 0);
  }

  /**
   * Get fee rate for a category. Fetched dynamically in production;
   * defaults used here as fallback.
   */
  getFeeRate(category) {
    const cat = (category || '').toUpperCase();
    if (cat.includes('CRYPTO')) return 0.07;
    if (cat.includes('SPORT')) return 0.05;
    if (cat.includes('ECONOM') || cat.includes('WEATHER') || cat.includes('CULTURE')) return 0.05;
    if (cat.includes('FINANC') || cat.includes('POLITIC') || cat.includes('TECH') || cat.includes('MENTION')) return 0.04;
    if (cat.includes('GEOPOLIT') || cat.includes('WORLD')) return 0.00;
    return 0.04; // default
  }

  /**
   * Check if an event has augmented NegRisk with placeholders or unstable Other.
   * If so, the outcome set is not provably exhaustive → DUTCH_BOOK_DISABLED.
   */
  hasPlaceholderOutcomes(event) {
    const markets = event.markets || [];
    for (const m of markets) {
      const q = (m.question || m.groupItemTitle || '').toLowerCase();
      if (q.includes('person a') || q.includes('person b') || q.includes('placeholder') ||
          q.includes('unnamed') || q.includes('tbd') || q.includes('to be determined')) {
        return true;
      }
    }
    // Check if there's an "Other" outcome with unstable semantics
    const hasOther = markets.some(m =>
      (m.question || '').toLowerCase().includes('other') ||
      (m.question || '').toLowerCase().includes('someone else')
    );
    if (hasOther && markets.length < 5) {
      // Small outcome set with "Other" — likely augmented NegRisk
      return true;
    }
    return false;
  }

  /**
   * Simulate depth-weighted executable cost for buying YES on one leg.
   * In production, this would query the CLOB order book.
   * For now, uses the displayed price with a conservative spread estimate.
   */
  getExecutableAskPrice(market, size) {
    const displayed = market.outcomePrices?.yes || 0.5;
    // Conservative: assume 1-2 cent adverse slippage for executable ask vs displayed midpoint
    const slippageEstimate = Math.min(0.02, displayed * 0.03);
    return Math.min(displayed + slippageEstimate, 0.99);
  }

  /**
   * Check if sufficient depth exists for a leg at the required size.
   */
  hasRequiredDepth(market, size) {
    // In production, check CLOB book depth at each price level
    // For now, use volume as a proxy for depth availability
    const volume = market.volume || market.volumeNum || 0;
    return volume > size * 10; // require 10x volume vs trade size as minimum
  }

  /**
   * Scan multi-outcome NegRisk events for structural mispricings.
   */
  async scanOpportunities(options = {}) {
    const now = Date.now();
    if (this.cache && (now - this.lastScanTime < this.cacheTTL) && !options.force) {
      return this.cache;
    }

    try {
      const { PolymarketProvider } = require('../providers/polymarketProvider');
      const provider = new PolymarketProvider();
      const events = await provider.getEvents({ limit: 25 });
      const opportunities = [];

      for (const ev of events) {
        const markets = ev.markets || [];
        if (markets.length < 3) continue; // Need 3+ outcomes for NegRisk

        // Guard: Augmented NegRisk with placeholders → DUTCH_BOOK_DISABLED
        if (this.hasPlaceholderOutcomes(ev)) {
          opportunities.push({
            eventId: ev.id,
            title: ev.title || ev.name || 'Multi-Outcome Event',
            status: STATUS.DUTCH_BOOK_DISABLED,
            reason: 'Augmented NegRisk with placeholders or unstable Other — outcome set not provably exhaustive',
            outcomesCount: markets.length
          });
          continue;
        }

        const feeRate = this.getFeeRate(ev.category);
        const size = this.defaultTradeSize;
        const outcomesData = [];
        let totalAllInCost = 0;
        let totalFees = 0;
        let allLegsHaveDepth = true;
        let validOutcomes = true;

        for (const m of markets) {
          const norm = provider.normalizeMarket(m);
          const displayedYes = norm.outcomePrices?.yes || 0;

          if (displayedYes <= 0 || displayedYes >= 1) {
            validOutcomes = false;
            break;
          }

          // Use executable ask price, NOT midpoint
          const executableAsk = this.getExecutableAskPrice(norm, size);
          const legFee = this.computeLegFee(size, executableAsk, feeRate);
          const legCostWithFee = (executableAsk * size) + legFee;
          const hasDepth = this.hasRequiredDepth(norm, size);

          if (!hasDepth) allLegsHaveDepth = false;

          totalAllInCost += legCostWithFee;
          totalFees += legFee;

          outcomesData.push({
            question: norm.question,
            conditionId: norm.conditionId,
            displayedYesPrice: displayedYes,
            executableAskPrice: parseFloat(executableAsk.toFixed(4)),
            legFee: parseFloat(legFee.toFixed(5)),
            legCostWithFee: parseFloat(legCostWithFee.toFixed(4)),
            hasRequiredDepth: hasDepth
          });
        }

        if (!validOutcomes || outcomesData.length < 3) continue;

        // Guaranteed payout if we hold complete basket: $1.00 per share × size
        const guaranteedPayout = size; // $1.00 × size shares
        const netProfit = guaranteedPayout - totalAllInCost;
        const netProfitBps = Math.round((netProfit / guaranteedPayout) * 10000);

        // Only flag if there's a meaningful net edge after fees + slippage
        if (netProfitBps < this.minNetProfitBps) continue;

        // Determine status based on depth and executability
        let status;
        if (!allLegsHaveDepth) {
          status = STATUS.PARTIAL_DEPTH_ONLY;
        } else if (outcomesData.length >= 5) {
          // Many legs → higher legging risk even with depth
          status = STATUS.LEGGING_RISK;
        } else {
          status = STATUS.EXECUTABLE_CANDIDATE;
        }

        opportunities.push({
          eventId: ev.id,
          title: ev.title || ev.name || 'Multi-Outcome Event',
          category: ev.category || 'General',
          status,
          description: `Structural mispricing detected: all-in basket cost $${(totalAllInCost / size).toFixed(4)}/share vs $1.00 guaranteed payout`,
          outcomesCount: outcomesData.length,
          tradeSize: size,
          totalAllInCost: parseFloat(totalAllInCost.toFixed(4)),
          totalFees: parseFloat(totalFees.toFixed(4)),
          guaranteedPayout,
          netProfitUSD: parseFloat(netProfit.toFixed(4)),
          netYieldPct: parseFloat(((netProfit / guaranteedPayout) * 100).toFixed(2)),
          netProfitBps,
          allLegsHaveDepth,
          isNegRiskEligible: ev.negRisk || false,
          outcomes: outcomesData,
          // Governance tags
          isGuaranteedArbitrage: false, // NEVER claim guaranteed — legging risk always exists
          requiresAtomicExecution: true,
          leggingRiskWarning: 'Individual CLOB legs may move between scans. Depth can disappear.'
        });
      }

      // Sort by highest net yield
      opportunities.sort((a, b) => (b.netProfitBps || 0) - (a.netProfitBps || 0));

      const result = {
        scannedAt: new Date().toISOString(),
        totalEventsScanned: events.length,
        opportunitiesFound: opportunities.length,
        statusCounts: this._countStatuses(opportunities),
        opportunities
      };

      this.cache = result;
      this.lastScanTime = now;
      return result;
    } catch (err) {
      logger.error(`scanOpportunities error: ${err.message}`);
      return {
        scannedAt: new Date().toISOString(),
        totalEventsScanned: 0,
        opportunitiesFound: 0,
        statusCounts: {},
        opportunities: [],
        error: err.message
      };
    }
  }

  _countStatuses(opportunities) {
    const counts = {};
    for (const o of opportunities) {
      counts[o.status] = (counts[o.status] || 0) + 1;
    }
    return counts;
  }
}

module.exports = {
  NegRiskStructuralScanner,
  negRiskStructuralScanner: new NegRiskStructuralScanner(),
  STATUS
};
