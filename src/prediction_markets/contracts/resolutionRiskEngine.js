/**
 * ⚖️ Prediction Market Resolution Risk Engine (Phase P1)
 * 
 * Evaluates contract determinism, UMA Oracle ambiguity, dispute probability, and settlement delay risk.
 * Enforces fail-closed rejection (TRADE_REJECTED_RESOLUTION_RISK) if ambiguity or dispute risk exceeds safety thresholds.
 */

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('ResolutionRiskEngine');

class ResolutionRiskEngine {
  constructor(config = {}) {
    this.maxAllowedRisk = config.maxAllowedRisk || 0.40; // Max acceptable composite risk (0.0 to 1.0)
  }

  /**
   * Evaluate resolution risk profile of a contract snapshot
   * @param {Object} snapshot - Canonical Contract Semantic Snapshot
   * @returns {Object} Full Risk Assessment & Gate Verdict
   */
  evaluateContractRisk(snapshot) {
    if (!snapshot) {
      return {
        passed: false,
        status: 'TRADE_REJECTED_RESOLUTION_RISK',
        reason: 'Missing contract snapshot',
        compositeRiskScore: 1.0
      };
    }

    const question = (snapshot.question || '').toLowerCase();
    const rules = (snapshot.resolutionRules || '').toLowerCase();
    const source = (snapshot.resolutionSource || '').toLowerCase();

    // 1. Source Determinism & Availability Scoring (0 = deterministic/official, 1 = vague/unreliable)
    let sourceDeterminism = 0.20;
    if (source.includes('official') || source.includes('bls.gov') || source.includes('federalreserve.gov') || source.includes('sec.gov') || source.includes('ap news')) {
      sourceDeterminism = 0.05; // Highly deterministic official primary source
    } else if (source.includes('twitter') || source.includes('x.com') || source.includes('social media')) {
      // Social source: Check if exact handle, exact text criteria, and deletion treatment are defined
      const hasSpecificHandle = rules.includes('@') || rules.includes('handle') || rules.includes('account');
      const hasDeletionRule = rules.includes('delete') || rules.includes('deleted') || rules.includes('archived');
      sourceDeterminism = (hasSpecificHandle && hasDeletionRule) ? 0.35 : 0.75;
    } else if (source.length < 5 || source.includes('consensus') || source.includes('multiple sources')) {
      sourceDeterminism = 0.60;
    }

    // 2. Question & Temporal Ambiguity
    let questionAmbiguity = 0.15;
    if (question.includes('likely') || question.includes('substantially') || question.includes('soon') || question.includes('about')) {
      questionAmbiguity = 0.70; // Subjective modifier words
    }
    if (question.includes('or more') || question.includes('before') || question.includes('by')) {
      questionAmbiguity = Math.min(questionAmbiguity, 0.20); // Specific numerical or date threshold
    }

    // 3. Timezone & Timestamp Precision
    let timezoneAmbiguity = 0.10;
    if (!snapshot.resolutionEndTimestamp) {
      timezoneAmbiguity = 0.80; // No explicit end date
    } else if (!snapshot.timezone || snapshot.timezone === 'UNKNOWN') {
      timezoneAmbiguity = 0.40; // Missing timezone definition for cutoff
    }

    // 4. Edge-Case Coverage in Rules
    let edgeCaseCoverage = 0.20;
    const mentionsInvalidation = rules.includes('void') || rules.includes('cancel') || rules.includes('invalid') || rules.includes('tie');
    const mentionsDelay = rules.includes('delay') || rules.includes('postpone') || rules.includes('reschedule');
    if (mentionsInvalidation && mentionsDelay) {
      edgeCaseCoverage = 0.05; // Exceptional edge-case coverage
    } else if (!mentionsInvalidation && !mentionsDelay) {
      edgeCaseCoverage = 0.50; // Missing invalidation edge-case definitions
    }

    // 5. Clarification & Oracle Dispute Risk
    let clarificationRisk = 0.10;
    if (snapshot.clarificationVersion && snapshot.clarificationVersion > 0) {
      clarificationRisk = 0.45; // Already underwent post-launch amendments
    }

    let oracleDisputeRisk = 0.15;
    if (snapshot.oracleMechanism && snapshot.oracleMechanism.includes('UMA')) {
      // UMA Optimistic Oracle carries standard 2-hour to 48-hour challenge delay
      oracleDisputeRisk = 0.20;
    }

    let settlementDelayRisk = 0.15;
    if (snapshot.negRisk) {
      settlementDelayRisk += 0.10; // NegRisk combinatorial payout resolution complexity
    }

    // Weighted Composite Risk Score Calculation
    const weights = {
      sourceDeterminism: 0.25,
      questionAmbiguity: 0.20,
      timezoneAmbiguity: 0.15,
      edgeCaseCoverage: 0.15,
      clarificationRisk: 0.10,
      oracleDisputeRisk: 0.10,
      settlementDelayRisk: 0.05
    };

    const compositeRiskScore = parseFloat((
      sourceDeterminism * weights.sourceDeterminism +
      questionAmbiguity * weights.questionAmbiguity +
      timezoneAmbiguity * weights.timezoneAmbiguity +
      edgeCaseCoverage * weights.edgeCaseCoverage +
      clarificationRisk * weights.clarificationRisk +
      oracleDisputeRisk * weights.oracleDisputeRisk +
      settlementDelayRisk * weights.settlementDelayRisk
    ).toFixed(4));

    const passed = compositeRiskScore <= this.maxAllowedRisk;
    const status = passed ? 'TRADE_PERMITTED' : 'TRADE_REJECTED_RESOLUTION_RISK';

    const assessment = {
      conditionId: snapshot.conditionId,
      passed,
      status,
      compositeRiskScore,
      maxAllowedRisk: this.maxAllowedRisk,
      breakdown: {
        sourceDeterminism,
        questionAmbiguity,
        timezoneAmbiguity,
        edgeCaseCoverage,
        clarificationRisk,
        oracleDisputeRisk,
        settlementDelayRisk
      },
      assessedAt: new Date().toISOString()
    };

    if (!passed) {
      logger.warn(`🛑 [ResolutionRiskEngine] Contract ${snapshot.conditionId} failed risk gate (Score: ${compositeRiskScore} > Max: ${this.maxAllowedRisk}). Status: ${status}`);
    }

    return assessment;
  }
}

const resolutionRiskEngine = new ResolutionRiskEngine();
module.exports = { ResolutionRiskEngine, resolutionRiskEngine };
