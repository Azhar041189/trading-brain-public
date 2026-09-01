/**
 * @file ensembleForecaster.js
 * @module intelligence/oracle/ensembleForecaster
 * @description Reliability-Weighted Ensemble Aggregator for Trading Brain's ORACLE Intelligence Layer.
 * Combines specialist agent predictions with evidence overlap detection, dynamic method selection,
 * uncertainty interval estimation, and empirical calibration.
 *
 * Governance:
 * ORACLE Intelligence Layer modules observe, score, learn, and propose.
 * They do NOT modify live execution, risk caps, or historical records directly.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('ReliabilityWeightedEnsemble');

// Probability boundaries to avoid degenerate states
const PROBABILITY_FLOOR = 0.01;
const PROBABILITY_CEILING = 0.99;
const DEFAULT_UNCERTAINTY_MULTIPLIER = 1.5;
const UNINFORMATIVE_PRIOR = 0.50;
const BASELINE_REFERENCE_BRIER = 0.25; // 50/50 uninformed guessing benchmark

// Evidence overlap thresholds
const OVERLAP_PENALTY_THRESHOLD = 0.50; // >50% overlap implies non-independence
const SEVERE_OVERLAP_THRESHOLD = 0.70;   // >70% overlap triggers 50% weight halving

/**
 * Standard Combination Methods
 * @readonly
 * @enum {string}
 */
const ENSEMBLE_METHODS = Object.freeze({
  RELIABILITY_WEIGHTED_POOL: 'reliabilityWeightedPool',
  LOG_ODDS_POOL: 'logOddsPool',
  LOGISTIC_STACKING: 'logisticStacking',
  BAYESIAN_MODEL_AVERAGING: 'bayesianModelAveraging'
});

/**
 * @typedef {Object} CanonicalAgentForecast
 * @property {string} agentId - Unique identifier of the forecasting agent
 * @property {number} pForecast - Raw predicted probability clamped to [0.01, 0.99]
 * @property {number} calibratedP - Calibrated probability clamped to [0.01, 0.99]
 * @property {string} evidenceSetHash - SHA256 / MD5 hash representing the evidence bundle
 * @property {string[]} sourceIds - Array of source/document/feed IDs supporting this forecast
 * @property {string} domain - Event domain / class (e.g., 'FED_POLICY', 'MACRO', 'CRYPTO')
 * @property {number} sampleCount - Historical sample count for this agent in this domain
 * @property {number} historicalSkill - Historical Brier skill score / reputation weight [0, 1]
 * @property {number} [weight] - Optional explicit weight override
 */

/**
 * @typedef {Object} OverlapMatrixResult
 * @property {Object.<string, Object.<string, number>>} matrix - Pairwise Jaccard similarity matrix
 * @property {Array<{agentA: string, agentB: string, similarity: number, sharedCount: number, totalA: number, totalB: number}>} pairwiseList - Detailed pairwise list
 * @property {Array<{agentA: string, agentB: string, similarity: number}>} highOverlapPairs - Pairs with similarity > 0.50
 * @property {Array<{agentA: string, agentB: string, similarity: number}>} severeOverlapPairs - Pairs with similarity > 0.70
 */

/**
 * @typedef {Object} EnsembleResult
 * @property {number} ensembleForecast - Clamped aggregate probability [0.01, 0.99]
 * @property {string} method - Combination method employed
 * @property {Object.<string, number>} weights - Final normalized weights utilized
 * @property {Object.<string, number>} rawWeights - Pre-adjustment base weights
 * @property {Object.<string, number>} adjustedWeights - Post-overlap adjusted weights
 * @property {Object.<string, number>} overlapPenalties - Overlap penalty multipliers applied per agent
 * @property {OverlapMatrixResult} [overlapMatrix] - Evidence overlap analysis
 * @property {[number, number]} uncertaintyInterval - [pLow, pHigh] 1.5-sigma credible interval
 * @property {number} uncertaintySpread - High minus low interval spread
 * @property {number} wstd - Weighted standard deviation of component forecasts
 * @property {Object.<string, Object>} contributions - Detailed per-agent breakdown
 * @property {number} agentCount - Total number of participating agents
 * @property {string} timestamp - ISO 8601 calculation timestamp
 * @property {Object} [metadata] - Additional method-specific telemetry
 */

/**
 * Safely writes data to a JSON file atomically using a temporary staging file.
 * @param {string} filePath - Absolute path to target file
 * @param {any} data - Object or array to serialize
 */
function atomicWriteJsonSync(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const nonce = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const tempPath = `${filePath}.tmp.${nonce}`;
    const serialized = JSON.stringify(data, null, 2);

    fs.writeFileSync(tempPath, serialized, 'utf8');

    try {
      fs.renameSync(tempPath, filePath);
    } catch (renameErr) {
      try {
        fs.copyFileSync(tempPath, filePath);
        fs.unlinkSync(tempPath);
      } catch (fallbackErr) {
        fs.writeFileSync(filePath, serialized, 'utf8');
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (_) {}
      }
    }
  } catch (err) {
    logger.warn(`Failed atomic JSON write to ${filePath}: ${err.message}`);
  }
}

/**
 * @class ReliabilityWeightedEnsemble
 * @description Advanced multi-agent probabilistic forecast aggregator for Trading Brain's ORACLE Intelligence Layer.
 * Incorporates evidence overlap detection via Jaccard similarity, correlation tracking,
 * 4 distinct pooling/stacking methods, dynamic empirical method selection, and dispersion-based uncertainty intervals.
 */
class ReliabilityWeightedEnsemble {
  /**
   * Initializes the ReliabilityWeightedEnsemble engine with configurable bounds and persistence.
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.minProbability=0.01] - Minimum clamped probability
   * @param {number} [options.maxProbability=0.99] - Maximum clamped probability
   * @param {number} [options.uncertaintyMultiplier=1.5] - Standard deviation multiplier for uncertainty interval
   * @param {number} [options.minEpisodesForMethodSelection=5] - Min resolved episodes needed before switching from default pool
   * @param {string} [options.storagePath] - Path to JSON file storage
   * @param {string} [options.dbPath] - Path to SQLite database
   */
  constructor(options = {}) {
    this.minProbability = options.minProbability || PROBABILITY_FLOOR;
    this.maxProbability = options.maxProbability || PROBABILITY_CEILING;
    this.uncertaintyMultiplier = options.uncertaintyMultiplier || DEFAULT_UNCERTAINTY_MULTIPLIER;
    this.minEpisodesForMethodSelection = options.minEpisodesForMethodSelection || 5;

    // Storage paths
    this.storagePath = options.storagePath || path.join(
      process.cwd(),
      'data',
      'oracle',
      'ensemble_memory.json'
    );
    this.dbPath = options.dbPath || path.join(
      process.cwd(),
      'data',
      'trading_brain.db'
    );

    /** @type {Object.<string, Object.<string, { sumProd: number, sumA: number, sumB: number, sumSqA: number, sumSqB: number, count: number, correlation: number }>>} */
    this.pairwiseCorrelations = {};

    /** @type {Object.<string, { totalEvaluated: number, brierSum: number, logLossSum: number, winCount: number, lastSelected: string|null }>} */
    this.methodPerformance = {
      [ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL]: { totalEvaluated: 0, brierSum: 0, logLossSum: 0, winCount: 0, lastSelected: null },
      [ENSEMBLE_METHODS.LOG_ODDS_POOL]: { totalEvaluated: 0, brierSum: 0, logLossSum: 0, winCount: 0, lastSelected: null },
      [ENSEMBLE_METHODS.LOGISTIC_STACKING]: { totalEvaluated: 0, brierSum: 0, logLossSum: 0, winCount: 0, lastSelected: null },
      [ENSEMBLE_METHODS.BAYESIAN_MODEL_AVERAGING]: { totalEvaluated: 0, brierSum: 0, logLossSum: 0, winCount: 0, lastSelected: null }
    };

    /** @type {Object.<string, { intercept: number, weights: Object.<string, number>, sampleCount: number, trainedAt: string }>} */
    this.logisticStackingCoefficients = {};

    /** @type {Array<Object>} */
    this.recentEvaluations = [];

    /** @type {'SQLITE_PRIMARY'|'JSON_FALLBACK'} */
    this.persistenceMode = 'JSON_FALLBACK';
    this.db = null;

    this._initStorage();
  }

