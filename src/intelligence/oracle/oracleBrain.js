/**
 * @file oracleBrain.js
 * @module intelligence/oracle/oracleBrain
 * @description Master Orchestrator for Trading Brain's ORACLE Intelligence Layer.
 * 
 * Coordinates all ORACLE probabilistic intelligence subsystems:
 * 1. World Model (US Macro Causal Hypothesis Graph)
 * 2. Agent Reputation Engine (Domain-Specific Skill with Empirical Bayes Shrinkage & Lower Confidence Bounds)
 * 3. Calibration Memory (PAVA Isotonic Calibration with Versioned Snapshots)
 * 4. Reliability-Weighted Ensemble (Evidence Overlap Detection & Redundancy Penalization)
 * 5. Long-Term Episodic Memory (Temporal Integrity, DECISION_TIME vs POSTMORTEM, Hash Linking)
 * 6. Error Attribution Engine (12-Factor Error Diagnosis, Multiple Causes & Probabilities, Low-Probability Non-Errors)
 * 7. Hypothesis Generator & Meta-Learning Engine (Controlled Champion/Challenger Progression, Human-Gated Promotion)
 * 
 * DUAL-SPEED REASONING & CONFIDENCE GATING:
 * - FAST BRAIN (Milliseconds / Sub-second):
 *   Streaming evidence -> cached world state -> specialist weights -> simple reliability pool.
 *   Triggered when novelty is low, calibration is certified, and evidence is non-contradictory.
 * - DEEP BRAIN (Multi-second):
 *   Mandatory when:
 *   a) High novelty or unmapped market events
 *   b) Severe evidence source contradictions / dispersion
 *   c) High financial impact or macro regime transitions
 *   d) Uncalibrated agents or low effective sample sizes
 * 
 * GOVERNANCE NOTICE:
 * ORACLE is an observational reasoning, learning, and challenger research engine.
 * It observes, estimates probabilities, calibrates confidence, logs episodes, and proposes challenger hypotheses.
 * It NEVER mutates live execution engines, modifies risk caps, or writes production trading orders directly.
 */

'use strict';

const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

// Subsystem imports
const { worldModel } = require('./worldModel');
const { agentReputationEngine } = require('./agentReputationEngine');
const { calibrationMemory } = require('./calibrationMemory');
const { reliabilityWeightedEnsemble } = require('./ensembleForecaster');
const { episodicMemory } = require('./episodicMemory');
const { errorAttributionEngine, ERROR_TYPES } = require('./errorAttributionEngine');
const { hypothesisGenerator } = require('./hypothesisGenerator');
const { metaLearningEngine } = require('./metaLearningEngine');
const { modelRegistry } = require('./modelRegistry');

const logger = createAgentLogger('OracleBrain');

/**
 * Processing Speed Mode Enum
 * @readonly
 * @enum {string}
 */
const PROCESSING_MODES = Object.freeze({
  FAST_BRAIN: 'FAST_BRAIN',
  DEEP_BRAIN: 'DEEP_BRAIN'
});

class OracleBrain {
  /**
   * @param {Object} [options={}]
   */
  constructor(options = {}) {
    this.worldModel = options.worldModel || worldModel;
    this.agentReputationEngine = options.agentReputationEngine || agentReputationEngine;
    this.calibrationMemory = options.calibrationMemory || calibrationMemory;
    this.ensemble = options.ensemble || reliabilityWeightedEnsemble;
    this.episodicMemory = options.episodicMemory || episodicMemory;
    this.errorAttribution = options.errorAttribution || errorAttributionEngine;
    this.hypothesisGenerator = options.hypothesisGenerator || hypothesisGenerator;
    this.metaLearning = options.metaLearning || metaLearningEngine;
    this.modelRegistry = options.modelRegistry || modelRegistry;

    // Gating thresholds
    this.noveltyThreshold = options.noveltyThreshold || 0.40; // Overlap distance threshold
    this.contradictionThreshold = options.contradictionThreshold || 0.35; // Max agent forecast spread

    logger.info('[OracleBrain] Master Orchestrator initialized.');
  }

