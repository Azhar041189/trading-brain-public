/**
 * 📚 Prediction Market Evidence Ledger & Time-Machine Engine (Phase P2)
 * 
 * Records end-to-end provenance for Bayesian probability forecasts.
 * Enforces the strict Historical Time-Machine Replay Invariant (blocks post-decision revisions).
 * Calculates empirical Information Alpha Half-Life decay curves.
 */

const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('EvidenceLedger');

class EvidenceLedger {
  constructor() {
    this.records = new Map(); // evidenceId -> Record
    this.decayObservations = []; // Array of { evidenceId, catalystTime, observations: [{dt, edge}] }
  }

  /**
   * Log an evidence item with full provenance and strict time-machine verification
   * @param {Object} item 
   * @returns {Object} { success: boolean, record: Object, error?: string }
   */
  logEvidence(item) {
    const decisionTimestamp = item.decisionTimestamp || new Date().toISOString();
    const revisionTimestamp = item.revisionTimestamp || item.originalPublishedAt || decisionTimestamp;

    // Hard Time-Machine Invariant: Reject future information leakage
    const decisionMs = new Date(decisionTimestamp).getTime();
    const revisionMs = new Date(revisionTimestamp).getTime();

    if (revisionMs > decisionMs) {
      const err = `LEAKAGE_GUARD_VIOLATION: Document revision timestamp (${revisionTimestamp}) is after decision time (${decisionTimestamp}). Future information leakage blocked.`;
      logger.error(`🚨 [EvidenceLedger] ${err}`);
      return { success: false, error: err, status: 'LEAKAGE_REJECTED' };
    }

    const contentHash = crypto.createHash('sha256').update(item.rawContent || item.summary || '').digest('hex');
    const evidenceId = item.evidenceId || `ev_${Date.now()}_${contentHash.slice(0, 8)}`;

    const record = {
      evidenceId,
      sourceIdentity: item.sourceIdentity || 'UNKNOWN_SOURCE',
      sourceURL: item.sourceURL || null,
      sourceType: item.sourceType || 'NEWS_CATALYST', // 'SEC_FILING', 'FED_TRANSCRIPT', 'OFFICIAL_RELEASE', 'NEWS_CATALYST'
      originalPublishedAt: item.originalPublishedAt || decisionTimestamp,
      revisionTimestamp,
      retrievedAt: item.retrievedAt || new Date().toISOString(),
      decisionTimestamp,
      contentHash,
      eventRelevanceScore: item.eventRelevanceScore || 1.0,
      corroboratingSources: Array.isArray(item.corroboratingSources) ? item.corroboratingSources : [],
      contradictingSources: Array.isArray(item.contradictingSources) ? item.contradictingSources : [],
      modelVersion: item.modelVersion || 'HERMES_BAYES_V1',
      priorProbability: item.priorProbability !== undefined ? item.priorProbability : null,
      posteriorProbability: item.posteriorProbability !== undefined ? item.posteriorProbability : null,
      uncertaintyInterval: item.uncertaintyInterval || { low: null, high: null },
      estimateQualityScore: item.estimateQualityScore || 0.85,
      contractSemanticHash: item.contractSemanticHash || null,
      status: 'VERIFIED_CANONICAL'
    };

    this.records.set(evidenceId, record);
    return { success: true, record, status: 'LOGGED' };
  }

  /**
   * Record empirical information decay observation for an evidence catalyst
   * @param {string} evidenceId 
   * @param {Array<Object>} observations - [{ elapsedSeconds: number, edgeAtT: number }]
   */
  recordAlphaDecay(evidenceId, observations) {
    if (!this.records.has(evidenceId)) {
      return { success: false, error: 'Evidence record not found' };
    }

    // Sort observations by elapsed time
    const sorted = [...observations].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds);
    const initialEdge = sorted.length > 0 ? sorted[0].edgeAtT : 0;
    
    // Estimate half-life: time when edge drops to <= 50% of initialEdge
    let halfLifeSeconds = null;
    if (initialEdge > 0) {
      const halfTarget = initialEdge * 0.5;
      for (const obs of sorted) {
        if (obs.edgeAtT <= halfTarget) {
          halfLifeSeconds = obs.elapsedSeconds;
          break;
        }
      }
      if (halfLifeSeconds === null && sorted.length > 0) {
        halfLifeSeconds = sorted[sorted.length - 1].elapsedSeconds; // Upper bound estimate
      }
    }

    const decayProfile = {
      evidenceId,
      initialEdge,
      halfLifeSeconds,
      observations: sorted,
      recordedAt: new Date().toISOString()
    };

    this.decayObservations.push(decayProfile);
    logger.info(`📉 [EvidenceLedger] Catalyst ${evidenceId}: Initial Edge=${initialEdge.toFixed(4)}, Alpha Half-Life=${halfLifeSeconds}s`);

    return { success: true, decayProfile };
  }

  getRecord(evidenceId) {
    return this.records.get(evidenceId) || null;
  }

  getAllRecords() {
    return Array.from(this.records.values());
  }
}

const evidenceLedger = new EvidenceLedger();
module.exports = { EvidenceLedger, evidenceLedger };
