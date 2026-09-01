/**
 * 📜 Event Contract Parser & Semantic Snapshot Engine (Phase P1)
 * 
 * Generates versioned, canonical semantic snapshots and deterministic SHA-256 state hashes.
 * Ensures all downstream probability estimates and simulations are immutably tied to exact market rules.
 */

const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('EventContractParser');

class EventContractParser {
  constructor() {
    this.knownSnapshots = new Map(); // conditionId -> Array of VersionedSnapshots
  }

  /**
   * Deterministically serialize an object to JSON with keys sorted recursively
   * @param {any} obj 
   * @returns {string} Canonical JSON string
   */
  canonicalJsonStringify(obj) {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return '[' + obj.map(item => this.canonicalJsonStringify(item)).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    const keyValues = keys.map(k => `${JSON.stringify(k)}:${this.canonicalJsonStringify(obj[k])}`);
    return '{' + keyValues.join(',') + '}';
  }

  /**
   * Compute SHA-256 digest of a string
   */
  sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  /**
   * Parse a raw market object into a canonical Versioned Contract Semantic Snapshot
   * @param {Object} rawMarket - Market metadata from Polymarket / Gamma
   * @param {number} versionOverride - Optional explicit version number
   * @returns {Object} { snapshot, semanticHash, version, isClarified }
   */
  parseContractSnapshot(rawMarket, versionOverride = 1) {
    if (!rawMarket || !rawMarket.conditionId) {
      throw new Error('Invalid raw market: conditionId is required');
    }

    const conditionId = rawMarket.conditionId;
    const tokenIds = rawMarket.tokenIds || {};
    const clarifications = Array.isArray(rawMarket.clarifications) ? rawMarket.clarifications : [];
    const clarificationVersion = clarifications.length;

    // Build standard semantic snapshot object
    const snapshot = {
      conditionId: rawMarket.conditionId,
      question: (rawMarket.question || '').trim(),
      outcomes: Array.isArray(rawMarket.outcomes) ? rawMarket.outcomes : ['Yes', 'No'],
      resolutionSource: (rawMarket.resolutionSource || 'UMA Oracle').trim(),
      resolutionRules: (rawMarket.rulesText || rawMarket.description || '').trim(),
      resolutionEndTimestamp: rawMarket.endTimestamp || rawMarket.endDate || null,
      timezone: rawMarket.timezone || 'UTC',
      clarifications: clarifications.map(c => ({
        id: c.id || null,
        timestamp: c.timestamp || null,
        text: (c.text || '').trim()
      })),
      clarificationVersion,
      tokenIds: {
        yes: tokenIds.yes || null,
        no: tokenIds.no || null
      },
      negRisk: Boolean(rawMarket.negRisk),
      oracleMechanism: rawMarket.oracleMechanism || 'UMA_OPTIMISTIC_ORACLE',
      contractVersion: versionOverride
    };

    const canonicalJson = this.canonicalJsonStringify(snapshot);
    const semanticHash = this.sha256(canonicalJson);

    const versionedRecord = {
      snapshot,
      canonicalJson,
      semanticHash,
      version: versionOverride,
      isClarified: clarificationVersion > 0,
      createdAt: new Date().toISOString()
    };

    // Track snapshot history for this conditionId
    if (!this.knownSnapshots.has(conditionId)) {
      this.knownSnapshots.set(conditionId, []);
    }
    
    const history = this.knownSnapshots.get(conditionId);
    const previous = history.length > 0 ? history[history.length - 1] : null;

    if (!previous || previous.semanticHash !== semanticHash) {
      if (previous) {
        logger.warn(`🔄 [EventContractParser] Contract ${conditionId} updated! Hash transitioned: ${previous.semanticHash.slice(0, 10)}... -> ${semanticHash.slice(0, 10)}...`);
      }
      history.push(versionedRecord);
    }

    return versionedRecord;
  }

  /**
   * Check if a resting model prediction is still valid against current contract state
   * @param {string} conditionId 
   * @param {string} predictionContractHash 
   * @returns {Object} { isValid: boolean, status: 'CURRENT' | 'STALE_REVISION_PRESERVED' | 'NOT_FOUND' }
   */
  validatePredictionHash(conditionId, predictionContractHash) {
    const history = this.knownSnapshots.get(conditionId);
    if (!history || history.length === 0) {
      return { isValid: false, status: 'NOT_FOUND' };
    }

    const current = history[history.length - 1];
    if (current.semanticHash === predictionContractHash) {
      return { isValid: true, status: 'CURRENT', currentHash: current.semanticHash };
    }

    return {
      isValid: false,
      status: 'STALE_REVISION_PRESERVED',
      currentHash: current.semanticHash,
      priorHash: predictionContractHash
    };
  }

  getSnapshotHistory(conditionId) {
    return this.knownSnapshots.get(conditionId) || [];
  }
}

const eventContractParser = new EventContractParser();
module.exports = { EventContractParser, eventContractParser };