  /**
   * Evaluates whether an incoming decision query qualifies for FAST_BRAIN or requires DEEP_BRAIN.
   * 
   * @param {Object} context
   * @param {string} context.eventClass
   * @param {Array<Object>} context.agentForecasts
   * @param {Array<Object>} [context.evidenceSources=[]]
   * @returns {{ mode: 'FAST_BRAIN' | 'DEEP_BRAIN', reasons: string[] }}
   */
  evaluateProcessingPath(context) {
    const reasons = [];
    const forecasts = Object.values(context.agentForecasts || {}).map(f => typeof f === 'object' ? f.pForecast || f.rawForecast || 0.5 : f);

    // 1. Check Contradiction / Dispersion
    if (forecasts.length >= 2) {
      const minF = Math.min(...forecasts);
      const maxF = Math.max(...forecasts);
      const spread = maxF - minF;
      if (spread > this.contradictionThreshold) {
        reasons.push(`High forecast dispersion (${(spread * 100).toFixed(1)}% spread > ${(this.contradictionThreshold * 100).toFixed(1)}%)`);
      }
    }

    // 2. Check Expert Calibration & Sample Size
    const qualified = this.agentReputationEngine.selectExperts(context.eventClass, 10, 0.0);
    if (!qualified || qualified.length < 2) {
      reasons.push(`Insufficient calibrated specialists for category '${context.eventClass}' (sample size < 10)`);
    }

    // 3. Check Novelty against Historical Episodes
    const similar = this.episodicMemory.retrieveSimilar({
      question: context.question || '',
      eventClass: context.eventClass,
      regime: context.regime || 'NEUTRAL'
    }, 1);

    if (!similar || similar.length === 0) {
      reasons.push(`Novel unmapped event category or zero historical precedents`);
    }

    const mode = reasons.length > 0 ? PROCESSING_MODES.DEEP_BRAIN : PROCESSING_MODES.FAST_BRAIN;
    return { mode, reasons };
  }