  /**
   * Initializes storage directories, SQLite database tables if available, and loads JSON data.
   * @private
   */
  _initStorage() {
    try {
      const dataDir = path.dirname(this.storagePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      this._initSqlite();
      this._loadFromJson();

      logger.info(`Initialized ReliabilityWeightedEnsemble [Mode: ${this.persistenceMode}] at ${this.storagePath}`);
    } catch (err) {
      logger.warn(`Error initializing ReliabilityWeightedEnsemble storage: ${err.message}`);
    }
  }

  /**
   * Initializes better-sqlite3 if available.
   * @private
   */
  _initSqlite() {
    try {
      const Database = require('better-sqlite3');
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS oracle_ensemble_method_tracking (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          method TEXT NOT NULL,
          prediction REAL NOT NULL,
          outcome REAL NOT NULL,
          brier_loss REAL NOT NULL,
          log_loss REAL NOT NULL,
          domain TEXT,
          agent_count INTEGER,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_oracle_ens_method ON oracle_ensemble_method_tracking(method);
        CREATE INDEX IF NOT EXISTS idx_oracle_ens_time ON oracle_ensemble_method_tracking(timestamp);

        CREATE TABLE IF NOT EXISTS oracle_pairwise_correlations (
          agent_a TEXT NOT NULL,
          agent_b TEXT NOT NULL,
          correlation REAL NOT NULL,
          sample_count INTEGER NOT NULL,
          last_updated TEXT NOT NULL,
          PRIMARY KEY (agent_a, agent_b)
        );
      `);

      this.persistenceMode = 'SQLITE_PRIMARY';
    } catch (_) {
      this.persistenceMode = 'JSON_FALLBACK';
    }
  }

  /**
   * Loads state from JSON file.
   * @private
   */
  _loadFromJson() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.pairwiseCorrelations) this.pairwiseCorrelations = data.pairwiseCorrelations;
        if (data.methodPerformance) {
          for (const [method, stats] of Object.entries(data.methodPerformance)) {
            if (this.methodPerformance[method]) {
              this.methodPerformance[method] = { ...this.methodPerformance[method], ...stats };
            }
          }
        }
        if (data.logisticStackingCoefficients) this.logisticStackingCoefficients = data.logisticStackingCoefficients;
        if (Array.isArray(data.recentEvaluations)) this.recentEvaluations = data.recentEvaluations.slice(-200);
      }
    } catch (err) {
      logger.warn(`Failed loading JSON backup for ReliabilityWeightedEnsemble: ${err.message}`);
    }
  }

  /**
   * Persists state to storage (JSON file and SQLite).
   * @private
   */
  _saveState() {
    try {
      const data = {
        pairwiseCorrelations: this.pairwiseCorrelations,
        methodPerformance: this.methodPerformance,
        logisticStackingCoefficients: this.logisticStackingCoefficients,
        recentEvaluations: this.recentEvaluations.slice(-200),
        lastSaved: new Date().toISOString()
      };
      atomicWriteJsonSync(this.storagePath, data);
    } catch (err) {
      logger.warn(`Failed persisting state: ${err.message}`);
    }
  }

  /**
   * Clamp a probability to the valid domain [0.01, 0.99] to prevent mathematical degeneration.
   * @param {number} p - Raw probability value
   * @param {number} [min=0.01] - Minimum allowable probability
   * @param {number} [max=0.99] - Maximum allowable probability
   * @returns {number} Clamped probability
   */
  clampProbability(p, min = this.minProbability, max = this.maxProbability) {
    if (typeof p !== 'number' || isNaN(p) || !isFinite(p)) {
      return UNINFORMATIVE_PRIOR;
    }
    return Math.min(Math.max(p, min), max);
  }

  /**
   * Converts a probability to log-odds: ln(p / (1 - p)).
   * Input probability is clamped to [0.01, 0.99] to avoid log(0) and division by zero.
   * @param {number} p - Probability in [0.01, 0.99]
   * @returns {number} Log-odds value
   */
  toLogOdds(p) {
    const clamped = this.clampProbability(p);
    return Math.log(clamped / (1 - clamped));
  }

  /**
   * Converts log-odds back to probability: 1 / (1 + exp(-L)).
   * Output probability is clamped to [0.01, 0.99].
   * @param {number} logOdds - Log-odds value
   * @returns {number} Clamped probability
   */
  fromLogOdds(logOdds) {
    if (typeof logOdds !== 'number' || isNaN(logOdds) || !isFinite(logOdds)) {
      return UNINFORMATIVE_PRIOR;
    }
    const p = 1 / (1 + Math.exp(-logOdds));
    return this.clampProbability(p);
  }

  /**
   * Normalizes a single raw input into a canonical AgentForecast object:
   * { agentId, pForecast, calibratedP, evidenceSetHash, sourceIds[], domain, sampleCount, historicalSkill }
   * 
   * @param {Object|number} item - Raw forecast item
   * @param {string} [fallbackKey='agent_unknown'] - Fallback agent name
   * @returns {CanonicalAgentForecast}
   */
  normalizeForecast(item, fallbackKey = 'agent_unknown') {
    if (item === null || item === undefined) {
      return {
        agentId: fallbackKey,
        pForecast: UNINFORMATIVE_PRIOR,
        calibratedP: UNINFORMATIVE_PRIOR,
        evidenceSetHash: '',
        sourceIds: [],
        domain: 'GENERAL',
        sampleCount: 0,
        historicalSkill: 0.5,
        weight: 1.0
      };
    }

    if (typeof item === 'number') {
      const p = this.clampProbability(item);
      return {
        agentId: fallbackKey,
        pForecast: p,
        calibratedP: p,
        evidenceSetHash: '',
        sourceIds: [],
        domain: 'GENERAL',
        sampleCount: 0,
        historicalSkill: 0.5,
        weight: 1.0
      };
    }

    const agentId = String(
      item.agentId || item.agent || item.name || item.id || fallbackKey
    ).trim();

    // Raw probability extraction
    const rawVal = item.pForecast ?? item.forecast ?? item.probability ?? item.score ?? UNINFORMATIVE_PRIOR;
    const pForecast = this.clampProbability(Number(rawVal));

    // Calibrated probability extraction
    const calVal = item.calibratedP ?? item.calibratedForecast ?? pForecast;
    const calibratedP = this.clampProbability(Number(calVal));

    // Source IDs extraction
    let sourceIds = [];
    if (Array.isArray(item.sourceIds)) {
      sourceIds = item.sourceIds.map(s => String(s).trim()).filter(Boolean);
    } else if (Array.isArray(item.sources)) {
      sourceIds = item.sources.map(s => String(s).trim()).filter(Boolean);
    } else if (Array.isArray(item.evidenceSources)) {
      sourceIds = item.evidenceSources.map(s => String(s).trim()).filter(Boolean);
    } else if (typeof item.sourceIds === 'string' && item.sourceIds) {
      sourceIds = [item.sourceIds.trim()];
    }

    // Evidence Set Hash computation
    let evidenceSetHash = item.evidenceSetHash || item.evidenceHash || '';
    if (!evidenceSetHash && sourceIds.length > 0) {
      const sortedSources = [...sourceIds].sort().join('|');
      evidenceSetHash = crypto.createHash('sha256').update(sortedSources).digest('hex').slice(0, 16);
    }

    const domain = String(item.domain || item.eventClass || item.category || 'GENERAL').toUpperCase();
    const sampleCount = typeof item.sampleCount === 'number' ? Math.max(0, item.sampleCount) : (typeof item.count === 'number' ? Math.max(0, item.count) : 0);
    
    // Historical skill: Brier skill score or normalized reliability weight
    let historicalSkill = 0.5;
    if (typeof item.historicalSkill === 'number' && !isNaN(item.historicalSkill)) {
      historicalSkill = Math.max(0, item.historicalSkill);
    } else if (typeof item.skill === 'number' && !isNaN(item.skill)) {
      historicalSkill = Math.max(0, item.skill);
    } else if (typeof item.brierSkillScore === 'number' && !isNaN(item.brierSkillScore)) {
      // Map BSS [-1, 1] to positive skill domain [0, 1]
      historicalSkill = Math.max(0, Math.min(1, (item.brierSkillScore + 1) / 2));
    } else if (typeof item.weight === 'number' && !isNaN(item.weight)) {
      historicalSkill = Math.max(0, item.weight);
    }

    const weight = typeof item.weight === 'number' && !isNaN(item.weight) && item.weight >= 0
      ? item.weight
      : historicalSkill;

    return {
      agentId,
      pForecast,
      calibratedP,
      evidenceSetHash,
      sourceIds,
      domain,
      sampleCount,
      historicalSkill,
      weight
    };
  }

  /**
   * Normalizes an array or dictionary map of forecasts into standard CanonicalAgentForecast[].
   * @param {Array<Object|number>|Object.<string, Object|number>} input - Raw forecasts
   * @returns {CanonicalAgentForecast[]}
   */
  normalizeForecasts(input) {
    if (!input || typeof input !== 'object') {
      return [];
    }

    const list = [];
    if (Array.isArray(input)) {
      input.forEach((item, idx) => {
        list.push(this.normalizeForecast(item, `agent_${idx + 1}`));
      });
    } else {
      for (const [key, val] of Object.entries(input)) {
        list.push(this.normalizeForecast(val, key));
      }
    }

    return list;
  }

  /**
   * Computes pairwise Jaccard similarity of sourceIds across all agents.
   * Jaccard(A, B) = |sources(A) ∩ sources(B)| / |sources(A) ∪ sources(B)|.
   * Also accounts for exact evidenceSetHash matches.
   * 
   * @param {CanonicalAgentForecast[]} forecasts - Canonical agent forecasts
   * @returns {OverlapMatrixResult}
   */
  computeOverlapMatrix(forecasts) {
    const list = Array.isArray(forecasts) ? forecasts : this.normalizeForecasts(forecasts);
    const n = list.length;
    const matrix = {};
    const pairwiseList = [];
    const highOverlapPairs = [];
    const severeOverlapPairs = [];

    // Initialize diagonal and square matrix
    for (let i = 0; i < n; i++) {
      const agentA = list[i].agentId;
      if (!matrix[agentA]) matrix[agentA] = {};
      matrix[agentA][agentA] = 1.0;
    }

    for (let i = 0; i < n; i++) {
      const fA = list[i];
      const agentA = fA.agentId;
      const setA = new Set(fA.sourceIds.map(s => s.toLowerCase()));

      for (let j = i + 1; j < n; j++) {
        const fB = list[j];
        const agentB = fB.agentId;
        const setB = new Set(fB.sourceIds.map(s => s.toLowerCase()));

        let similarity = 0;
        let sharedCount = 0;

        // Check if both have source IDs
        if (setA.size > 0 && setB.size > 0) {
          for (const s of setA) {
            if (setB.has(s)) sharedCount++;
          }
          const unionSize = setA.size + setB.size - sharedCount;
          similarity = unionSize > 0 ? Number((sharedCount / unionSize).toFixed(4)) : 0;
        } else if (fA.evidenceSetHash && fB.evidenceSetHash && fA.evidenceSetHash === fB.evidenceSetHash) {
          // Exact evidence hash identity match
          similarity = 1.0;
          sharedCount = Math.max(setA.size, setB.size, 1);
        }

        matrix[agentA][agentB] = similarity;
        if (!matrix[agentB]) matrix[agentB] = {};
        matrix[agentB][agentA] = similarity;

        const pairRecord = {
          agentA,
          agentB,
          similarity,
          sharedCount,
          totalA: setA.size,
          totalB: setB.size
        };
        pairwiseList.push(pairRecord);

        if (similarity >= OVERLAP_PENALTY_THRESHOLD) {
          highOverlapPairs.push({ agentA, agentB, similarity, sharedCount });
        }
        if (similarity >= SEVERE_OVERLAP_THRESHOLD) {
          severeOverlapPairs.push({ agentA, agentB, similarity, sharedCount });
        }
      }
    }

    return {
      matrix,
      pairwiseList,
      highOverlapPairs,
      severeOverlapPairs
    };
  }

  /**
   * Adjusts base agent reliability weights for evidence overlap.
   * If agents A and B share >50% sources, their redundancy is penalized.
   * If two agents share >70% sources, the weight of the less skilled one is halved.
   * 
   * @param {Object.<string, number>} weights - Map of agentId to raw base weight
   * @param {OverlapMatrixResult} overlapResult - Result from computeOverlapMatrix
   * @param {CanonicalAgentForecast[]} [forecasts=[]] - Canonical forecasts for skill comparison
   * @returns {{ adjustedWeights: Object.<string, number>, normalizedWeights: Object.<string, number>, overlapPenalties: Object.<string, number>, rawWeights: Object.<string, number> }}
   */
  adjustWeightsForOverlap(weights, overlapResult, forecasts = []) {
    const rawWeights = { ...weights };
    const adjustedWeights = {};
    const overlapPenalties = {};

    // Skill map for pairwise comparison
    const skillMap = {};
    for (const f of forecasts) {
      skillMap[f.agentId] = f.historicalSkill ?? rawWeights[f.agentId] ?? 0.5;
    }

    const agentIds = Object.keys(rawWeights);
    for (const id of agentIds) {
      overlapPenalties[id] = 1.0;
      adjustedWeights[id] = rawWeights[id];
    }

    if (!overlapResult || !Array.isArray(overlapResult.pairwiseList)) {
      const total = Object.values(rawWeights).reduce((a, b) => a + b, 0);
      const normalizedWeights = {};
      for (const id of agentIds) {
        normalizedWeights[id] = total > 0 ? Number((rawWeights[id] / total).toFixed(6)) : (1 / (agentIds.length || 1));
      }
      return { adjustedWeights: rawWeights, normalizedWeights, overlapPenalties, rawWeights };
    }

    // Sort pairwise relationships by descending similarity to handle strongest overlap first
    const sortedPairs = [...overlapResult.pairwiseList].sort((a, b) => b.similarity - a.similarity);

    for (const pair of sortedPairs) {
      const { agentA, agentB, similarity } = pair;
      if (similarity < OVERLAP_PENALTY_THRESHOLD) continue;

      const skillA = skillMap[agentA] ?? rawWeights[agentA] ?? 0.5;
      const skillB = skillMap[agentB] ?? rawWeights[agentB] ?? 0.5;

      let lessSkilled = null;
      let moreSkilled = null;

      if (skillA > skillB) {
        moreSkilled = agentA;
        lessSkilled = agentB;
      } else if (skillB > skillA) {
        moreSkilled = agentB;
        lessSkilled = agentA;
      }

      if (similarity >= SEVERE_OVERLAP_THRESHOLD) {
        // Severe overlap (>70%): Halve the weight of the less skilled agent
        if (lessSkilled) {
          overlapPenalties[lessSkilled] = Math.min(overlapPenalties[lessSkilled], 0.50);
        } else {
          // Equal skill: split penalty equally (each dampened to ~70.7%)
          overlapPenalties[agentA] = Math.min(overlapPenalties[agentA], 0.707);
          overlapPenalties[agentB] = Math.min(overlapPenalties[agentB], 0.707);
        }
      } else {
        // Moderate overlap (50% - 70%): Graduated penalty factor (1.0 - (similarity - 0.50))
        const penaltyFactor = Math.max(0.60, Number((1.0 - (similarity - OVERLAP_PENALTY_THRESHOLD)).toFixed(4)));
        if (lessSkilled) {
          overlapPenalties[lessSkilled] = Math.min(overlapPenalties[lessSkilled], penaltyFactor);
        } else {
          const splitFactor = Number(Math.sqrt(penaltyFactor).toFixed(4));
          overlapPenalties[agentA] = Math.min(overlapPenalties[agentA], splitFactor);
          overlapPenalties[agentB] = Math.min(overlapPenalties[agentB], splitFactor);
        }
      }
    }

    // Apply penalties and compute total
    let totalAdjusted = 0;
    for (const id of agentIds) {
      const penalized = rawWeights[id] * overlapPenalties[id];
      adjustedWeights[id] = Number(penalized.toFixed(6));
      totalAdjusted += adjustedWeights[id];
    }

    // Normalize adjusted weights
    const normalizedWeights = {};
    if (totalAdjusted <= 0) {
      const uniform = 1.0 / (agentIds.length || 1);
      for (const id of agentIds) {
        normalizedWeights[id] = Number(uniform.toFixed(6));
      }
    } else {
      for (const id of agentIds) {
        normalizedWeights[id] = Number((adjustedWeights[id] / totalAdjusted).toFixed(6));
      }
    }

    return {
      adjustedWeights,
      normalizedWeights,
      overlapPenalties,
      rawWeights
    };
  }

  /**
   * Tracks pairwise forecast correlation across historical episodes.
   * Computes empirical Pearson correlation matrix r(A, B).
   * 
   * @param {Array<Object>} episodes - Array of episode records containing agentForecasts
   * @returns {Object.<string, Object.<string, number>>} Correlation matrix
   */
  computeCorrelationMatrix(episodes = []) {
    const list = Array.isArray(episodes) ? episodes : [];
    const stats = {};

    for (const ep of list) {
      if (!ep || !ep.agentForecasts) continue;
      const normalized = this.normalizeForecasts(ep.agentForecasts);
      const n = normalized.length;

      for (let i = 0; i < n; i++) {
        const agentA = normalized[i].agentId;
        const pA = normalized[i].calibratedP;

        if (!stats[agentA]) stats[agentA] = {};

        for (let j = i; j < n; j++) {
          const agentB = normalized[j].agentId;
          const pB = normalized[j].calibratedP;

          if (!stats[agentA][agentB]) {
            stats[agentA][agentB] = { sumProd: 0, sumA: 0, sumB: 0, sumSqA: 0, sumSqB: 0, count: 0 };
          }

          const cell = stats[agentA][agentB];
          cell.sumProd += pA * pB;
          cell.sumA += pA;
          cell.sumB += pB;
          cell.sumSqA += pA * pA;
          cell.sumSqB += pB * pB;
          cell.count++;
        }
      }
    }

    const correlationMatrix = {};
    for (const agentA of Object.keys(stats)) {
      if (!correlationMatrix[agentA]) correlationMatrix[agentA] = {};
      for (const agentB of Object.keys(stats[agentA])) {
        if (!correlationMatrix[agentB]) correlationMatrix[agentB] = {};

        const cell = stats[agentA][agentB];
        if (agentA === agentB) {
          correlationMatrix[agentA][agentB] = 1.0;
          continue;
        }

        if (cell.count < 3) {
          correlationMatrix[agentA][agentB] = 0.0;
          correlationMatrix[agentB][agentA] = 0.0;
          continue;
        }

        const n = cell.count;
        const num = (n * cell.sumProd) - (cell.sumA * cell.sumB);
        const denA = (n * cell.sumSqA) - (cell.sumA * cell.sumA);
        const denB = (n * cell.sumSqB) - (cell.sumB * cell.sumB);
        const den = Math.sqrt(Math.max(0, denA) * Math.max(0, denB));

        const r = den > 1e-9 ? Number((num / den).toFixed(4)) : 0.0;
        const clampedR = Math.max(-1.0, Math.min(1.0, r));

        correlationMatrix[agentA][agentB] = clampedR;
        correlationMatrix[agentB][agentA] = clampedR;
      }
    }

    this.pairwiseCorrelations = correlationMatrix;
    return correlationMatrix;
  }

  /**
   * Estimates uncertainty interval from weighted disagreement among agent forecasts.
   * Uses weighted standard deviation:
   * Interval: [ensemble - 1.5 * wstd, ensemble + 1.5 * wstd], clamped to [0.01, 0.99].
   * 
   * @param {CanonicalAgentForecast[]|Array<number|Object>|Object.<string, number|Object>} forecasts - Forecast items
   * @param {Object.<string, number>} [weights=null] - Normalized agent weights
   * @returns {{ interval: [number, number], wstd: number, spread: number }}
   */
  estimateUncertainty(forecasts, weights = null) {
    const list = Array.isArray(forecasts) ? forecasts : this.normalizeForecasts(forecasts);
    if (list.length === 0) {
      return {
        interval: [this.minProbability, this.maxProbability],
        wstd: 0.5,
        spread: Number((this.maxProbability - this.minProbability).toFixed(4))
      };
    }

    if (list.length === 1) {
      const p = list[0].calibratedP ?? list[0].pForecast ?? UNINFORMATIVE_PRIOR;
      return {
        interval: [p, p],
        wstd: 0.0,
        spread: 0.0
      };
    }

    // Determine normalized weights
    let weightMap = {};
    let totalWeight = 0;

    for (const f of list) {
      let w = 1.0;
      if (weights && typeof weights[f.agentId] === 'number') {
        w = weights[f.agentId];
      } else if (typeof f.weight === 'number') {
        w = f.weight;
      } else if (typeof f.historicalSkill === 'number') {
        w = f.historicalSkill;
      }
      if (isNaN(w) || w < 0) w = 0;
      weightMap[f.agentId] = w;
      totalWeight += w;
    }

    if (totalWeight <= 0) {
      const uniform = 1.0 / list.length;
      for (const f of list) {
        weightMap[f.agentId] = uniform;
      }
      totalWeight = 1.0;
    }

    // Weighted mean
    let weightedMean = 0;
    for (const f of list) {
      const normW = weightMap[f.agentId] / totalWeight;
      weightedMean += normW * (f.calibratedP ?? f.pForecast);
    }

    // Weighted variance
    let weightedVariance = 0;
    for (const f of list) {
      const normW = weightMap[f.agentId] / totalWeight;
      const diff = (f.calibratedP ?? f.pForecast) - weightedMean;
      weightedVariance += normW * (diff * diff);
    }

    const wstd = Math.sqrt(Math.max(0, weightedVariance));
    const margin = this.uncertaintyMultiplier * wstd;

    const pLow = this.clampProbability(Number((weightedMean - margin).toFixed(4)));
    const pHigh = this.clampProbability(Number((weightedMean + margin).toFixed(4)));

    const low = Math.min(pLow, pHigh);
    const high = Math.max(pLow, pHigh);

    return {
      interval: [low, high],
      wstd: Number(wstd.toFixed(6)),
      spread: Number((high - low).toFixed(4))
    };
  }

  /**
   * Helper to calculate Brier score: (p - y)^2
   * @param {number} forecast - Probability forecast [0.01, 0.99]
   * @param {number|boolean|string} outcome - Actual binary outcome (0 or 1)
   * @returns {number} Quadratic Brier loss
   */
  calculateBrierScore(forecast, outcome) {
    const p = this.clampProbability(forecast);
    const y = (outcome === 1 || outcome === true || outcome === 'YES' || outcome === 'yes' || outcome === '1') ? 1.0 : 0.0;
    return Number(Math.pow(p - y, 2).toFixed(6));
  }

  /**
   * Helper to calculate logarithmic loss: - (y*ln(p) + (1-y)*ln(1-p))
   * @param {number} forecast - Probability forecast [0.01, 0.99]
   * @param {number|boolean|string} outcome - Actual binary outcome (0 or 1)
   * @returns {number} Logarithmic loss
   */
  calculateLogLoss(forecast, outcome) {
    const p = this.clampProbability(forecast);
    const y = (outcome === 1 || outcome === true || outcome === 'YES' || outcome === 'yes' || outcome === '1') ? 1.0 : 0.0;
    const loss = -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    return Number(loss.toFixed(6));
  }

  // ==========================================================================
  // FOUR COMBINATION METHODS
  // ==========================================================================

  /**
   * Method 1: Reliability-Weighted Pool with Evidence Overlap Correction.
   * Computes linear weighted average with Jaccard-based redundancy penalties.
   * 
   * @param {CanonicalAgentForecast[]|Object.<string, any>} forecasts - Agent forecasts
   * @param {Object.<string, number>} [weights=null] - Optional base reliability weights
   * @param {Object} [options={}] - Options (e.g. disableOverlapCorrection)
   * @returns {EnsembleResult}
   */
  reliabilityWeightedPool(forecasts, weights = null, options = {}) {
    const timestamp = new Date().toISOString();
    const canonicalList = this.normalizeForecasts(forecasts);
    const agentCount = canonicalList.length;

    if (agentCount === 0) {
      logger.warn('[ReliabilityWeightedEnsemble] Empty forecasts list in reliabilityWeightedPool.');
      return {
        ensembleForecast: UNINFORMATIVE_PRIOR,
        method: ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL,
        weights: {},
        rawWeights: {},
        adjustedWeights: {},
        overlapPenalties: {},
        uncertaintyInterval: [this.minProbability, this.maxProbability],
        uncertaintySpread: Number((this.maxProbability - this.minProbability).toFixed(4)),
        wstd: 0.5,
        contributions: {},
        agentCount: 0,
        timestamp
      };
    }

    // 1. Extract base weights
    const rawWeights = {};
    for (const f of canonicalList) {
      let w = 1.0;
      if (weights && typeof weights[f.agentId] === 'number') {
        w = Math.max(0, weights[f.agentId]);
      } else if (typeof f.weight === 'number') {
        w = Math.max(0, f.weight);
      } else if (typeof f.historicalSkill === 'number') {
        w = Math.max(0, f.historicalSkill);
      }
      rawWeights[f.agentId] = w;
    }

    // 2. Compute evidence overlap matrix
    const overlapResult = this.computeOverlapMatrix(canonicalList);

    // 3. Adjust weights for overlap (unless explicitly disabled)
    let adjustedResult;
    if (options.disableOverlapCorrection) {
      const totalRaw = Object.values(rawWeights).reduce((a, b) => a + b, 0);
      const normalized = {};
      for (const f of canonicalList) {
        normalized[f.agentId] = totalRaw > 0 ? Number((rawWeights[f.agentId] / totalRaw).toFixed(6)) : (1 / agentCount);
      }
      adjustedResult = {
        adjustedWeights: rawWeights,
        normalizedWeights: normalized,
        overlapPenalties: {},
        rawWeights
      };
    } else {
      adjustedResult = this.adjustWeightsForOverlap(rawWeights, overlapResult, canonicalList);
    }

    // 4. Compute weighted probability
    let weightedSum = 0;
    const contributions = {};

    for (const f of canonicalList) {
      const normW = adjustedResult.normalizedWeights[f.agentId] || 0;
      const calP = f.calibratedP;
      const itemContribution = normW * calP;
      weightedSum += itemContribution;

      contributions[f.agentId] = {
        rawForecast: f.pForecast,
        calibratedP: calP,
        weight: normW,
        rawWeight: rawWeights[f.agentId],
        adjustedWeight: adjustedResult.adjustedWeights[f.agentId],
        overlapPenalty: adjustedResult.overlapPenalties[f.agentId] || 1.0,
        contribution: Number(itemContribution.toFixed(6)),
        sourceCount: f.sourceIds.length
      };
    }

    const ensembleForecast = this.clampProbability(Number(weightedSum.toFixed(6)));

    // 5. Uncertainty interval
    const uncertainty = this.estimateUncertainty(canonicalList, adjustedResult.normalizedWeights);

    return {
      ensembleForecast,
      method: ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL,
      weights: adjustedResult.normalizedWeights,
      rawWeights: adjustedResult.rawWeights,
      adjustedWeights: adjustedResult.adjustedWeights,
      overlapPenalties: adjustedResult.overlapPenalties,
      redundancyPenalties: adjustedResult.overlapPenalties,
      overlapMatrix: overlapResult,
      uncertaintyInterval: uncertainty.interval,
      uncertaintySpread: uncertainty.spread,
      wstd: uncertainty.wstd,
      contributions,
      agentCount,
      timestamp
    };
  }

  /**
   * Method 2: Log-Odds Opinion Pool (Aggregates in Logit Space).
   * 1. logit(p_i) = ln(p_i / (1 - p_i))
   * 2. logit_ens = sum(w_i * logit(p_i))
   * 3. p_ens = 1 / (1 + exp(-logit_ens))
   * 
   * @param {CanonicalAgentForecast[]|Object.<string, any>} forecasts - Agent forecasts
   * @param {Object.<string, number>} [weights=null] - Optional base reliability weights
   * @param {Object} [options={}] - Additional options
   * @returns {EnsembleResult}
   */
  logOddsPool(forecasts, weights = null, options = {}) {
    const timestamp = new Date().toISOString();
    const canonicalList = this.normalizeForecasts(forecasts);
    const agentCount = canonicalList.length;

    if (agentCount === 0) {
      return {
        ensembleForecast: UNINFORMATIVE_PRIOR,
        method: ENSEMBLE_METHODS.LOG_ODDS_POOL,
        weights: {},
        rawWeights: {},
        adjustedWeights: {},
        overlapPenalties: {},
        uncertaintyInterval: [this.minProbability, this.maxProbability],
        uncertaintySpread: Number((this.maxProbability - this.minProbability).toFixed(4)),
        wstd: 0.5,
        contributions: {},
        agentCount: 0,
        timestamp,
        metadata: { logOdds: 0 }
      };
    }

    // 1. Base weights
    const rawWeights = {};
    for (const f of canonicalList) {
      let w = 1.0;
      if (weights && typeof weights[f.agentId] === 'number') {
        w = Math.max(0, weights[f.agentId]);
      } else if (typeof f.weight === 'number') {
        w = Math.max(0, f.weight);
      } else if (typeof f.historicalSkill === 'number') {
        w = Math.max(0, f.historicalSkill);
      }
      rawWeights[f.agentId] = w;
    }

    // 2. Evidence overlap correction
    const overlapResult = this.computeOverlapMatrix(canonicalList);
    const adjustedResult = this.adjustWeightsForOverlap(rawWeights, overlapResult, canonicalList);

    // 3. Log-odds aggregation
    let weightedLogOddsSum = 0;
    const contributions = {};

    for (const f of canonicalList) {
      const normW = adjustedResult.normalizedWeights[f.agentId] || 0;
      const calP = f.calibratedP;
      const agentLogOdds = this.toLogOdds(calP);
      const contribution = normW * agentLogOdds;
      weightedLogOddsSum += contribution;

      contributions[f.agentId] = {
        rawForecast: f.pForecast,
        calibratedP: calP,
        logOdds: Number(agentLogOdds.toFixed(6)),
        weight: normW,
        contribution: Number(contribution.toFixed(6))
      };
    }

    const ensembleForecast = this.fromLogOdds(weightedLogOddsSum);
    const uncertainty = this.estimateUncertainty(canonicalList, adjustedResult.normalizedWeights);

    return {
      ensembleForecast,
      method: ENSEMBLE_METHODS.LOG_ODDS_POOL,
      weights: adjustedResult.normalizedWeights,
      rawWeights: adjustedResult.rawWeights,
      adjustedWeights: adjustedResult.adjustedWeights,
      overlapPenalties: adjustedResult.overlapPenalties,
      overlapMatrix: overlapResult,
      uncertaintyInterval: uncertainty.interval,
      uncertaintySpread: uncertainty.spread,
      wstd: uncertainty.wstd,
      contributions,
      agentCount,
      timestamp,
      metadata: {
        logOdds: Number(weightedLogOddsSum.toFixed(6))
      }
    };
  }

  /**
   * Fits regularized logistic regression meta-learner coefficients for Logistic Stacking.
   * Model: logit(p_ensemble) = beta_0 + sum(beta_i * logit(p_i))
   * 
   * @param {Array<Object>} trainingEpisodes - Resolved episodes containing agentForecasts and outcome
   * @param {Object} [options={}] - Fitting hyper-parameters (e.g. l2Penalty, learningRate, iterations)
   * @returns {{ intercept: number, weights: Object.<string, number>, sampleCount: number, meanBrier: number }}
   */
  fitLogisticStacking(trainingEpisodes = [], options = {}) {
    const l2Penalty = options.l2Penalty ?? 0.1;
    const lr = options.learningRate ?? 0.05;
    const iterations = options.iterations ?? 100;

    // Filter valid resolved episodes
    const validSamples = [];
    const agentSet = new Set();

    for (const ep of trainingEpisodes) {
      if (!ep || ep.outcome === null || ep.outcome === undefined || !ep.agentForecasts) continue;
      const outcome = (ep.outcome === 1 || ep.outcome === true || ep.outcome === 'YES' || ep.outcome === 'yes') ? 1.0 : 0.0;
      const forecasts = this.normalizeForecasts(ep.agentForecasts);
      if (forecasts.length === 0) continue;

      const row = { outcome, features: {} };
      for (const f of forecasts) {
        row.features[f.agentId] = this.toLogOdds(f.calibratedP);
        agentSet.add(f.agentId);
      }
      validSamples.push(row);
    }

    const agents = Array.from(agentSet);
    if (validSamples.length < 3 || agents.length === 0) {
      // Prior baseline: equal weights, intercept 0
      const defaultWeights = {};
      const uniform = 1.0 / (agents.length || 1);
      for (const a of agents) defaultWeights[a] = Number(uniform.toFixed(4));
      return { intercept: 0.0, weights: defaultWeights, sampleCount: validSamples.length, meanBrier: 0.25 };
    }

    // Initialize coefficients
    let beta0 = 0.0;
    const beta = {};
    const initW = 1.0 / agents.length;
    for (const a of agents) beta[a] = initW;

    // Gradient descent with L2 ridge regularization
    const n = validSamples.length;
    for (let iter = 0; iter < iterations; iter++) {
      let grad0 = 0;
      const gradBeta = {};
      for (const a of agents) gradBeta[a] = 0;

      for (const sample of validSamples) {
        let z = beta0;
        for (const a of agents) {
          const feat = sample.features[a] ?? 0;
          z += beta[a] * feat;
        }

        const pred = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
        const error = pred - sample.outcome;

        grad0 += error;
        for (const a of agents) {
          const feat = sample.features[a] ?? 0;
          gradBeta[a] += error * feat;
        }
      }

      // Update parameters with L2 regularization penalty
      beta0 -= (lr * (grad0 / n));
      for (const a of agents) {
        gradBeta[a] = (gradBeta[a] / n) + (l2Penalty * beta[a]);
        beta[a] = Math.max(0, beta[a] - (lr * gradBeta[a])); // non-negativity constraint on stacking weights
      }
    }

    // Compute training Brier loss
    let brierSum = 0;
    for (const sample of validSamples) {
      let z = beta0;
      for (const a of agents) {
        z += beta[a] * (sample.features[a] ?? 0);
      }
      const pred = this.clampProbability(1 / (1 + Math.exp(-z)));
      brierSum += Math.pow(pred - sample.outcome, 2);
    }

    const result = {
      intercept: Number(beta0.toFixed(4)),
      weights: {},
      sampleCount: validSamples.length,
      meanBrier: Number((brierSum / n).toFixed(6)),
      trainedAt: new Date().toISOString()
    };

    for (const a of agents) {
      result.weights[a] = Number(beta[a].toFixed(4));
    }

    this.logisticStackingCoefficients = result;
    this._saveState();

    return result;
  }

  /**
   * Method 3: Logistic Stacking Consensus.
   * Uses trained or prior logistic regression coefficients to combine agent predictions.
   * 
   * @param {CanonicalAgentForecast[]|Object.<string, any>} forecasts - Agent forecasts
   * @param {Array<Object>|Object} [outcomesOrOptions=null] - Optional training episodes or options
   * @param {Object} [options={}] - Additional options
   * @returns {EnsembleResult}
   */
  logisticStacking(forecasts, outcomesOrOptions = null, options = {}) {
    const timestamp = new Date().toISOString();
    const canonicalList = this.normalizeForecasts(forecasts);
    const agentCount = canonicalList.length;

    if (agentCount === 0) {
      return {
        ensembleForecast: UNINFORMATIVE_PRIOR,
        method: ENSEMBLE_METHODS.LOGISTIC_STACKING,
        weights: {},
        rawWeights: {},
        adjustedWeights: {},
        overlapPenalties: {},
        uncertaintyInterval: [this.minProbability, this.maxProbability],
        uncertaintySpread: Number((this.maxProbability - this.minProbability).toFixed(4)),
        wstd: 0.5,
        contributions: {},
        agentCount: 0,
        timestamp,
        metadata: { isTrained: false, intercept: 0 }
      };
    }

    // Check if training episodes provided in 2nd argument
    if (Array.isArray(outcomesOrOptions) && outcomesOrOptions.length > 0) {
      this.fitLogisticStacking(outcomesOrOptions, options);
    }

    const trainedCoeffs = this.logisticStackingCoefficients;
    const isTrained = !!(trainedCoeffs && trainedCoeffs.sampleCount >= 5);

    // Compute coefficients for current agents
    const intercept = isTrained ? (trainedCoeffs.intercept || 0) : 0;
    const coeffWeights = {};
    let totalCoeffWeight = 0;

    for (const f of canonicalList) {
      let w = isTrained && trainedCoeffs.weights && typeof trainedCoeffs.weights[f.agentId] === 'number'
        ? trainedCoeffs.weights[f.agentId]
        : f.historicalSkill ?? 0.5;
      w = Math.max(0.01, w);
      coeffWeights[f.agentId] = w;
      totalCoeffWeight += w;
    }

    // Normalize weights
    const normalizedWeights = {};
    for (const f of canonicalList) {
      normalizedWeights[f.agentId] = totalCoeffWeight > 0
        ? Number((coeffWeights[f.agentId] / totalCoeffWeight).toFixed(6))
        : (1 / agentCount);
    }

    // Compute stacked logit
    let z = intercept;
    const contributions = {};

    for (const f of canonicalList) {
      const normW = normalizedWeights[f.agentId];
      const logitVal = this.toLogOdds(f.calibratedP);
      const contribution = normW * logitVal;
      z += contribution;

      contributions[f.agentId] = {
        rawForecast: f.pForecast,
        calibratedP: f.calibratedP,
        logOdds: Number(logitVal.toFixed(6)),
        weight: normW,
        coefficient: coeffWeights[f.agentId],
        contribution: Number(contribution.toFixed(6))
      };
    }

    const ensembleForecast = this.fromLogOdds(z);
    const uncertainty = this.estimateUncertainty(canonicalList, normalizedWeights);

    return {
      ensembleForecast,
      method: ENSEMBLE_METHODS.LOGISTIC_STACKING,
      weights: normalizedWeights,
      rawWeights: coeffWeights,
      adjustedWeights: coeffWeights,
      overlapPenalties: {},
      uncertaintyInterval: uncertainty.interval,
      uncertaintySpread: uncertainty.spread,
      wstd: uncertainty.wstd,
      contributions,
      agentCount,
      timestamp,
      metadata: {
        isTrained,
        intercept,
        z: Number(z.toFixed(6)),
        sampleCount: isTrained ? trainedCoeffs.sampleCount : 0
      }
    };
  }

  /**
   * Method 4: Bayesian Model Averaging (BMA).
   * Computes posterior model weights P(M_i | D) and aggregates predictions with
   * total variance decomposition (within-model variance + between-model variance).
   * 
   * @param {CanonicalAgentForecast[]|Object.<string, any>} forecasts - Agent forecasts
   * @param {Object.<string, number>} [modelPriors=null] - Optional prior probabilities P(M_i)
   * @param {Object} [options={}] - Additional options
   * @returns {EnsembleResult}
   */
  bayesianModelAveraging(forecasts, modelPriors = null, options = {}) {
    const timestamp = new Date().toISOString();
    const canonicalList = this.normalizeForecasts(forecasts);
    const agentCount = canonicalList.length;

    if (agentCount === 0) {
      return {
        ensembleForecast: UNINFORMATIVE_PRIOR,
        method: ENSEMBLE_METHODS.BAYESIAN_MODEL_AVERAGING,
        weights: {},
        rawWeights: {},
        adjustedWeights: {},
        overlapPenalties: {},
        uncertaintyInterval: [this.minProbability, this.maxProbability],
        uncertaintySpread: Number((this.maxProbability - this.minProbability).toFixed(4)),
        wstd: 0.5,
        contributions: {},
        agentCount: 0,
        timestamp,
        metadata: { withinVariance: 0, betweenVariance: 0, totalVariance: 0 }
      };
    }

    // 1. Model priors P(M_i)
    const priors = {};
    let totalPrior = 0;
    for (const f of canonicalList) {
      let p = 1.0;
      if (modelPriors && typeof modelPriors[f.agentId] === 'number') {
        p = Math.max(0.01, modelPriors[f.agentId]);
      } else if (typeof f.historicalSkill === 'number') {
        p = Math.max(0.01, f.historicalSkill);
      }
      priors[f.agentId] = p;
      totalPrior += p;
    }

    // 2. Marginal Likelihood Estimation P(D | M_i)
    // Derived from historical Brier skill score / sample count if available
    const logLikelihoods = {};
    for (const f of canonicalList) {
      const skill = Math.max(0.01, Math.min(1.0, f.historicalSkill ?? 0.5));
      const nSamples = Math.min(50, Math.max(1, f.sampleCount || 5));
      // Likelihood proxy scaled by empirical skill and sample confidence
      logLikelihoods[f.agentId] = Math.log(skill) * Math.sqrt(nSamples);
    }

    // 3. Posterior Model Probabilities P(M_i | D) = P(D | M_i) * P(M_i) / sum
    const maxLogLik = Math.max(...Object.values(logLikelihoods));
    const posteriorNumerators = {};
    let totalPosterior = 0;

    for (const f of canonicalList) {
      const normalizedPrior = totalPrior > 0 ? (priors[f.agentId] / totalPrior) : (1 / agentCount);
      const likelihood = Math.exp(logLikelihoods[f.agentId] - maxLogLik);
      const num = likelihood * normalizedPrior;
      posteriorNumerators[f.agentId] = num;
      totalPosterior += num;
    }

    const posteriorWeights = {};
    for (const f of canonicalList) {
      posteriorWeights[f.agentId] = totalPosterior > 0
        ? Number((posteriorNumerators[f.agentId] / totalPosterior).toFixed(6))
        : (1 / agentCount);
    }

    // 4. Evidence overlap dampening on posterior weights
    const overlapResult = this.computeOverlapMatrix(canonicalList);
    const adjustedResult = this.adjustWeightsForOverlap(posteriorWeights, overlapResult, canonicalList);

    // 5. BMA Posterior Mean Forecast
    let bmaMean = 0;
    const contributions = {};

    for (const f of canonicalList) {
      const w = adjustedResult.normalizedWeights[f.agentId];
      const p = f.calibratedP;
      const contribution = w * p;
      bmaMean += contribution;

      contributions[f.agentId] = {
        rawForecast: f.pForecast,
        calibratedP: p,
        prior: Number((priors[f.agentId] / (totalPrior || 1)).toFixed(4)),
        posteriorWeight: w,
        contribution: Number(contribution.toFixed(6))
      };
    }

    const ensembleForecast = this.clampProbability(Number(bmaMean.toFixed(6)));

    // 6. Law of Total Variance Decomposition:
    // Var(Y) = sum(w_i * Var(Y | M_i)) + sum(w_i * (E[Y | M_i] - E[Y])^2)
    // Within-model variance for Bernoulli: p_i * (1 - p_i)
    // Between-model variance (epistemic uncertainty): (p_i - bmaMean)^2
    let withinVariance = 0;
    let betweenVariance = 0;

    for (const f of canonicalList) {
      const w = adjustedResult.normalizedWeights[f.agentId];
      const p = f.calibratedP;
      withinVariance += w * (p * (1 - p));
      betweenVariance += w * Math.pow(p - ensembleForecast, 2);
    }

    const totalVariance = withinVariance + betweenVariance;
    const betweenStd = Math.sqrt(Math.max(0, betweenVariance));

    // Uncertainty interval from between-model epistemic disagreement
    const margin = this.uncertaintyMultiplier * betweenStd;
    const pLow = this.clampProbability(Number((ensembleForecast - margin).toFixed(4)));
    const pHigh = this.clampProbability(Number((ensembleForecast + margin).toFixed(4)));

    const low = Math.min(pLow, pHigh);
    const high = Math.max(pLow, pHigh);

    return {
      ensembleForecast,
      method: ENSEMBLE_METHODS.BAYESIAN_MODEL_AVERAGING,
      weights: adjustedResult.normalizedWeights,
      rawWeights: priors,
      adjustedWeights: adjustedResult.adjustedWeights,
      overlapPenalties: adjustedResult.overlapPenalties,
      overlapMatrix: overlapResult,
      uncertaintyInterval: [low, high],
      uncertaintySpread: Number((high - low).toFixed(4)),
      wstd: Number(betweenStd.toFixed(6)),
      contributions,
      agentCount,
      timestamp,
      metadata: {
        withinVariance: Number(withinVariance.toFixed(6)),
        betweenVariance: Number(betweenVariance.toFixed(6)),
        totalVariance: Number(totalVariance.toFixed(6))
      }
    };
  }

  // ==========================================================================
  // DYNAMIC METHOD SELECTION & ORCHESTRATION
  // ==========================================================================

  /**
   * Compares all combination methods on recent resolved episodes and selects the top performer.
   * Defaults to reliabilityWeightedPool when empirical data is insufficient (< minEpisodes).
   * 
   * @param {CanonicalAgentForecast[]|Object} forecasts - Current agent forecasts
   * @param {Array<Object>|Object} episodicMemory - Episodic memory store or resolved episodes array
   * @param {Object} [options={}] - Selection criteria options
   * @returns {{ selectedMethod: string, methodScores: Object.<string, { meanBrier: number, meanLogLoss: number, sampleCount: number }>, reason: string, sampleCount: number }}
   */
  selectMethod(forecasts, episodicMemory = null, options = {}) {
    // Extract resolved episodes
    let episodes = [];
    if (Array.isArray(episodicMemory)) {
      episodes = episodicMemory;
    } else if (episodicMemory && typeof episodicMemory.getResolvedEpisodes === 'function') {
      episodes = episodicMemory.getResolvedEpisodes();
    } else if (episodicMemory && typeof episodicMemory.getAllEpisodes === 'function') {
      episodes = episodicMemory.getAllEpisodes();
    } else if (episodicMemory && Array.isArray(episodicMemory.episodes)) {
      episodes = episodicMemory.episodes;
    } else if (Array.isArray(this.recentEvaluations) && this.recentEvaluations.length > 0) {
      episodes = this.recentEvaluations;
    }

    const resolved = episodes.filter(ep => ep && ep.outcome !== null && ep.outcome !== undefined && ep.agentForecasts);

    if (resolved.length < this.minEpisodesForMethodSelection) {
      return {
        selectedMethod: ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL,
        methodScores: {},
        reason: `Insufficient resolved episodes (${resolved.length} < ${this.minEpisodesForMethodSelection}). Using default starting method.`,
        sampleCount: resolved.length
      };
    }

    // Evaluate each method on recent resolved episodes (max 50)
    const testSet = resolved.slice(-50);
    const methodScores = {
      [ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL]: { brierSum: 0, logLossSum: 0, count: 0 },
      [ENSEMBLE_METHODS.LOG_ODDS_POOL]: { brierSum: 0, logLossSum: 0, count: 0 },
      [ENSEMBLE_METHODS.LOGISTIC_STACKING]: { brierSum: 0, logLossSum: 0, count: 0 },
      [ENSEMBLE_METHODS.BAYESIAN_MODEL_AVERAGING]: { brierSum: 0, logLossSum: 0, count: 0 }
    };

    for (const ep of testSet) {
      const y = (ep.outcome === 1 || ep.outcome === true || ep.outcome === 'YES' || ep.outcome === 'yes') ? 1.0 : 0.0;
      const fList = this.normalizeForecasts(ep.agentForecasts);
      if (fList.length === 0) continue;

      // 1. Reliability weighted
      const res1 = this.reliabilityWeightedPool(fList);
      methodScores[ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL].brierSum += this.calculateBrierScore(res1.ensembleForecast, y);
      methodScores[ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL].logLossSum += this.calculateLogLoss(res1.ensembleForecast, y);
      methodScores[ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL].count++;

      // 2. Log-odds pool
      const res2 = this.logOddsPool(fList);
      methodScores[ENSEMBLE_METHODS.LOG_ODDS_POOL].brierSum += this.calculateBrierScore(res2.ensembleForecast, y);
      methodScores[ENSEMBLE_METHODS.LOG_ODDS_POOL].logLossSum += this.calculateLogLoss(res2.ensembleForecast, y);
      methodScores[ENSEMBLE_METHODS.LOG_ODDS_POOL].count++;

      // 3. Logistic stacking
      const res3 = this.logisticStacking(fList);
      methodScores[ENSEMBLE_METHODS.LOGISTIC_STACKING].brierSum += this.calculateBrierScore(res3.ensembleForecast, y);
      methodScores[ENSEMBLE_METHODS.LOGISTIC_STACKING].logLossSum += this.calculateLogLoss(res3.ensembleForecast, y);
      methodScores[ENSEMBLE_METHODS.LOGISTIC_STACKING].count++;

      // 4. Bayesian model averaging
      const res4 = this.bayesianModelAveraging(fList);
      methodScores[ENSEMBLE_METHODS.BAYESIAN_MODEL_AVERAGING].brierSum += this.calculateBrierScore(res4.ensembleForecast, y);
      methodScores[ENSEMBLE_METHODS.BAYESIAN_MODEL_AVERAGING].logLossSum += this.calculateLogLoss(res4.ensembleForecast, y);
      methodScores[ENSEMBLE_METHODS.BAYESIAN_MODEL_AVERAGING].count++;
    }

    // Rank methods by mean Brier score
    const rankings = [];
    const formattedScores = {};

    for (const [method, data] of Object.entries(methodScores)) {
      if (data.count === 0) continue;
      const meanBrier = Number((data.brierSum / data.count).toFixed(6));
      const meanLogLoss = Number((data.logLossSum / data.count).toFixed(6));
      formattedScores[method] = { meanBrier, meanLogLoss, sampleCount: data.count };
      rankings.push({ method, meanBrier });
    }

    rankings.sort((a, b) => a.meanBrier - b.meanBrier);

    const winner = rankings.length > 0 ? rankings[0].method : ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL;
    const bestScore = rankings.length > 0 ? rankings[0].meanBrier : 0.25;

    return {
      selectedMethod: winner,
      methodScores: formattedScores,
      reason: `Method '${winner}' demonstrated superior empirical Brier score (${bestScore.toFixed(4)}) on ${testSet.length} resolved episodes.`,
      sampleCount: testSet.length
    };
  }

  /**
   * Primary consensus aggregation method with automatic or explicit method routing.
   * 
   * @param {CanonicalAgentForecast[]|Object.<string, any>} forecasts - Agent forecasts
   * @param {Object} [options={}] - Options
   * @param {string} [options.method='auto'] - Specific method or 'auto' for dynamic selection
   * @param {Object} [options.episodicMemory] - Episodic memory for dynamic method selection
   * @param {Object.<string, number>} [options.weights] - Optional manual weights
   * @returns {EnsembleResult}
   */
  combine(forecasts, options = {}) {
    const requestedMethod = options.method || 'auto';
    let chosenMethod = ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL;
    let selectionMeta = null;

    if (requestedMethod === 'auto') {
      const selection = this.selectMethod(forecasts, options.episodicMemory);
      chosenMethod = selection.selectedMethod;
      selectionMeta = selection;
    } else if (Object.values(ENSEMBLE_METHODS).includes(requestedMethod)) {
      chosenMethod = requestedMethod;
    }

    let result;
    switch (chosenMethod) {
      case ENSEMBLE_METHODS.LOG_ODDS_POOL:
        result = this.logOddsPool(forecasts, options.weights, options);
        break;
      case ENSEMBLE_METHODS.LOGISTIC_STACKING:
        result = this.logisticStacking(forecasts, options.trainingEpisodes, options);
        break;
      case ENSEMBLE_METHODS.BAYESIAN_MODEL_AVERAGING:
        result = this.bayesianModelAveraging(forecasts, options.modelPriors, options);
        break;
      case ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL:
      default:
        result = this.reliabilityWeightedPool(forecasts, options.weights, options);
        break;
    }

    if (selectionMeta) {
      result.selectionMetadata = selectionMeta;
    }

    // Update tracking stats
    if (this.methodPerformance[chosenMethod]) {
      this.methodPerformance[chosenMethod].lastSelected = new Date().toISOString();
    }

    return result;
  }

  /**
   * Records a resolved outcome to track method performance and update correlation matrices.
   * 
   * @param {string} predictionId - Unique ID of prediction episode
   * @param {number|boolean|string} outcome - Realized binary outcome
   * @param {CanonicalAgentForecast[]|Object} agentForecasts - Agent forecasts
   * @param {string} [domain='GENERAL'] - Domain class
   */
  recordResolvedOutcome(predictionId, outcome, agentForecasts, domain = 'GENERAL') {
    const y = (outcome === 1 || outcome === true || outcome === 'YES' || outcome === 'yes' || outcome === '1') ? 1.0 : 0.0;
    const forecasts = this.normalizeForecasts(agentForecasts);
    if (forecasts.length === 0) return;

    const timestamp = new Date().toISOString();

    // Evaluate all 4 methods
    const poolRes = this.reliabilityWeightedPool(forecasts);
    const logOddsRes = this.logOddsPool(forecasts);
    const stackingRes = this.logisticStacking(forecasts);
    const bmaRes = this.bayesianModelAveraging(forecasts);

    const methods = [
      { name: ENSEMBLE_METHODS.RELIABILITY_WEIGHTED_POOL, pred: poolRes.ensembleForecast },
      { name: ENSEMBLE_METHODS.LOG_ODDS_POOL, pred: logOddsRes.ensembleForecast },
      { name: ENSEMBLE_METHODS.LOGISTIC_STACKING, pred: stackingRes.ensembleForecast },
      { name: ENSEMBLE_METHODS.BAYESIAN_MODEL_AVERAGING, pred: bmaRes.ensembleForecast }
    ];

    let minBrier = Infinity;
    let winningMethod = null;

    for (const m of methods) {
      const brier = this.calculateBrierScore(m.pred, y);
      const logLoss = this.calculateLogLoss(m.pred, y);

      if (this.methodPerformance[m.name]) {
        const perf = this.methodPerformance[m.name];
        perf.totalEvaluated++;
        perf.brierSum += brier;
        perf.logLossSum += logLoss;
      }

      if (brier < minBrier) {
        minBrier = brier;
        winningMethod = m.name;
      }

      // SQLite insertion if available
      if (this.db) {
        try {
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO oracle_ensemble_method_tracking
            (id, timestamp, method, prediction, outcome, brier_loss, log_loss, domain, agent_count, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          stmt.run(
            `${predictionId}_${m.name}`,
            timestamp,
            m.name,
            m.pred,
            y,
            brier,
            logLoss,
            domain,
            forecasts.length,
            JSON.stringify({ winningMethod: m.name === winningMethod })
          );
        } catch (_) {}
      }
    }

    if (winningMethod && this.methodPerformance[winningMethod]) {
      this.methodPerformance[winningMethod].winCount++;
    }

    this.recentEvaluations.push({
      predictionId,
      timestamp,
      outcome: y,
      agentForecasts,
      domain
    });

    if (this.recentEvaluations.length > 200) {
      this.recentEvaluations.shift();
    }

    this._saveState();
  }

  /**
   * Retrieves summary performance telemetry for all combination methods.
   * @returns {Object.<string, { totalEvaluated: number, meanBrier: number|null, meanLogLoss: number|null, winCount: number, winRate: number|null, lastSelected: string|null }>}
   */
  getMethodPerformanceSummary() {
    const summary = {};
    for (const [method, perf] of Object.entries(this.methodPerformance)) {
      const total = perf.totalEvaluated;
      summary[method] = {
        totalEvaluated: total,
        meanBrier: total > 0 ? Number((perf.brierSum / total).toFixed(6)) : null,
        meanLogLoss: total > 0 ? Number((perf.logLossSum / total).toFixed(6)) : null,
        winCount: perf.winCount,
        winRate: total > 0 ? Number((perf.winCount / total).toFixed(4)) : null,
        lastSelected: perf.lastSelected
      };
    }
    return summary;
  }

  // ==========================================================================
  // BACKWARD COMPATIBILITY INTERFACES
  // ==========================================================================

  /**
   * Backward compatible Bayesian weighted pool combiner.
   * @param {Object.<string, number|Object>|Array} agentForecasts - Input forecasts
   * @param {string} [eventClass='GENERAL'] - Event classification domain
   * @param {Object} [agentReputationEngine=null] - Optional reputation engine
   * @returns {EnsembleResult}
   */
  combineForecastsWeighted(agentForecasts, eventClass = 'GENERAL', agentReputationEngine = null) {
    const canonicalList = this.normalizeForecasts(agentForecasts);
    const weights = {};

    if (agentReputationEngine) {
      for (const f of canonicalList) {
        if (typeof agentReputationEngine.calibrateForecast === 'function') {
          try {
            const cal = agentReputationEngine.calibrateForecast(f.agentId, f.pForecast, eventClass);
            if (typeof cal === 'number' && !isNaN(cal)) {
              f.calibratedP = this.clampProbability(cal);
            }
          } catch (_) {}
        }
        if (typeof agentReputationEngine.computeWeight === 'function') {
          try {
            const repWeight = agentReputationEngine.computeWeight(f.agentId, eventClass);
            const w = (typeof repWeight === 'number') ? repWeight : (repWeight?.weight ?? 1.0);
            weights[f.agentId] = Math.max(0, w);
          } catch (_) {
            weights[f.agentId] = 1.0;
          }
        }
      }
    }

    return this.reliabilityWeightedPool(canonicalList, Object.keys(weights).length > 0 ? weights : null);
  }

  /**
   * Backward compatible simple arithmetic mean aggregator.
   * @param {Array<number|Object>|Object.<string, number|Object>} forecasts - Forecast values
   * @returns {number} Clamped arithmetic mean probability
   */
  combineForecastsSimple(forecasts) {
    const canonicalList = this.normalizeForecasts(forecasts);
    if (canonicalList.length === 0) return UNINFORMATIVE_PRIOR;

    let sum = 0;
    for (const f of canonicalList) {
      sum += f.calibratedP;
    }

    return this.clampProbability(Number((sum / canonicalList.length).toFixed(6)));
  }

  /**
   * Backward compatible log-odds aggregator.
   * @param {Object.<string, number|Object>|Array<number|Object>} agentForecasts - Map or list of forecasts
   * @param {Object.<string, number>|Array<number>} [weights=null] - Optional reliability weights
   * @returns {EnsembleResult}
   */
  combineForecastsLogOdds(agentForecasts, weights = null) {
    return this.logOddsPool(agentForecasts, weights);
  }

  /**
   * Evaluates ensemble performance against episodic memory benchmarks.
   * @param {Object|Array<Object>} episodicMemory - Episodic memory records
   * @returns {Object} Comprehensive evaluation metrics
   */
  evaluateEnsemblePerformance(episodicMemory) {
    const evaluatedAt = new Date().toISOString();

    let episodes = [];
    if (Array.isArray(episodicMemory)) {
      episodes = episodicMemory;
    } else if (episodicMemory && typeof episodicMemory.getResolvedEpisodes === 'function') {
      episodes = episodicMemory.getResolvedEpisodes();
    } else if (episodicMemory && typeof episodicMemory.getAllEpisodes === 'function') {
      episodes = episodicMemory.getAllEpisodes();
    } else if (episodicMemory && Array.isArray(episodicMemory.episodes)) {
      episodes = episodicMemory.episodes;
    } else if (episodicMemory && Array.isArray(episodicMemory.history)) {
      episodes = episodicMemory.history;
    }

    const resolved = episodes.filter(ep => ep && ep.outcome !== null && ep.outcome !== undefined);

    if (resolved.length === 0) {
      return {
        totalEpisodes: episodes.length,
        resolvedEpisodes: 0,
        ensemble: { meanBrier: null, meanLogLoss: null, totalEvaluated: 0 },
        market: { meanBrier: null, meanLogLoss: null, totalEvaluated: 0 },
        agents: {},
        comparison: {
          brierSkillScoreVsMarket: null,
          brierSkillScoreVsReference: null,
          ensembleVsMarketBrierDelta: null,
          bestAgent: null,
          ensembleRank: null
        },
        status: 'NO_RESOLVED_EPISODES',
        evaluatedAt
      };
    }

    let ensembleBrierSum = 0;
    let ensembleLogLossSum = 0;
    let marketBrierSum = 0;
    let marketLogLossSum = 0;
    let marketCount = 0;
    const agentStats = {};

    for (const ep of resolved) {
      const outcome = (ep.outcome === 1 || ep.outcome === '1' || ep.outcome === true || ep.outcome === 'YES' || ep.outcome === 'yes') ? 1.0 : 0.0;

      // Ensemble forecast
      const ensembleP = this.clampProbability(
        ep.ensembleForecast ?? ep.calibratedForecast ?? (ep.agentForecasts ? this.combineForecastsSimple(ep.agentForecasts) : UNINFORMATIVE_PRIOR)
      );
      ensembleBrierSum += this.calculateBrierScore(ensembleP, outcome);
      ensembleLogLossSum += this.calculateLogLoss(ensembleP, outcome);

      // Market price
      if (ep.marketPrice !== null && ep.marketPrice !== undefined) {
        const marketP = this.clampProbability(Number(ep.marketPrice));
        marketBrierSum += this.calculateBrierScore(marketP, outcome);
        marketLogLossSum += this.calculateLogLoss(marketP, outcome);
        marketCount++;
      }

      // Agents
      if (ep.agentForecasts) {
        const agentList = this.normalizeForecasts(ep.agentForecasts);
        for (const a of agentList) {
          if (!agentStats[a.agentId]) {
            agentStats[a.agentId] = { brierSum: 0, logLossSum: 0, count: 0 };
          }
          agentStats[a.agentId].brierSum += this.calculateBrierScore(a.calibratedP, outcome);
          agentStats[a.agentId].logLossSum += this.calculateLogLoss(a.calibratedP, outcome);
          agentStats[a.agentId].count++;
        }
      }
    }

    const n = resolved.length;
    const ensembleMeanBrier = Number((ensembleBrierSum / n).toFixed(6));
    const ensembleMeanLogLoss = Number((ensembleLogLossSum / n).toFixed(6));
    const marketMeanBrier = marketCount > 0 ? Number((marketBrierSum / marketCount).toFixed(6)) : null;
    const marketMeanLogLoss = marketCount > 0 ? Number((marketLogLossSum / marketCount).toFixed(6)) : null;

    const rankingList = [{ name: 'Ensemble', meanBrier: ensembleMeanBrier, isEnsemble: true }];
    const agentsReport = {};

    for (const [agent, st] of Object.entries(agentStats)) {
      const meanBrier = Number((st.brierSum / st.count).toFixed(6));
      const meanLogLoss = Number((st.logLossSum / st.count).toFixed(6));
      const bssRef = Number((1 - (meanBrier / BASELINE_REFERENCE_BRIER)).toFixed(4));
      const bssMarket = (marketMeanBrier !== null && marketMeanBrier > 0)
        ? Number((1 - (meanBrier / marketMeanBrier)).toFixed(4))
        : null;

      agentsReport[agent] = {
        meanBrier,
        meanLogLoss,
        totalEvaluated: st.count,
        brierSkillScoreVsReference: bssRef,
        brierSkillScoreVsMarket: bssMarket
      };

      rankingList.push({ name: agent, meanBrier, isEnsemble: false });
    }

    rankingList.sort((a, b) => a.meanBrier - b.meanBrier);
    const ensembleRank = rankingList.findIndex(r => r.isEnsemble) + 1;
    const individualAgents = rankingList.filter(r => !r.isEnsemble);
    const bestAgent = individualAgents.length > 0 ? individualAgents[0] : null;

    const brierSkillScoreVsReference = Number((1 - (ensembleMeanBrier / BASELINE_REFERENCE_BRIER)).toFixed(4));
    const brierSkillScoreVsMarket = (marketMeanBrier !== null && marketMeanBrier > 0)
      ? Number((1 - (ensembleMeanBrier / marketMeanBrier)).toFixed(4))
      : null;
    const ensembleVsMarketBrierDelta = marketMeanBrier !== null
      ? Number((marketMeanBrier - ensembleMeanBrier).toFixed(6))
      : null;

    return {
      totalEpisodes: episodes.length,
      resolvedEpisodes: n,
      ensemble: {
        meanBrier: ensembleMeanBrier,
        meanLogLoss: ensembleMeanLogLoss,
        totalEvaluated: n
      },
      market: {
        meanBrier: marketMeanBrier,
        meanLogLoss: marketMeanLogLoss,
        totalEvaluated: marketCount
      },
      agents: agentsReport,
      comparison: {
        brierSkillScoreVsMarket,
        brierSkillScoreVsReference,
        ensembleVsMarketBrierDelta,
        bestAgent: bestAgent ? { name: bestAgent.name, meanBrier: bestAgent.meanBrier } : null,
        ensembleRank,
        totalCompetitors: rankingList.length,
        outperformsMarket: ensembleVsMarketBrierDelta !== null ? ensembleVsMarketBrierDelta > 0 : null
      },
      status: 'SUCCESS',
      evaluatedAt
    };
  }
}

// Instantiate singleton instance
const reliabilityWeightedEnsemble = new ReliabilityWeightedEnsemble();

module.exports = {
  ReliabilityWeightedEnsemble,
  reliabilityWeightedEnsemble
};
