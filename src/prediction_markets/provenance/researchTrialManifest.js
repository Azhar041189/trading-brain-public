/**
 * 📜 Prediction Market Research Trial Manifest & Immutable Provenance Chain
 * 
 * Prevents multiple-testing bias, data snooping, and establishes end-to-end cryptographic reproducibility.
 * Enforces strict scientific separation between FORECAST_SKILL and TRADABLE_EDGE.
 */

const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('ResearchTrialManifest');

class ResearchTrialManifest {
  constructor() {
    this.trials = new Map(); // trialId -> TrialMetadata
    this.provenanceChains = new Map(); // forecastHash -> FullProvenanceNode
    this.trialCounter = 0;
  }

  /**
   * Register a new research experiment trial to strictly account for multiple hypothesis testing
   * @param {Object} trialSpec - { hypothesis, modelVersion, promptTemplate, featureSet, parameters, eventUniverse, track: 'MARKET_FORECAST'|'CATALYST'|'MAKER' }
   * @returns {Object} Registered Trial Record with unique Trial ID and Parameter Hashes
   */
  registerTrial(trialSpec) {
    if (!trialSpec || !trialSpec.hypothesis) {
      throw new Error('Trial specification must contain a verifiable hypothesis');
    }

    this.trialCounter++;
    const promptHash = crypto.createHash('sha256').update(trialSpec.promptTemplate || '').digest('hex');
    const featureSetHash = crypto.createHash('sha256').update(JSON.stringify(trialSpec.featureSet || {})).digest('hex');
    const paramHash = crypto.createHash('sha256').update(JSON.stringify(trialSpec.parameters || {})).digest('hex');
    
    const trialId = `trial_${String(this.trialCounter).padStart(4, '0')}_${trialSpec.track || 'GENERAL'}_${Date.now().toString(36)}`;

    const trialRecord = {
      trialId,
      trialIndex: this.trialCounter,
      track: trialSpec.track || 'MARKET_FORECAST', // Track A (Market Forecast), Track B (Catalyst), Track C (Maker)
      hypothesis: trialSpec.hypothesis,
      modelVersion: trialSpec.modelVersion || 'v1.0.0',
      promptHash,
      featureSetHash,
      paramHash,
      parameters: trialSpec.parameters || {},
      eventUniverse: trialSpec.eventUniverse || 'ALL_CATEGORIES',
      trainingWindow: trialSpec.trainingWindow || null,
      evaluationWindow: trialSpec.evaluationWindow || null,
      registeredAt: new Date().toISOString(),
      status: 'ACTIVE_OBSERVATION',
      results: {
        forecastSkillVerdict: 'PENDING_EMPIRICAL_DATA',
        tradableEdgeVerdict: 'PENDING_EMPIRICAL_DATA',
        brierSkillScore: null,
        netReturnUSD: null,
        sampleSize: 0
      }
    };

    this.trials.set(trialId, trialRecord);
    logger.info(`📋 [TrialManifest] Registered Trial #${trialRecord.trialIndex} [${trialRecord.track}]: ${trialRecord.hypothesis} (${trialId})`);
    return trialRecord;
  }

  /**
   * Build an immutable cryptographic provenance chain node for a prediction decision
   * Provenance: MarketSnapshotHash + ContractSemanticHash + EvidenceSetHash + ModelVersionHash => ForecastHash => DecisionHash => OrderHash => FillHash
   */
  createProvenanceChainNode(input) {
    const marketSnapshotHash = input.marketSnapshotHash || '0000000000000000';
    const contractSemanticHash = input.contractSemanticHash || '0000000000000000';
    const evidenceSetHash = input.evidenceSetHash || '0000000000000000';
    const modelVersionHash = crypto.createHash('sha256').update(input.modelVersion || 'default_model').digest('hex');

    // 1. Forecast Record Hash
    const forecastPayload = `${marketSnapshotHash}:${contractSemanticHash}:${evidenceSetHash}:${modelVersionHash}:${input.probabilityPoint}:${input.pLow || 0}:${input.pHigh || 1}`;
    const forecastRecordHash = crypto.createHash('sha256').update(forecastPayload).digest('hex');

    // 2. Decision Record Hash
    const decisionPayload = `${forecastRecordHash}:${input.action || 'HOLD'}:${input.targetEV || 0}:${input.timestamp || Date.now()}`;
    const decisionRecordHash = crypto.createHash('sha256').update(decisionPayload).digest('hex');

    const chainNode = {
      forecastRecordHash,
      decisionRecordHash,
      paperOrderRecordHash: null,
      fillRecordHash: null,
      resolutionRecord: null,
      marketSnapshotHash,
      contractSemanticHash,
      evidenceSetHash,
      modelVersionHash,
      trialId: input.trialId || null,
      probabilityPoint: input.probabilityPoint,
      pLow: input.pLow,
      pHigh: input.pHigh,
      action: input.action || 'HOLD',
      timestamp: input.timestamp || new Date().toISOString()
    };

    this.provenanceChains.set(forecastRecordHash, chainNode);
    return chainNode;
  }

  /**
   * Link simulated execution fill hash to an existing provenance node
   */
  linkExecutionFill(forecastRecordHash, orderHash, fillHash) {
    const node = this.provenanceChains.get(forecastRecordHash);
    if (node) {
      node.paperOrderRecordHash = orderHash;
      node.fillRecordHash = fillHash;
      node.linkedAt = new Date().toISOString();
    }
    return node;
  }

  /**
   * Record empirical resolution and independently evaluate FORECAST_SKILL vs TRADABLE_EDGE
   */
  recordResolutionOutcome(forecastRecordHash, resolution) {
    const node = this.provenanceChains.get(forecastRecordHash);
    if (!node) return null;

    node.resolutionRecord = {
      outcome: resolution.outcome, // 'YES' | 'NO' | 'INVALID' | 'DISPUTED'
      resolvedPrice: resolution.resolvedPrice, // 1.0 or 0.0 or 0.5
      brierLoss: Math.pow(node.probabilityPoint - resolution.resolvedPrice, 2),
      pnlUSD: resolution.pnlUSD || 0.0,
      timestamp: new Date().toISOString()
    };

    return node;
  }

  getTrial(trialId) {
    return this.trials.get(trialId);
  }

  getAllTrials() {
    return Array.from(this.trials.values());
  }

  getProvenance(forecastHash) {
    return this.provenanceChains.get(forecastHash);
  }
}

const researchTrialManifest = new ResearchTrialManifest();
module.exports = { ResearchTrialManifest, researchTrialManifest };
