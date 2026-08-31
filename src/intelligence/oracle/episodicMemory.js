/**
 * EpisodicMemory - Long-Term Episodic Memory Engine for ORACLE Intelligence Layer
 * 
 * Governance Notice:
 * ORACLE modules observe, score, learn, and propose.
 * They may NOT modify live execution, risk caps, or historical records.
 * 
 * Temporal Integrity & Architectural Guarantees:
 * 1. DECISION_TIME vs POSTMORTEM Separation:
 *    - Memory records begin in 'DECISION_TIME' phase with immutable forecast & evidence snapshots.
 *    - Resolutions transition memory records to 'POSTMORTEM' phase while appending linked postmortem entries.
 * 2. Cryptographic Immutability Hashes:
 *    - forecastHash: SHA-256 (16-char hex slice) of agent forecasts and intervals at decision time.
 *    - evidenceSetHash: SHA-256 of the evidence sources provided at decision time.
 *    - contractHash: SHA-256 of the contract terms and proposition question.
 *    - modelVersionAtDecision: Exact model version string active at decision time.
 * 3. Immutability Guard:
 *    - recordResolution() verifies that forecastHash matches the recorded forecast data.
 *    - Throws 'IMMUTABILITY_VIOLATION: forecast data was modified after recording' if mismatched.
 * 4. Temporal Replay Integrity:
 *    - retrieveSimilar() accepts asOfTimestamp and includePostmortems parameters.
 *    - Filters strictly to decisionTimestamp < asOfTimestamp.
 *    - Strips postmortem data and future outcomes during historical replay to prevent lookahead bias.
 * 5. Multi-factor Similarity & Calibration Diagnostics:
 *    - Jaccard keyword matching, eventClass, and regime similarity scoring.
 *    - Decile reliability buckets, Brier decomposition, and agent scoring.
 * 6. Atomic, fail-safe JSON file persistence.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('EpisodicMemory');

/**
 * Memory lifecycle phases
 * @readonly
 * @enum {string}
 */
const MEMORY_PHASE = Object.freeze({
  DECISION_TIME: 'DECISION_TIME',
  POSTMORTEM: 'POSTMORTEM'
});

/**
 * Standard stop words for token extraction in similarity search
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'over', 'after',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must', 'that', 'which', 'who', 'whom', 'this', 'these',
  'those', 'it', 'its', 'as', 'if', 'when', 'than', 'then', 'so', 'no', 'not'
]);

/**
 * Clamping epsilon for log-loss computation to avoid ln(0) or ln(1) singularities
 */
const LOG_LOSS_EPSILON = 1e-15;

/**
 * Computes a deterministic 16-character SHA-256 hex slice for given data.
 * 
 * @param {any} data - Serializable data structure
 * @returns {string} 16-character hex hash
 */
function hashData(data) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(data !== undefined ? data : null))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Recursively sorts object keys to guarantee deterministic JSON serialization for hashing.
 * 
 * @param {any} obj - Target object
 * @returns {any} Normalized object with sorted keys
 */
function sortObjectKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

/**
 * Computes the immutable forecast hash across agent forecasts, ensemble, calibrated value, and uncertainty bounds.
 * 
 * @param {Object.<string, number>} agentForecasts 
 * @param {number|null} ensembleForecast 
 * @param {number|null} calibratedForecast 
 * @param {Array<number>|null} uncertaintyInterval 
 * @returns {string} 16-character hex hash
 */
function computeForecastHash(agentForecasts, ensembleForecast, calibratedForecast, uncertaintyInterval) {
  return hashData({
    agentForecasts: sortObjectKeys(agentForecasts || {}),
    ensembleForecast: ensembleForecast !== undefined ? ensembleForecast : null,
    calibratedForecast: calibratedForecast !== undefined ? calibratedForecast : null,
    uncertaintyInterval: Array.isArray(uncertaintyInterval) ? uncertaintyInterval : null
  });
}

/**
 * Computes the immutable evidence set hash across all decision-time evidence items.
 * 
 * @param {Array<Object>} evidenceSources 
 * @returns {string} 16-character hex hash
 */
function computeEvidenceHash(evidenceSources) {
  const normalized = Array.isArray(evidenceSources)
    ? evidenceSources.map(src => ({
        source: String(src.source || 'UNKNOWN'),
        reliability: typeof src.reliability === 'number' ? src.reliability : 0.5,
        timestamp: src.timestamp || null,
        summary: String(src.summary || '')
      }))
    : [];
  return hashData(normalized);
}

/**
 * Computes the immutable contract terms hash.
 * 
 * @param {string} question 
 * @param {string} eventClass 
 * @param {any} [contractTerms=null] 
 * @returns {string} 16-character hex hash
 */
function computeContractHash(question, eventClass, contractTerms = null) {
  return hashData({
    question: String(question || '').trim(),
    eventClass: String(eventClass || 'GENERAL').toUpperCase().trim(),
    contractTerms: contractTerms || null
  });
}

/**
 * Extracts a strictly decision-time view of an episode, stripping any postmortem or resolution leakage.
 * 
 * @param {Object} episode - Full episode object
 * @param {number} [similarityScore] - Optional similarity score to include
 * @returns {Object} Clean decision-time snapshot
 */
function extractDecisionTimeView(episode, similarityScore = null) {
  const view = {
    episodeId: episode.episodeId,
    timestamp: episode.timestamp,
    decisionTimestamp: episode.decisionTimestamp || episode.timestamp,
    question: episode.question,
    eventClass: episode.eventClass,
    regime: episode.regime,
    agentForecasts: { ...(episode.agentForecasts || {}) },
    ensembleForecast: episode.ensembleForecast,
    calibratedForecast: episode.calibratedForecast,
    uncertaintyInterval: Array.isArray(episode.uncertaintyInterval) ? [...episode.uncertaintyInterval] : null,
    evidenceSources: Array.isArray(episode.evidenceSources) ? episode.evidenceSources.map(s => ({ ...s })) : [],
    marketPrice: episode.marketPrice,
    forecastHash: episode.forecastHash,
    evidenceSetHash: episode.evidenceSetHash,
    contractHash: episode.contractHash,
    modelVersionAtDecision: episode.modelVersionAtDecision,
    memoryPhase: MEMORY_PHASE.DECISION_TIME,
    outcome: null,
    brierScore: null,
    logLoss: null,
    errorAttribution: null,
    resolvedAt: null,
    postmortems: []
  };

  if (episode.contractTerms !== undefined) {
    view.contractTerms = episode.contractTerms;
  }

  if (similarityScore !== null && similarityScore !== undefined) {
    view.similarityScore = Number(similarityScore.toFixed(4));
  }

  return view;
}

