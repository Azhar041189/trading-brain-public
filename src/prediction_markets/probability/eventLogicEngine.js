/**
 * 🧩 Prediction Market Event Logic Engine (Phase P2.5)
 * 
 * Verifies and enforces mathematical & logical consistency constraints across related prediction markets:
 *   - Temporal Subsets (Event A ⊆ Event B => P(A) <= P(B))
 *   - Conditional Prerequisite (Y requires X => P(Y) <= P(X))
 *   - Mutually Exclusive & Collectively Exhaustive Partitions (Sum(P(Ek)) == 1.00)
 * 
 * Requires verified semantic proof before signaling structural pricing anomalies.
 */

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('EventLogicEngine');

class EventLogicEngine {
  constructor() {
    this.registeredRelations = new Map(); // relationKey -> RelationRecord
    this.structuralAnomalies = [];
  }

  /**
   * Register a verified logical relationship between contract snapshots
   * @param {Object} relation 
   */
  registerLogicalRelation(relation) {
    if (!relation || !relation.relationType || !relation.leftContractHash || !relation.rightContractHash) {
      throw new Error('Invalid logical relation: relationType, leftContractHash, and rightContractHash are required.');
    }

    const relationKey = `${relation.relationType}_${relation.leftContractHash.slice(0, 10)}_${relation.rightContractHash.slice(0, 10)}`;

    // Verify semantic proof status: Must be VERIFIED_LOGICAL_RELATION
    const status = relation.status || (relation.verifiedBy ? 'VERIFIED_LOGICAL_RELATION' : 'PROBABLE_RELATION');
    if (status !== 'VERIFIED_LOGICAL_RELATION') {
      throw new Error(`🚨 [EventLogicEngine] Registration rejected: Logical relations require VERIFIED_LOGICAL_RELATION status backed by formal semantic proof.`);
    }

    const record = {
      relationKey,
      relationType: relation.relationType, // 'SUBSET_TEMPORAL', 'CONDITIONAL_PREREQUISITE', 'MUTUALLY_EXCLUSIVE_EXHAUSTIVE'
      relationConfidence: relation.relationConfidence || 1.0,
      leftContractHash: relation.leftContractHash,
      rightContractHash: relation.rightContractHash,
      leftConditionId: relation.leftConditionId || null,
      rightConditionId: relation.rightConditionId || null,
      relationEvidence: relation.relationEvidence || 'Manual / Semantic proof',
      verifiedBy: relation.verifiedBy || 'SYSTEM_VERIFIER',
      status,
      registeredAt: new Date().toISOString()
    };

    this.registeredRelations.set(relationKey, record);
    logger.info(`🧩 [EventLogicEngine] Registered ${status}: ${relationKey} (${relation.relationType})`);
    return record;
  }

  /**
   * Evaluate logical consistency across registered relations given current market prices
   * @param {Map<string, number>} marketPricesMap - contractHash -> marketPrice
   * @returns {Array<Object>} List of evaluated consistency checks and detected anomalies
   */
  evaluateConsistency(marketPricesMap) {
    const results = [];

    for (const [key, rel] of this.registeredRelations.entries()) {
      if (rel.status !== 'VERIFIED_LOGICAL_RELATION') {
        // Gated: Only verified relations generate actionable anomaly signals
        continue;
      }

      const pLeft = marketPricesMap.get(rel.leftContractHash);
      const pRight = marketPricesMap.get(rel.rightContractHash);

      if (pLeft === undefined || pRight === undefined) {
        continue; // Incomplete price feed
      }

      let isViolation = false;
      let anomalyMagnitude = 0;
      let description = '';

      switch (rel.relationType) {
        case 'SUBSET_TEMPORAL':
        case 'CONDITIONAL_PREREQUISITE':
          // Rule: P(Left) <= P(Right). Violation if P(Left) > P(Right)
          if (pLeft > pRight + 0.005) { // 0.5% tolerance buffer
            isViolation = true;
            anomalyMagnitude = parseFloat((pLeft - pRight).toFixed(4));
            description = `Subset/Prerequisite Violation: P(Left)=${pLeft.toFixed(3)} exceeds P(Right)=${pRight.toFixed(3)} by ${anomalyMagnitude}`;
          }
          break;

        default:
          break;
      }

      const evalRecord = {
        relationKey: key,
        relationType: rel.relationType,
        leftConditionId: rel.leftConditionId,
        rightConditionId: rel.rightConditionId,
        pLeft,
        pRight,
        isViolation,
        anomalyMagnitude,
        description,
        evaluatedAt: new Date().toISOString()
      };

      if (isViolation) {
        logger.warn(`🚨 [EventLogicEngine] STRUCTURAL PRICING ANOMALY DETECTED: ${description}`);
        this.structuralAnomalies.push(evalRecord);
      }

      results.push(evalRecord);
    }

    return results;
  }

  /**
   * Evaluate Exhaustive Partition consistency for a set of mutually exclusive contracts
   * @param {Array<Object>} contracts - Array of { contractHash, price, name }
   * @param {number} tolerance - Allowable spread deviation (default: 0.02)
   */
  evaluateExhaustivePartition(contracts, tolerance = 0.02) {
    if (!contracts || contracts.length < 2) return null;

    const sumPrices = contracts.reduce((acc, c) => acc + (c.price || 0), 0);
    const deviation = parseFloat(Math.abs(sumPrices - 1.00).toFixed(4));
    const isMispriced = deviation > tolerance;

    const assessment = {
      contractsCount: contracts.length,
      sumPrices: parseFloat(sumPrices.toFixed(4)),
      deviation,
      isMispriced,
      type: sumPrices < 1.00 ? 'UNDERPRICED_BASKET_ARBITRAGE' : 'OVERPRICED_BASKET_SHORT',
      evaluatedAt: new Date().toISOString()
    };

    if (isMispriced) {
      logger.info(`⚖️ [EventLogicEngine] Exhaustive Basket Mispricing: Sum=${assessment.sumPrices} (Dev: ${deviation}) -> ${assessment.type}`);
    }

    return assessment;
  }
}

const eventLogicEngine = new EventLogicEngine();
module.exports = { EventLogicEngine, eventLogicEngine };