  /**
   * Generates a fully reasoned, calibrated, and uncertainty-bounded probabilistic forecast.
   * 
   * Pipeline:
   * 1. Retrieve point-in-time memories (asOf timestamp enforced)
   * 2. Query US Macro World Model belief graph
   * 3. Select calibrated specialists with Empirical Bayes Shrinkage
   * 4. Detect evidence overlap and penalize redundancy
   * 5. Compute reliability-weighted consensus with conservative dispersion bounds
   * 6. Log immutable episode to Episodic Memory
   * 
   * @param {Object} query
   * @param {string} query.question - The proposition question
   * @param {string} query.eventClass - Event classification (e.g. FED_POLICY, ECONOMICS)
   * @param {string} [query.regime='NEUTRAL'] - Market macro regime
   * @param {Object.<string, Object|number>} query.agentForecasts - Map of agent forecasts
   * @param {Array<Object>} [query.evidenceSources=[]] - Evidence metadata with sourceIds
   * @param {number|null} [query.marketPrice=null] - Baseline reference market price
   * @param {string} [query.asOfTimestamp] - Point-in-time cutoff for backtesting replay
   * @returns {Promise<Object>} Comprehensive Oracle reasoning forecast
   */
  async forecast(query) {
    const timestamp = query.asOfTimestamp || new Date().toISOString();
    const activeChampion = this.modelRegistry.getChampion() || {
      modelId: 'champion_v1.0',
      version: '1.0.0'
    };

    // 1. Path Routing Gating (Fast vs Deep Brain)
    const routingEvaluation = this.evaluateProcessingPath(query);

    // 2. Query Point-in-Time Precedents (Preventing Hindsight Leakage)
    const historicalPrecedents = this.episodicMemory.retrieveSimilar({
      question: query.question,
      eventClass: query.eventClass,
      regime: query.regime,
      asOfTimestamp: timestamp,
      includePostmortems: false // Strict temporal integrity during decision time
    }, 3);

    // 3. Query World Model Macro State
    const worldModelSnapshot = this.worldModel.getSnapshot();

    // 4. Transform and Calibrate Agent Forecasts
    const formattedForecasts = [];
    for (const [agentName, val] of Object.entries(query.agentForecasts || {})) {
      const raw = typeof val === 'object' ? (val.rawForecast ?? val.pForecast ?? 0.5) : Number(val);
      const sourceIds = (typeof val === 'object' && Array.isArray(val.sourceIds))
        ? val.sourceIds
        : (query.evidenceSources || []).map(s => s.sourceId || s.source || 'default');

      // Online calibration via PAVA isotonic curve
      const calibratedP = this.calibrationMemory.calibrate(agentName, raw);
      const rep = this.agentReputationEngine.getReputation(agentName, query.eventClass);

      formattedForecasts.push({
        agentId: agentName,
        pForecast: raw,
        calibratedP,
        evidenceSetHash: crypto.createHash('sha256').update(JSON.stringify(sourceIds.sort())).digest('hex').slice(0, 16),
        sourceIds,
        domain: query.eventClass,
        sampleCount: rep ? rep.sampleSize : 0,
        historicalSkill: rep ? rep.skillLowerBound : 0.0
      });
    }

    // 5. Consensus Combination via Reliability-Weighted Ensemble
    const ensembleResult = this.ensemble.reliabilityWeightedPool(formattedForecasts);

    // 6. Assemble Immutable Episode Record
    const episodeId = `ep_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const rawAgentMap = {};
    formattedForecasts.forEach(f => { rawAgentMap[f.agentId] = f.pForecast; });

    const episodeRecord = {
      episodeId,
      timestamp,
      question: query.question,
      eventClass: query.eventClass,
      regime: query.regime || 'NEUTRAL',
      agentForecasts: rawAgentMap,
      ensembleForecast: ensembleResult.ensembleForecast,
      calibratedForecast: ensembleResult.ensembleForecast,
      uncertaintyInterval: ensembleResult.uncertaintyInterval,
      evidenceSources: query.evidenceSources || [],
      marketPrice: query.marketPrice,
      modelVersionAtDecision: activeChampion.version
    };

    // Store in Episodic Memory (DECISION_TIME phase)
    this.episodicMemory.recordForecast(episodeRecord);

    const result = {
      episodeId,
      timestamp,
      modelVersion: activeChampion.version,
      modelId: activeChampion.modelId,
      question: query.question,
      eventClass: query.eventClass,
      regime: query.regime || 'NEUTRAL',
      processingMode: routingEvaluation.mode,
      gatingReasons: routingEvaluation.reasons,
      rawForecasts: rawAgentMap,
      calibratedForecasts: formattedForecasts.map(f => ({ agent: f.agentId, raw: f.pForecast, calibrated: f.calibratedP })),
      ensembleForecast: ensembleResult.ensembleForecast,
      uncertaintyInterval: ensembleResult.uncertaintyInterval,
      effectiveWeightDistribution: ensembleResult.weights,
      evidenceOverlapMatrix: ensembleResult.overlapMatrix,
      evidenceRedundancyPenalties: ensembleResult.redundancyPenalties,
      historicalPrecedentsCount: historicalPrecedents.length,
      governanceAudit: {
        isLiveExecutionAltered: false,
        isRiskModified: false,
        isObservationalOnly: true
      }
    };

    logger.info(`[OracleBrain] Generated ${routingEvaluation.mode} forecast for "${query.question.slice(0, 40)}...": p=${result.ensembleForecast} [${result.uncertaintyInterval[0]} - ${result.uncertaintyInterval[1]}]`);
    return result;
  }

  /**
   * Ingests a realized event resolution, records ground truth, diagnoses error causes,
   * updates calibration/reputation records, and generates challenger hypotheses.
   * 
   * @param {string} episodeId
   * @param {'YES'|'NO'|1|0} outcome
   * @param {Object} [metadata={}]
   * @returns {Object} Postmortem and learning report
   */
  async learnAfterResolution(episodeId, outcome, metadata = {}) {
    const resolvedAt = metadata.resolvedAt || new Date().toISOString();
    const binaryOutcome = (outcome === 'YES' || outcome === 1 || outcome === true) ? 1 : 0;

    // 1. Record Resolution in Episodic Memory
    const episode = this.episodicMemory.recordResolution(episodeId, binaryOutcome, resolvedAt);
    if (!episode) {
      throw new Error(`[OracleBrain] Failed to resolve episode ${episodeId}: not found in episodic memory`);
    }

    // 2. Perform Structured 12-Factor Error Attribution
    const attribution = this.errorAttribution.attributeError(episode, binaryOutcome);

    // 3. Update Calibration Memory Buckets
    if (episode.agentForecasts) {
      for (const [agent, rawP] of Object.entries(episode.agentForecasts)) {
        this.calibrationMemory.recordOutcome(agent, rawP, binaryOutcome, {
          episodeId,
          eventClass: episode.eventClass
        });
      }
    }

    // 4. Update Agent Reputation Skill with Empirical Bayes Shrinkage
    if (episode.agentForecasts) {
      for (const [agent, rawP] of Object.entries(episode.agentForecasts)) {
        this.agentReputationEngine.recordAgentForecast(
          agent,
          episode.eventClass,
          rawP,
          binaryOutcome,
          episode.marketPrice || 0.5,
          metadata.leadTimeMs || 3600000
        );
      }
    }

    // 5. Generate Challenger Hypotheses if Significant Model Error Occurred
    let generatedHypotheses = [];
    if (attribution.primaryError !== ERROR_TYPES.LOW_PROBABILITY_OUTCOME_OCCURRED &&
        attribution.primaryError !== ERROR_TYPES.UNKNOWN) {
      const errorStats = this.errorAttribution.getErrorPatterns(episode.eventClass, 10);
      generatedHypotheses = this.hypothesisGenerator.generateFromErrors(errorStats);

      // Register proposed hypotheses in MetaLearningEngine without auto-promotion
      for (const hyp of generatedHypotheses) {
        this.metaLearning.generateChallenger(hyp.hypothesis, hyp.proposedChanges, {
          originEpisodeId: episodeId,
          errorCategory: attribution.primaryError
        });
      }
    }

    const postmortemReport = {
      episodeId,
      resolvedAt,
      outcome: binaryOutcome,
      brierScore: episode.brierScore,
      logLoss: episode.logLoss,
      primaryError: attribution.primaryError,
      contributingCauses: attribution.secondaryErrors || [],
      postmortemSummary: attribution.postmortem,
      lessons: attribution.lessons || [],
      generatedHypothesesCount: generatedHypotheses.length,
      governanceNotice: 'Learning completed in offline research space. No production champion mutated.'
    };

    logger.info(`[OracleBrain] Postmortem completed for ${episodeId}: PrimaryError=${attribution.primaryError}, Brier=${episode.brierScore}`);
    return postmortemReport;
  }
}

// Singleton export
const oracleBrain = new OracleBrain();

module.exports = {
  OracleBrain,
  oracleBrain,
  PROCESSING_MODES
};