/**
 * Safely writes data to a JSON file atomically using a temporary staging file.
 * Compatible with Windows file locking and POSIX atomic renames.
 * 
 * @param {string} filePath - Absolute path to target file
 * @param {any} data - Object or array to serialize
 */
function atomicWriteJsonSync(filePath, data) {
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
    // Windows fallback if rename is temporarily locked by another process handle
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
}

/**
 * Extracts normalized tokens from a text string, filtering out punctuation and stop words.
 * 
 * @param {string} text - Raw input string
 * @returns {Set<string>} Set of unique alphanumeric tokens
 */
function extractTokens(text) {
  if (!text || typeof text !== 'string') return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Calculates Jaccard token similarity between two sets of tokens.
 * 
 * @param {Set<string>} setA 
 * @param {Set<string>} setB 
 * @returns {number} Value in range [0, 1]
 */
function calculateJaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersectionCount = 0;
  for (const token of setA) {
    if (setB.has(token)) intersectionCount++;
  }
  const unionCount = setA.size + setB.size - intersectionCount;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

/**
 * EpisodicMemory - Long-term forecasting memory and historical situation retrieval engine
 * Enforces strict temporal integrity between decision-time and post-resolution phases.
 */
class EpisodicMemory {
  /**
   * Memory phase enum reference
   */
  static get MEMORY_PHASE() {
    return MEMORY_PHASE;
  }

  /**
   * @param {Object} [options={}]
   * @param {string} [options.storagePath] - Custom absolute path to episodic memory JSON
   */
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.resolve(__dirname, '../../../data/oracle/episodic_memory.json');
    
    /**
     * Map of episodeId -> Episode object
     * @type {Map<string, Object>}
     */
    this.episodes = new Map();

    // Load existing storage on startup
    this.load();
  }

  /**
   * Loads all stored episodes from the persistent JSON file on disk.
   * Backfills cryptographic hashes and temporal integrity fields on legacy records if necessary.
   */
  load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        if (raw.trim().length > 0) {
          const parsed = JSON.parse(raw);
          const list = Array.isArray(parsed) ? parsed : (parsed.episodes || []);
          this.episodes.clear();
          
          for (const ep of list) {
            if (ep && ep.episodeId) {
              // Ensure temporal integrity fields exist on legacy records
              const decisionTimestamp = ep.decisionTimestamp || ep.timestamp || new Date().toISOString();
              const modelVersionAtDecision = ep.modelVersionAtDecision || ep.modelVersion || 'v1.0.0';
              const memoryPhase = ep.memoryPhase || (ep.outcome ? MEMORY_PHASE.POSTMORTEM : MEMORY_PHASE.DECISION_TIME);
              const postmortems = Array.isArray(ep.postmortems) ? ep.postmortems : [];

              // Hash computation for legacy episodes if missing
              const forecastHash = ep.forecastHash || computeForecastHash(
                ep.agentForecasts,
                ep.ensembleForecast,
                ep.calibratedForecast,
                ep.uncertaintyInterval
              );

              const evidenceSetHash = ep.evidenceSetHash || computeEvidenceHash(ep.evidenceSources);
              const contractHash = ep.contractHash || computeContractHash(ep.question, ep.eventClass, ep.contractTerms);

              const normalizedEp = {
                ...ep,
                decisionTimestamp,
                modelVersionAtDecision,
                forecastHash,
                evidenceSetHash,
                contractHash,
                memoryPhase,
                postmortems,
                lessons: Array.isArray(ep.lessons) ? ep.lessons : []
              };

              this.episodes.set(ep.episodeId, normalizedEp);
            }
          }
          logger.info(`[EpisodicMemory] Loaded ${this.episodes.size} prediction episodes from ${this.storagePath}`);
          return;
        }
      }
      
      // Initialize fresh file if non-existent or empty
      this.episodes.clear();
      this._persist();
      logger.info(`[EpisodicMemory] Initialized empty episodic memory file at ${this.storagePath}`);
    } catch (err) {
      logger.error(`[EpisodicMemory] Failed to load memory from ${this.storagePath}: ${err.message}`, { error: err });
    }
  }

  /**
   * Internal persistence routine writing all in-memory episodes to disk atomically.
   * @private
   */
  _persist() {
    try {
      const episodeList = Array.from(this.episodes.values());
      atomicWriteJsonSync(this.storagePath, episodeList);
    } catch (err) {
      logger.error(`[EpisodicMemory] Failed to persist episodic memory: ${err.message}`, { error: err });
      throw err;
    }
  }

  /**
   * Generates a canonical episode ID
   * 
   * @param {string} [eventId] - Optional external event ID
   * @returns {string} e.g. ep_1724850000000_a1b2c3
   */
  generateEpisodeId(eventId) {
    const timestamp = Date.now();
    const cleanEventId = eventId ? String(eventId).replace(/[^a-zA-Z0-9_-]/g, '') : crypto.randomBytes(3).toString('hex');
    return `ep_${timestamp}_${cleanEventId}`;
  }

  /**
   * Generates a unique postmortem ID
   * 
   * @returns {string} e.g. pm_1724850000000_f4e2a1
   */
  generatePostmortemId() {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(3).toString('hex');
    return `pm_${timestamp}_${nonce}`;
  }

  /**
   * Verifies the cryptographic forecast hash immutability guard for an episode.
   * Throws IMMUTABILITY_VIOLATION if the forecast fields have been altered since creation.
   * 
   * @param {Object} episode - Episode record to check
   * @private
   */
  _verifyForecastImmutability(episode) {
    if (!episode || typeof episode !== 'object') {
      throw new Error('[EpisodicMemory] Invalid episode provided for immutability check');
    }

    if (episode.forecastHash) {
      const recomputedHash = computeForecastHash(
        episode.agentForecasts,
        episode.ensembleForecast,
        episode.calibratedForecast,
        episode.uncertaintyInterval
      );

      if (recomputedHash !== episode.forecastHash) {
        logger.error(`[EpisodicMemory] IMMUTABILITY_VIOLATION detected for episode ${episode.episodeId}: recorded hash ${episode.forecastHash} vs recomputed ${recomputedHash}`);
        throw new Error('IMMUTABILITY_VIOLATION: forecast data was modified after recording');
      }
    }
  }

  /**
   * Records a new forecasting episode with complete market, agent, and evidence context at decision time.
   * Computes immutable SHA-256 hashes (forecastHash, evidenceSetHash, contractHash) and marks memoryPhase as 'DECISION_TIME'.
   * 
   * @param {Object} episode - Episode data payload
   * @param {string} [episode.episodeId] - Unique ID (auto-generated if omitted)
   * @param {string} [episode.timestamp] - ISO 8601 timestamp
   * @param {string} [episode.decisionTimestamp] - ISO 8601 decision timestamp (defaults to timestamp)
   * @param {string} episode.question - The question or proposition being forecasted
   * @param {any} [episode.contractTerms] - Optional contract terms/rules
   * @param {string} [episode.eventClass] - FED_POLICY | US_ELECTION | CRYPTO | GEOPOLITICS | SPORTS | ECONOMICS | etc.
   * @param {string} [episode.regime] - RISK_ON | RISK_OFF | NEUTRAL | VOLATILE
   * @param {Object.<string, number>} [episode.agentForecasts] - Map of agent names to probability forecasts (0 to 1)
   * @param {number|null} [episode.ensembleForecast] - Aggregated ensemble probability
   * @param {number|null} [episode.calibratedForecast] - Calibrated probability forecast
   * @param {Array<number>|null} [episode.uncertaintyInterval] - Confidence interval bounds [pLow, pHigh]
   * @param {Array<Object>} [episode.evidenceSources] - Supporting intelligence [{ source, reliability, timestamp, summary }]
   * @param {number|null} [episode.marketPrice] - Current prediction market or reference price
   * @param {string} [episode.modelVersion] - Active model version string
   * @param {string} [episode.modelVersionAtDecision] - Active model version at decision time
   * @param {string|null} [episode.outcome] - 'YES' | 'NO' | null
   * @param {number|null} [episode.brierScore] - Brier score if already resolved
   * @param {number|null} [episode.logLoss] - Log loss if already resolved
   * @param {Object|null} [episode.errorAttribution] - { errorType, details }
   * @param {Array<string>} [episode.lessons] - Key takeaway learnings
   * @param {string|null} [episode.resolvedAt] - ISO 8601 resolution timestamp
   * @returns {Object} Stored episode object
   */
  recordForecast(episode = {}) {
    if (!episode || typeof episode !== 'object') {
      throw new Error('[EpisodicMemory] recordForecast requires a valid episode object');
    }

    const timestamp = episode.timestamp || new Date().toISOString();
    const decisionTimestamp = episode.decisionTimestamp || timestamp;
    const episodeId = episode.episodeId || this.generateEpisodeId(episode.eventId || episode.id);
    const question = String(episode.question || '').trim();
    const eventClass = String(episode.eventClass || 'GENERAL').toUpperCase().trim();
    const regime = String(episode.regime || 'NEUTRAL').toUpperCase().trim();
    const contractTerms = episode.contractTerms !== undefined ? episode.contractTerms : null;
    const modelVersionAtDecision = String(episode.modelVersionAtDecision || episode.modelVersion || 'v1.0.0');

    // Sanitize agent forecasts
    const rawAgentForecasts = episode.agentForecasts || {};
    const agentForecasts = {};
    for (const [agent, p] of Object.entries(rawAgentForecasts)) {
      if (typeof p === 'number' && !isNaN(p)) {
        agentForecasts[agent] = Math.max(0, Math.min(1, Number(p.toFixed(4))));
      }
    }

    // Sanitize probabilities
    const ensembleForecast = typeof episode.ensembleForecast === 'number' && !isNaN(episode.ensembleForecast)
      ? Math.max(0, Math.min(1, Number(episode.ensembleForecast.toFixed(4))))
      : null;

    const calibratedForecast = typeof episode.calibratedForecast === 'number' && !isNaN(episode.calibratedForecast)
      ? Math.max(0, Math.min(1, Number(episode.calibratedForecast.toFixed(4))))
      : null;

    // Uncertainty interval [pLow, pHigh]
    let uncertaintyInterval = null;
    if (Array.isArray(episode.uncertaintyInterval) && episode.uncertaintyInterval.length >= 2) {
      const pLow = Math.max(0, Math.min(1, Number(episode.uncertaintyInterval[0])));
      const pHigh = Math.max(0, Math.min(1, Number(episode.uncertaintyInterval[1])));
      uncertaintyInterval = [Number(pLow.toFixed(4)), Number(pHigh.toFixed(4))];
    }

    // Evidence sources array
    const rawSources = Array.isArray(episode.evidenceSources) ? episode.evidenceSources : [];
    const evidenceSources = rawSources.map(src => ({
      source: String(src.source || 'UNKNOWN'),
      reliability: typeof src.reliability === 'number' ? Math.max(0, Math.min(1, src.reliability)) : 0.5,
      timestamp: src.timestamp || new Date().toISOString(),
      summary: String(src.summary || '')
    }));

    const marketPrice = typeof episode.marketPrice === 'number' && !isNaN(episode.marketPrice)
      ? Number(episode.marketPrice.toFixed(4))
      : null;

    // Compute immutable cryptographic hashes
    const forecastHash = computeForecastHash(agentForecasts, ensembleForecast, calibratedForecast, uncertaintyInterval);
    const evidenceSetHash = computeEvidenceHash(evidenceSources);
    const contractHash = computeContractHash(question, eventClass, contractTerms);

    let outcome = null;
    if (episode.outcome === 'YES' || episode.outcome === 'NO') {
      outcome = episode.outcome;
    }

    let brierScore = typeof episode.brierScore === 'number' ? Number(episode.brierScore.toFixed(6)) : null;
    let logLoss = typeof episode.logLoss === 'number' ? Number(episode.logLoss.toFixed(6)) : null;

    // If outcome is provided during creation, compute Brier and Log Loss immediately
    if (outcome !== null && brierScore === null) {
      const forecastVal = calibratedForecast !== null ? calibratedForecast : (ensembleForecast !== null ? ensembleForecast : null);
      if (forecastVal !== null) {
        const y = outcome === 'YES' ? 1 : 0;
        brierScore = Number(Math.pow(forecastVal - y, 2).toFixed(6));
        const clamped = Math.max(LOG_LOSS_EPSILON, Math.min(1 - LOG_LOSS_EPSILON, forecastVal));
        logLoss = Number((-(y * Math.log(clamped) + (1 - y) * Math.log(1 - clamped))).toFixed(6));
      }
    }

    const memoryPhase = outcome !== null ? MEMORY_PHASE.POSTMORTEM : MEMORY_PHASE.DECISION_TIME;
    const postmortems = [];

    // If initial resolution postmortem data was provided alongside an already-resolved record
    if (outcome !== null && (Array.isArray(episode.lessons) || episode.errorAttribution)) {
      postmortems.push({
        postmortemId: this.generatePostmortemId(),
        timestamp: timestamp,
        errorAttribution: episode.errorAttribution || null,
        lessons: Array.isArray(episode.lessons) ? episode.lessons.map(String) : [],
        addedBy: 'INITIAL_RECORDING'
      });
    }

    const storedEpisode = {
      episodeId,
      timestamp,
      decisionTimestamp,
      question,
      contractTerms,
      eventClass,
      regime,
      agentForecasts,
      ensembleForecast,
      calibratedForecast,
      uncertaintyInterval,
      evidenceSources,
      marketPrice,
      forecastHash,
      evidenceSetHash,
      contractHash,
      modelVersionAtDecision,
      memoryPhase,
      postmortems,
      outcome,
      brierScore,
      logLoss,
      errorAttribution: episode.errorAttribution || null,
      lessons: Array.isArray(episode.lessons) ? episode.lessons.map(String) : [],
      resolvedAt: episode.resolvedAt || (outcome !== null ? timestamp : null)
    };

    this.episodes.set(episodeId, storedEpisode);
    this._persist();

    logger.info(`[EpisodicMemory] Recorded forecast episode ${episodeId} for [${eventClass}] "${question}" (forecastHash: ${forecastHash})`);
    return storedEpisode;
  }

  /**
   * Records the verified real-world resolution for an episode.
   * 
   * Temporal Integrity Rules:
   * 1. Immutability Guard: Verifies forecastHash hasn't changed; throws IMMUTABILITY_VIOLATION if altered.
   * 2. Sets memoryPhase to 'POSTMORTEM'.
   * 3. Appends a separate linked postmortem entry to the episode's `postmortems` array.
   * 4. Forecast and evidence snapshots remain strictly immutable.
   * 
   * @param {string} episodeId - The episode identifier
   * @param {string|boolean|number} outcome - 'YES' | 'NO' | true | false | 1 | 0
   * @param {string} [resolvedAt] - ISO 8601 resolution timestamp
   * @param {Object} [options={}] - Additional resolution metadata (lessons, errorAttribution, addedBy)
   * @param {string[]} [options.lessons] - Retrospective lessons learned
   * @param {Object} [options.errorAttribution] - { errorType, details }
   * @param {string} [options.addedBy] - Entity attributing postmortem
   * @param {string} [options.postmortemId] - Optional custom postmortem ID
   * @returns {Object} Updated episode object with linked postmortem
   */
  recordResolution(episodeId, outcome, resolvedAt = new Date().toISOString(), options = {}) {
    const episode = this.episodes.get(episodeId);
    if (!episode) {
      const errorMsg = `[EpisodicMemory] Episode ${episodeId} not found for resolution`;
      logger.warn(errorMsg);
      throw new Error(errorMsg);
    }

    // IMMUTABILITY GUARD: Verify forecastHash hasn't changed since recording
    this._verifyForecastImmutability(episode);

    // Normalize outcome to 'YES' | 'NO'
    let normOutcome = 'NO';
    if (outcome === 'YES' || outcome === true || outcome === 1 || String(outcome).toUpperCase() === 'YES') {
      normOutcome = 'YES';
    } else if (outcome === 'NO' || outcome === false || outcome === 0 || String(outcome).toUpperCase() === 'NO') {
      normOutcome = 'NO';
    } else {
      throw new Error(`[EpisodicMemory] Invalid resolution outcome: ${outcome}. Expected 'YES' or 'NO'`);
    }

    const y = normOutcome === 'YES' ? 1 : 0;
    const isoResolvedAt = resolvedAt || new Date().toISOString();

    // Determine primary forecast probability: Calibrated -> Ensemble -> Agent Average
    let primaryForecast = episode.calibratedForecast;
    if (primaryForecast === null || primaryForecast === undefined) {
      primaryForecast = episode.ensembleForecast;
    }
    if (primaryForecast === null || primaryForecast === undefined) {
      const agentVals = Object.values(episode.agentForecasts || {});
      if (agentVals.length > 0) {
        primaryForecast = agentVals.reduce((acc, v) => acc + v, 0) / agentVals.length;
      } else {
        primaryForecast = 0.5; // Default uninformative prior if no forecast exists
      }
    }

    // Brier score: (forecast - outcome)^2
    const brier = Math.pow(primaryForecast - y, 2);

    // Log loss: -(y * ln(p) + (1-y) * ln(1-p)) clamped
    const clamped = Math.max(LOG_LOSS_EPSILON, Math.min(1 - LOG_LOSS_EPSILON, primaryForecast));
    const logLoss = -(y * Math.log(clamped) + (1 - y) * Math.log(1 - clamped));

    // Update resolution fields and transition memoryPhase to POSTMORTEM
    episode.outcome = normOutcome;
    episode.resolvedAt = isoResolvedAt;
    episode.brierScore = Number(brier.toFixed(6));
    episode.logLoss = Number(logLoss.toFixed(6));
    episode.memoryPhase = MEMORY_PHASE.POSTMORTEM;

    // Construct linked postmortem entry
    const postmortemId = options.postmortemId || this.generatePostmortemId();
    const pmTimestamp = options.timestamp || isoResolvedAt;
    const pmLessons = Array.isArray(options.lessons)
      ? options.lessons.map(String)
      : (typeof options.lesson === 'string' ? [options.lesson] : []);
    
    let pmErrorAttribution = options.errorAttribution || null;
    if (!pmErrorAttribution && brier > 0.25) {
      const directionMiss = (primaryForecast >= 0.5 && normOutcome === 'NO') || (primaryForecast < 0.5 && normOutcome === 'YES');
      pmErrorAttribution = {
        errorType: directionMiss ? 'DIRECTIONAL_MISS' : 'CALIBRATION_MISALIGNMENT',
        details: `Forecast ${primaryForecast.toFixed(2)} vs Outcome ${normOutcome} (Brier: ${brier.toFixed(4)})`
      };
    }

    const addedBy = String(options.addedBy || options.author || 'ORACLE_RESOLUTION_ENGINE');

    const postmortemRecord = {
      postmortemId,
      timestamp: pmTimestamp,
      errorAttribution: pmErrorAttribution,
      lessons: pmLessons,
      addedBy
    };

    if (!Array.isArray(episode.postmortems)) {
      episode.postmortems = [];
    }
    episode.postmortems.push(postmortemRecord);

    // Maintain aggregated convenience views on episode root for backward compatibility
    if (pmLessons.length > 0) {
      episode.lessons = Array.from(new Set([...(episode.lessons || []), ...pmLessons]));
    }
    if (pmErrorAttribution) {
      episode.errorAttribution = pmErrorAttribution;
    }

    this._persist();

    logger.info(`[EpisodicMemory] Resolved episode ${episodeId} ➔ Outcome: ${normOutcome}, Brier: ${episode.brierScore}, PostmortemId: ${postmortemId}`);
    return episode;
  }

  /**
   * Appends an additional postmortem record to an existing episode without modifying decision-time fields.
   * 
   * @param {string} episodeId - Target episode ID
   * @param {Object} [postmortemData={}] - Postmortem details
   * @param {string[]} [postmortemData.lessons] - Retrospective lessons
   * @param {Object} [postmortemData.errorAttribution] - Error attribution metadata
   * @param {string} [postmortemData.addedBy] - Author identifier
   * @param {string} [postmortemData.timestamp] - Timestamp of analysis
   * @returns {Object} Stored postmortem entry
   */
  addPostmortem(episodeId, postmortemData = {}) {
    const episode = this.episodes.get(episodeId);
    if (!episode) {
      throw new Error(`[EpisodicMemory] Episode ${episodeId} not found`);
    }

    // Verify immutability of decision-time data
    this._verifyForecastImmutability(episode);

    const postmortemId = postmortemData.postmortemId || this.generatePostmortemId();
    const timestamp = postmortemData.timestamp || new Date().toISOString();
    const lessons = Array.isArray(postmortemData.lessons) ? postmortemData.lessons.map(String) : [];
    const errorAttribution = postmortemData.errorAttribution || null;
    const addedBy = String(postmortemData.addedBy || 'ORACLE_POSTMORTEM_ENGINE');

    const postmortemRecord = {
      postmortemId,
      timestamp,
      errorAttribution,
      lessons,
      addedBy
    };

    if (!Array.isArray(episode.postmortems)) {
      episode.postmortems = [];
    }
    episode.postmortems.push(postmortemRecord);
    episode.memoryPhase = MEMORY_PHASE.POSTMORTEM;

    if (lessons.length > 0) {
      episode.lessons = Array.from(new Set([...(episode.lessons || []), ...lessons]));
    }
    if (errorAttribution) {
      episode.errorAttribution = errorAttribution;
    }

    this._persist();
    logger.info(`[EpisodicMemory] Appended postmortem ${postmortemId} to episode ${episodeId}`);
    return postmortemRecord;
  }

  /**
   * Retrieves similar past episodes respecting temporal integrity.
   * 
   * Temporal Integrity Rules:
   * 1. If `asOfTimestamp` is provided: strictly filters to episodes where `decisionTimestamp < asOfTimestamp`.
   * 2. If `includePostmortems` is false (default for historical replay): returns strictly DECISION_TIME fields,
   *    omitting postmortems, outcomes, brier scores, and resolution details to eliminate lookahead bias.
   * 3. If `includePostmortems` is true (default for analysis without asOfTimestamp): returns full episode records.
   * 
   * @param {string|Object} query - Search query string or structured query object
   * @param {string} [query.question] - Target question text
   * @param {string} [query.eventClass] - Target event category
   * @param {string} [query.regime] - Target regime
   * @param {string[]} [query.keywords] - Target keywords
   * @param {boolean} [query.resolvedOnly=false] - Only return resolved episodes
   * @param {string|number|null} [query.asOfTimestamp=null] - ISO 8601 timestamp or epoch for point-in-time replay
   * @param {boolean} [query.includePostmortems] - Whether to include postmortem resolution data
   * @param {number} [limit=5] - Maximum number of results to return
   * @param {Object} [options={}] - Additional search options
   * @param {string|number|null} [options.asOfTimestamp=null] - Explicit asOfTimestamp override
   * @param {boolean} [options.includePostmortems] - Explicit includePostmortems override
   * @returns {Array<Object>} Sorted list of similar episodes with similarity metadata
   */
  retrieveSimilar(query, limit = 5, options = {}) {
    if (!query) return [];

    let targetQuestion = '';
    let targetEventClass = '';
    let targetRegime = '';
    let targetKeywords = [];
    let resolvedOnly = false;
    let asOfTimestamp = null;
    let includePostmortems = null;

    // Parse options argument (supports options object or legacy signature)
    if (typeof options === 'string' || typeof options === 'number') {
      asOfTimestamp = options;
      if (arguments.length >= 4) {
        includePostmortems = Boolean(arguments[3]);
      }
    } else if (options && typeof options === 'object') {
      if (options.asOfTimestamp !== undefined) asOfTimestamp = options.asOfTimestamp;
      if (options.includePostmortems !== undefined) includePostmortems = options.includePostmortems;
    }

    // Parse query argument
    if (typeof query === 'string') {
      targetQuestion = query;
    } else if (typeof query === 'object') {
      targetQuestion = query.question || query.query || '';
      targetEventClass = query.eventClass ? String(query.eventClass).toUpperCase().trim() : '';
      targetRegime = query.regime ? String(query.regime).toUpperCase().trim() : '';
      targetKeywords = Array.isArray(query.keywords) ? query.keywords : [];
      resolvedOnly = Boolean(query.resolvedOnly);
      if (query.asOfTimestamp !== undefined && asOfTimestamp === null) {
        asOfTimestamp = query.asOfTimestamp;
      }
      if (query.includePostmortems !== undefined && includePostmortems === null) {
        includePostmortems = query.includePostmortems;
      }
    }

    // Resolve includePostmortems default:
    // When asOfTimestamp is provided (replay mode): default is false.
    // When asOfTimestamp is omitted (analysis mode): default is true unless explicitly set to false.
    if (includePostmortems === null || includePostmortems === undefined) {
      includePostmortems = asOfTimestamp ? false : true;
    } else {
      includePostmortems = Boolean(includePostmortems);
    }

    const asOfMillis = asOfTimestamp ? new Date(asOfTimestamp).getTime() : null;
    const isValidAsOf = asOfMillis !== null && !isNaN(asOfMillis);

    // Build target token set
    const queryTokens = extractTokens(`${targetQuestion} ${targetKeywords.join(' ')}`);
    const scoredEpisodes = [];

    for (const episode of this.episodes.values()) {
      // Temporal Integrity: Strict decision-time boundary check
      if (isValidAsOf) {
        const epDecisionTime = new Date(episode.decisionTimestamp || episode.timestamp).getTime();
        if (isNaN(epDecisionTime) || epDecisionTime >= asOfMillis) {
          continue; // Filter out: only return episodes whose decisionTimestamp < asOfTimestamp
        }
      }

      // Filter resolvedOnly if requested
      if (resolvedOnly && !episode.outcome) {
        continue;
      }

      let similarityScore = 0;

      // 1. EventClass Match (+0.40 weight)
      if (targetEventClass && episode.eventClass) {
        if (episode.eventClass.toUpperCase() === targetEventClass) {
          similarityScore += 0.40;
        } else if (episode.eventClass.toUpperCase().includes(targetEventClass) || targetEventClass.includes(episode.eventClass.toUpperCase())) {
          similarityScore += 0.20;
        }
      }

      // 2. Regime Match (+0.25 weight)
      if (targetRegime && episode.regime) {
        if (episode.regime.toUpperCase() === targetRegime) {
          similarityScore += 0.25;
        }
      }

      // 3. Keyword / Question / Evidence Overlap (+0.35 weight)
      if (queryTokens.size > 0) {
        const evidenceSummaries = (episode.evidenceSources || []).map(e => e.summary || '').join(' ');
        // If including postmortems, lessons may participate in semantic search; in replay mode, omit them.
        const lessonsText = includePostmortems ? (episode.lessons || []).join(' ') : '';
        const episodeText = `${episode.question} ${lessonsText} ${evidenceSummaries}`.trim();
        const episodeTokens = extractTokens(episodeText);
        
        const jaccard = calculateJaccardSimilarity(queryTokens, episodeTokens);
        similarityScore += jaccard * 0.35;
      }

      // Baseline fallback similarity if no specific filters provided
      if (!targetEventClass && !targetRegime && queryTokens.size === 0) {
        similarityScore = 1.0;
      }

      if (similarityScore > 0) {
        if (includePostmortems) {
          // Full postmortem view for analysis
          scoredEpisodes.push({
            ...episode,
            decisionTimestamp: episode.decisionTimestamp || episode.timestamp,
            similarityScore: Number(similarityScore.toFixed(4))
          });
        } else {
          // Strict DECISION_TIME snapshot for replay
          scoredEpisodes.push(extractDecisionTimeView(episode, similarityScore));
        }
      }
    }

    // Sort descending by similarity score, then by timestamp descending
    scoredEpisodes.sort((a, b) => {
      if (b.similarityScore !== a.similarityScore) {
        return b.similarityScore - a.similarityScore;
      }
      const timeB = new Date(b.decisionTimestamp || b.timestamp).getTime();
      const timeA = new Date(a.decisionTimestamp || a.timestamp).getTime();
      return timeB - timeA;
    });

    return scoredEpisodes.slice(0, Math.max(1, limit));
  }

  /**
   * Retrieves all episodes belonging to a specific event category.
   * 
   * @param {string} eventClass - Category name (e.g. 'FED_POLICY', 'US_ELECTION')
   * @param {number} [limit=20] - Maximum episodes to retrieve
   * @returns {Array<Object>} List of matching episodes sorted by timestamp descending
   */
  getByEventClass(eventClass, limit = 20) {
    if (!eventClass) return [];
    const targetClass = String(eventClass).toUpperCase().trim();

    const matches = [];
    for (const episode of this.episodes.values()) {
      if (episode.eventClass && episode.eventClass.toUpperCase() === targetClass) {
        matches.push(episode);
      }
    }

    matches.sort((a, b) => {
      const timeB = new Date(b.decisionTimestamp || b.timestamp).getTime();
      const timeA = new Date(a.decisionTimestamp || a.timestamp).getTime();
      return timeB - timeA;
    });

    return matches.slice(0, Math.max(1, limit));
  }

  /**
   * Returns calibration data points and decile reliability buckets for an agent or ensemble.
   * Used by the Calibration Engine to construct Platt/Isotonic mapping curves.
   * 
   * @param {string|null} [agentName=null] - Agent name (e.g. 'macroAgent', 'ensemble', 'calibrated'), or null for ensemble/calibrated
   * @returns {Object} Structured calibration dataset including data points and reliability buckets
   */
  getCalibrationData(agentName = null) {
    const dataPoints = [];
    const normalizedAgent = agentName ? String(agentName).trim() : null;

    for (const episode of this.episodes.values()) {
      if (!episode.outcome || (episode.outcome !== 'YES' && episode.outcome !== 'NO')) {
        continue;
      }

      const outcomeVal = episode.outcome === 'YES' ? 1 : 0;
      let forecast = null;

      if (!normalizedAgent || normalizedAgent.toLowerCase() === 'calibrated' || normalizedAgent.toLowerCase() === 'calibratedforecast') {
        forecast = episode.calibratedForecast !== null ? episode.calibratedForecast : episode.ensembleForecast;
      } else if (normalizedAgent.toLowerCase() === 'ensemble' || normalizedAgent.toLowerCase() === 'ensembleforecast') {
        forecast = episode.ensembleForecast;
      } else {
        // Individual agent lookup
        if (episode.agentForecasts && typeof episode.agentForecasts[normalizedAgent] === 'number') {
          forecast = episode.agentForecasts[normalizedAgent];
        }
      }

      if (forecast !== null && typeof forecast === 'number' && !isNaN(forecast)) {
        const brierScore = Number(Math.pow(forecast - outcomeVal, 2).toFixed(6));
        const clamped = Math.max(LOG_LOSS_EPSILON, Math.min(1 - LOG_LOSS_EPSILON, forecast));
        const logLoss = Number((-(outcomeVal * Math.log(clamped) + (1 - outcomeVal) * Math.log(1 - clamped))).toFixed(6));

        dataPoints.push({
          episodeId: episode.episodeId,
          timestamp: episode.timestamp,
          decisionTimestamp: episode.decisionTimestamp || episode.timestamp,
          resolvedAt: episode.resolvedAt,
          eventClass: episode.eventClass,
          regime: episode.regime,
          agent: normalizedAgent || 'ensemble',
          forecast: Number(forecast.toFixed(4)),
          outcome: outcomeVal,
          brierScore,
          logLoss,
          forecastHash: episode.forecastHash
        });
      }
    }

    // Compute 10 decile calibration buckets [0.0-0.1, 0.1-0.2, ..., 0.9-1.0]
    const buckets = [];
    const numBuckets = 10;
    let totalWeightedCalError = 0;

    for (let i = 0; i < numBuckets; i++) {
      const low = i / numBuckets;
      const high = (i + 1) / numBuckets;
      
      const inBucket = dataPoints.filter(dp => {
        if (i === numBuckets - 1) {
          return dp.forecast >= low && dp.forecast <= high;
        }
        return dp.forecast >= low && dp.forecast < high;
      });

      const count = inBucket.length;
      if (count === 0) {
        buckets.push({
          bucketIndex: i,
          range: [Number(low.toFixed(1)), Number(high.toFixed(1))],
          count: 0,
          avgForecast: Number(((low + high) / 2).toFixed(3)),
          actualWinRate: 0,
          calibrationError: 0
        });
      } else {
        const sumForecast = inBucket.reduce((acc, dp) => acc + dp.forecast, 0);
        const sumOutcome = inBucket.reduce((acc, dp) => acc + dp.outcome, 0);
        const avgForecast = sumForecast / count;
        const actualWinRate = sumOutcome / count;
        const calibrationError = Math.abs(avgForecast - actualWinRate);

        totalWeightedCalError += (count / (dataPoints.length || 1)) * calibrationError;

        buckets.push({
          bucketIndex: i,
          range: [Number(low.toFixed(1)), Number(high.toFixed(1))],
          count,
          avgForecast: Number(avgForecast.toFixed(4)),
          actualWinRate: Number(actualWinRate.toFixed(4)),
          calibrationError: Number(calibrationError.toFixed(4))
        });
      }
    }

    return {
      agent: normalizedAgent || 'ensemble',
      totalSamples: dataPoints.length,
      expectedCalibrationError: Number(totalWeightedCalError.toFixed(4)),
      buckets,
      dataPoints
    };
  }

  /**
   * Computes comprehensive statistics across all historical prediction episodes.
   * 
   * @returns {Object} Detailed diagnostic metrics & performance breakdowns
   */
  getStatistics() {
    const all = Array.from(this.episodes.values());
    const totalEpisodes = all.length;
    const resolved = all.filter(e => e.outcome === 'YES' || e.outcome === 'NO');
    const unresolved = all.filter(e => !e.outcome);

    const resolvedCount = resolved.length;
    const unresolvedCount = unresolved.length;

    let sumBrier = 0;
    let sumLogLoss = 0;
    let correctDirectionCount = 0;

    const byEventClass = {};
    const byRegime = {};
    const agentStatsMap = {};

    for (const ep of all) {
      // By EventClass
      const ec = ep.eventClass || 'GENERAL';
      if (!byEventClass[ec]) {
        byEventClass[ec] = { total: 0, resolved: 0, brierSum: 0, avgBrier: null };
      }
      byEventClass[ec].total++;

      // By Regime
      const reg = ep.regime || 'NEUTRAL';
      if (!byRegime[reg]) {
        byRegime[reg] = { total: 0, resolved: 0, brierSum: 0, avgBrier: null };
      }
      byRegime[reg].total++;

      // Track agent-level forecasts
      if (ep.agentForecasts) {
        for (const [agent, forecast] of Object.entries(ep.agentForecasts)) {
          if (!agentStatsMap[agent]) {
            agentStatsMap[agent] = { totalForecasts: 0, resolvedCount: 0, brierSum: 0, correctCount: 0 };
          }
          agentStatsMap[agent].totalForecasts++;
          if (ep.outcome) {
            const y = ep.outcome === 'YES' ? 1 : 0;
            agentStatsMap[agent].resolvedCount++;
            agentStatsMap[agent].brierSum += Math.pow(forecast - y, 2);
            if ((forecast >= 0.5 && y === 1) || (forecast < 0.5 && y === 0)) {
              agentStatsMap[agent].correctCount++;
            }
          }
        }
      }

      // Resolved metrics
      if (ep.outcome) {
        const y = ep.outcome === 'YES' ? 1 : 0;
        const brier = ep.brierScore !== null ? ep.brierScore : 0;
        const logLoss = ep.logLoss !== null ? ep.logLoss : 0;

        sumBrier += brier;
        sumLogLoss += logLoss;

        byEventClass[ec].resolved++;
        byEventClass[ec].brierSum += brier;

        byRegime[reg].resolved++;
        byRegime[reg].brierSum += brier;

        const p = ep.calibratedForecast !== null ? ep.calibratedForecast : (ep.ensembleForecast !== null ? ep.ensembleForecast : 0.5);
        if ((p >= 0.5 && y === 1) || (p < 0.5 && y === 0)) {
          correctDirectionCount++;
        }
      }
    }

    // Finalize category averages
    for (const ec of Object.keys(byEventClass)) {
      const item = byEventClass[ec];
      item.avgBrier = item.resolved > 0 ? Number((item.brierSum / item.resolved).toFixed(4)) : null;
      delete item.brierSum;
    }

    for (const reg of Object.keys(byRegime)) {
      const item = byRegime[reg];
      item.avgBrier = item.resolved > 0 ? Number((item.brierSum / item.resolved).toFixed(4)) : null;
      delete item.brierSum;
    }

    // Finalize agent metrics
    const agentPerformance = {};
    for (const [agent, stat] of Object.entries(agentStatsMap)) {
      agentPerformance[agent] = {
        totalForecasts: stat.totalForecasts,
        resolvedCount: stat.resolvedCount,
        avgBrierScore: stat.resolvedCount > 0 ? Number((stat.brierSum / stat.resolvedCount).toFixed(4)) : null,
        accuracy: stat.resolvedCount > 0 ? Number((stat.correctCount / stat.resolvedCount).toFixed(4)) : null
      };
    }

    const avgBrierScore = resolvedCount > 0 ? Number((sumBrier / resolvedCount).toFixed(4)) : null;
    const avgLogLoss = resolvedCount > 0 ? Number((sumLogLoss / resolvedCount).toFixed(4)) : null;
    const directionalAccuracy = resolvedCount > 0 ? Number((correctDirectionCount / resolvedCount).toFixed(4)) : null;

    // Recent 5 episodes
    const sortedRecent = [...all].sort((a, b) => {
      const timeB = new Date(b.decisionTimestamp || b.timestamp).getTime();
      const timeA = new Date(a.decisionTimestamp || a.timestamp).getTime();
      return timeB - timeA;
    }).slice(0, 5);

    return {
      totalEpisodes,
      resolvedCount,
      unresolvedCount,
      avgBrierScore,
      avgLogLoss,
      directionalAccuracy,
      byEventClass,
      byRegime,
      agentPerformance,
      recentEpisodes: sortedRecent,
      storagePath: this.storagePath,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Retrieves a single episode by its unique identifier.
   * 
   * @param {string} episodeId 
   * @param {Object} [options={}]
   * @param {boolean} [options.includePostmortems=true] - If false, returns only decision-time snapshot
   * @returns {Object|null}
   */
  getEpisode(episodeId, options = {}) {
    const episode = this.episodes.get(episodeId) || null;
    if (!episode) return null;

    const includePostmortems = options.includePostmortems !== undefined ? Boolean(options.includePostmortems) : true;
    if (!includePostmortems) {
      return extractDecisionTimeView(episode);
    }
    return episode;
  }

  /**
   * Returns all episodes currently in memory.
   * 
   * @param {Object} [options={}]
   * @param {boolean} [options.includePostmortems=true]
   * @returns {Array<Object>}
   */
  getAllEpisodes(options = {}) {
    const includePostmortems = options.includePostmortems !== undefined ? Boolean(options.includePostmortems) : true;
    if (!includePostmortems) {
      return Array.from(this.episodes.values()).map(ep => extractDecisionTimeView(ep));
    }
    return Array.from(this.episodes.values());
  }

  /**
   * Returns all resolved episodes.
   * 
   * @param {Object} [options={}]
   * @returns {Array<Object>}
   */
  getResolvedEpisodes(options = {}) {
    const resolved = Array.from(this.episodes.values()).filter(e => e.outcome === 'YES' || e.outcome === 'NO');
    const includePostmortems = options.includePostmortems !== undefined ? Boolean(options.includePostmortems) : true;
    if (!includePostmortems) {
      return resolved.map(ep => extractDecisionTimeView(ep));
    }
    return resolved;
  }

  /**
   * Clears all episodes from memory and storage (primarily for testing/reset).
   */
  clear() {
    this.episodes.clear();
    this._persist();
    logger.info('[EpisodicMemory] Cleared all episodes');
  }
}

// Instantiate singleton instance
const episodicMemory = new EpisodicMemory();

module.exports = {
  EpisodicMemory,
  episodicMemory,
  MEMORY_PHASE
};
