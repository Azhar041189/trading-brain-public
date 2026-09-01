/**
 * 🔗 Cross-Venue Contract Equivalence Engine (Phase P1 / P2.5)
 * 
 * Verifies semantic equivalence between prediction contracts across venues (e.g., Polymarket vs Kalshi).
 * Strictly gates cross-venue trading:
 *   - EXACT_EQUIVALENT -> Eligible for ARBITRAGE_CANDIDATE
 *   - PROBABLE_EQUIVALENT -> Eligible for RELATIVE_VALUE_CANDIDATE
 *   - SEMANTICALLY_DIFFERENT / UNRESOLVED -> INELIGIBLE
 */

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('CrossVenueEquivalenceEngine');

class CrossVenueContractEquivalenceEngine {
  constructor() {
    this.equivalenceRegister = new Map(); // venueA:idA_venueB:idB -> EquivalenceRecord
  }

  /**
   * Compare two contract semantic snapshots across distinct venues
   * @param {Object} contractA - Semantic Snapshot from Venue A (e.g., Polymarket)
   * @param {Object} contractB - Semantic Snapshot from Venue B (e.g., Kalshi)
   * @returns {Object} Equivalence assessment
   */
  evaluateEquivalence(contractA, contractB) {
    if (!contractA || !contractB) {
      return {
        classification: 'UNRESOLVED',
        matchScore: 0.0,
        eligibleCategory: 'INELIGIBLE',
        reason: 'Missing contract snapshot'
      };
    }

    const checks = {
      resolutionSourceMatch: this._compareResolutionSources(contractA.resolutionSource, contractB.resolutionSource),
      timeCutoffMatch: this._compareTimeCutoffs(contractA.resolutionEndTimestamp, contractB.resolutionEndTimestamp, contractA.timezone, contractB.timezone),
      outcomeSetMatch: this._compareOutcomes(contractA.outcomes, contractB.outcomes),
      invalidationRulesMatch: this._compareInvalidationRules(contractA.resolutionRules, contractB.resolutionRules)
    };

    // Calculate semantic match score (0.0 to 1.0)
    const matchScore = parseFloat((
      (checks.resolutionSourceMatch ? 0.35 : 0) +
      (checks.timeCutoffMatch ? 0.30 : 0) +
      (checks.outcomeSetMatch ? 0.20 : 0) +
      (checks.invalidationRulesMatch ? 0.15 : 0)
    ).toFixed(4));

    let classification = 'SEMANTICALLY_DIFFERENT';
    let eligibleCategory = 'INELIGIBLE';

    if (checks.resolutionSourceMatch && checks.timeCutoffMatch && checks.outcomeSetMatch && checks.invalidationRulesMatch) {
      classification = 'EXACT_EQUIVALENT';
      eligibleCategory = 'ARBITRAGE_CANDIDATE';
    } else if (checks.resolutionSourceMatch && checks.outcomeSetMatch && matchScore >= 0.70) {
      classification = 'PROBABLE_EQUIVALENT';
      eligibleCategory = 'RELATIVE_VALUE_CANDIDATE';
    }

    const pairKey = `${contractA.conditionId || 'A'}_${contractB.conditionId || 'B'}`;
    const result = {
      pairKey,
      contractAId: contractA.conditionId,
      contractBId: contractB.conditionId,
      classification,
      matchScore,
      eligibleCategory,
      checks,
      assessedAt: new Date().toISOString()
    };

    this.equivalenceRegister.set(pairKey, result);
    logger.info(`🔗 [CrossVenueEquivalence] ${pairKey} classified as ${classification} (Score: ${matchScore}) -> ${eligibleCategory}`);

    return result;
  }

  _compareResolutionSources(srcA, srcB) {
    if (!srcA || !srcB) return false;
    const a = srcA.toLowerCase().trim();
    const b = srcB.toLowerCase().trim();
    if (a === b) return true;
    // Normalized authority checks
    if ((a.includes('bls.gov') || a.includes('bureau of labor')) && (b.includes('bls.gov') || b.includes('bureau of labor'))) return true;
    if ((a.includes('federalreserve.gov') || a.includes('federal reserve')) && (b.includes('federalreserve.gov') || b.includes('federal reserve'))) return true;
    if ((a.includes('sec.gov') || a.includes('securities and exchange')) && (b.includes('sec.gov') || b.includes('securities and exchange'))) return true;
    return false;
  }

  _compareTimeCutoffs(timeA, timeB, tzA, tzB) {
    if (!timeA || !timeB) return false;
    try {
      const msA = new Date(timeA).getTime();
      const msB = new Date(timeB).getTime();
      // Allow max 1-hour alignment window (e.g. daylight saving or UTC normalization discrepancy)
      return Math.abs(msA - msB) <= 3600000;
    } catch (e) {
      return false;
    }
  }

  _compareOutcomes(outcomesA, outcomesB) {
    if (!Array.isArray(outcomesA) || !Array.isArray(outcomesB)) return false;
    if (outcomesA.length !== outcomesB.length) return false;
    const setA = new Set(outcomesA.map(o => o.toLowerCase().trim()));
    const setB = new Set(outcomesB.map(o => o.toLowerCase().trim()));
    for (const item of setA) {
      if (!setB.has(item)) return false;
    }
    return true;
  }

  _compareInvalidationRules(rulesA, rulesB) {
    if (!rulesA || !rulesB) return true; // Default neutral if no special invalidation text
    const a = rulesA.toLowerCase();
    const b = rulesB.toLowerCase();
    const aHasVoid = a.includes('void') || a.includes('cancel');
    const bHasVoid = b.includes('void') || b.includes('cancel');
    return aHasVoid === bHasVoid;
  }
}

const crossVenueContractEquivalenceEngine = new CrossVenueContractEquivalenceEngine();
module.exports = { CrossVenueContractEquivalenceEngine, crossVenueContractEquivalenceEngine };
