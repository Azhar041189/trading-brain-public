/**
 * 🏛️ AgentReputationEngine (ORACLE Intelligence Layer)
 * 
 * Domain-Specific Agent Skill Scoring & Dynamic Routing Engine.
 * Evaluates probabilistic forecasting competence per (agentName, eventClass) tuple
 * using strictly proper scoring rules (Brier Skill Score, Log Loss Skill) and
 * statistical calibration (ECE), with Empirical Bayes skill shrinkage and conservative
 * lower confidence bound Bayesian routing to historical specialists.
 * 
 * ══════════════════════════════════════════════════════════════════════════════
 * ORACLE GOVERNANCE COMPLIANCE CONTRACT:
 * - Observes, scores, learns, and proposes domain-specialist routing.
 * - STRICTLY PROHIBITED from directly executing orders, altering live risk caps,
 *   or modifying historical trade/execution records.
 * ══════════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('AgentReputationEngine');

/**
 * ORACLE Governance Policy
 */
const GOVERNANCE_POLICY = Object.freeze({
  ROLE: 'OBSERVE_SCORE_LEARN_PROPOSE',
  ALLOW_EXECUTION_MUTATION: false,
  ALLOW_RISK_OVERRIDE: false,
  ALLOW_RECORD_TAMPERING: false
});

/**
 * Standard Domain Event Classes
 */
const EVENT_CLASSES = Object.freeze([
  'FED_POLICY',
  'US_ELECTION',
  'CRYPTO_POLICY',
  'GEOPOLITICS',
  'ECONOMICS',
  'SPORTS',
  'CULTURE',
  'WEATHER',
  'TECH'
]);

/**
 * Standard Oracle Agents
 */
const AGENT_NAMES = Object.freeze([
  'MacroAgent',
  'PoliticalAgent',
  'CryptoAgent',
  'WorldIntelAgent',
  'LogicAgent',
  'RatesAgent',
  'NewsAgent'
]);

/**
 * Relevance Tiers for Routing
 */
const RELEVANCE_TIERS = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  SKIP: 'SKIP'
});

/**
 * Default uninformative baseline Brier score when market price is not provided.
 * For random guess p=0.5 against binary outcome {0, 1}: (0.5 - 1)^2 = (0.5 - 0)^2 = 0.25
 */
const DEFAULT_BASELINE_BRIER = 0.25;

/**
 * High confidence thresholds for False Catalyst Rate detection.
 * Forecasts with p >= 0.70 or p <= 0.30 represent strong directional stances.
 */
const HIGH_CONF_UPPER = 0.70;
const HIGH_CONF_LOWER = 0.30;

/**
 * Number of bins for Expected Calibration Error (ECE)
 */
const ECE_BINS_COUNT = 10;

/**
 * Log-loss clipping epsilon to prevent log(0)
 */
const EPSILON = 1e-5;

/**
 * Empirical Bayes Shrinkage Default Parameters
 */
const DEFAULT_NEUTRAL_PRIOR = 0.0;
const DEFAULT_PRIOR_WEIGHT = 20;
const DEFAULT_SKILL_VARIANCE = 0.25;

/**
 * Canonical Domain Specialist Priors (Cold-Start fallback before empirical observations)
 */
const CANONICAL_SPECIALISTS = Object.freeze({
  FED_POLICY: ['RatesAgent', 'MacroAgent'],
  US_ELECTION: ['PoliticalAgent', 'WorldIntelAgent'],
  CRYPTO_POLICY: ['CryptoAgent', 'NewsAgent'],
  GEOPOLITICS: ['WorldIntelAgent', 'PoliticalAgent'],
  ECONOMICS: ['MacroAgent', 'RatesAgent'],
  SPORTS: ['NewsAgent', 'LogicAgent'],
  CULTURE: ['NewsAgent', 'WorldIntelAgent'],
  WEATHER: ['WorldIntelAgent', 'NewsAgent'],
  TECH: ['CryptoAgent', 'NewsAgent']
});

/**
 * Domain keyword mapping for heuristic event class extraction
 */
const DOMAIN_KEYWORD_RULES = [
  {
    eventClass: 'FED_POLICY',
    regex: /\b(fed|fomc|powell|rate cut|rate hike|interest rate|basis points|bps|federal reserve|quantitative tightening|qt|qe|funds rate|terminal rate|dot plot)\b/i
  },
  {
    eventClass: 'US_ELECTION',
    regex: /\b(election|presidential|trump|biden|harris|democrat|republican|senate|house of rep|congress|electoral|governor|ballot|primary election|white house)\b/i
  },
  {
    eventClass: 'CRYPTO_POLICY',
    regex: /\b(crypto|bitcoin|btc|ethereum|eth|sec vs|cftc|stablecoin|etf approval|gensler|token|defi|solana|binance|coinbase|crypto regulation)\b/i
  },
  {
    eventClass: 'GEOPOLITICS',
    regex: /\b(geopolitics|taiwan|ukraine|russia|china|iran|israel|middle east|nato|sanction|tariff|trade war|ceasefire|treaty|missile|strait of hormuz|sovereignty)\b/i
  },
  {
    eventClass: 'ECONOMICS',
    regex: /\b(cpi|inflation|gdp|nfp|nonfarm payroll|unemployment|jobless claims|recession|yield curve|treasury|pmi|retail sales|debt ceiling|macroeconomic)\b/i
  },
  {
    eventClass: 'SPORTS',
    regex: /\b(nfl|nba|super bowl|championship|world cup|premier league|fifa|olympics|tournament|ufc|tennis|grand slam|mvp|playoffs|score|match)\b/i
  },
  {
    eventClass: 'CULTURE',
    regex: /\b(oscar|grammy|box office|movie|billboard|celebrity|hollywood|emmy|entertainment|music|album|streaming records|met gala)\b/i
  },
  {
    eventClass: 'WEATHER',
    regex: /\b(hurricane|temperature|rainfall|storm|noaa|weather|climate|wildfire|flood|tornado|heatwave|el nino|la nina|precipitation)\b/i
  },
  {
    eventClass: 'TECH',
    regex: /\b(nvidia|openai|apple|microsoft|google|meta|semiconductor|ai|artificial intelligence|gpu|tsmc|chip|llm|anthropic|chatgpt|quantum)\b/i
  }
];

class AgentReputationEngine {
  /**
   * @param {Object} [options]
   * @param {string} [options.jsonPath] - Absolute path to JSON reputation persistence file
   * @param {string} [options.dbPath] - Absolute path to SQLite database file
   * @param {boolean} [options.disableSqlite=false] - Force JSON-only persistence mode
   */
  constructor(options = {}) {
    this.governancePolicy = GOVERNANCE_POLICY;

    // Persistence file paths
    this.jsonPath = options.jsonPath || path.join(process.cwd(), 'data', 'oracle', 'agent_reputation.json');
    this.dbPath = options.dbPath || path.join(process.cwd(), 'data', 'oracle', 'agent_reputation.db');
    this.disableSqlite = options.disableSqlite || false;

    // In-memory observation store: Map<"agentName:eventClass", Observation[]>
    this.observations = new Map();

    // In-memory score cache: Map<"agentName:eventClass", ScoreObject>
    this.reputations = new Map();

    // Persistence state
    this.persistenceMode = 'MEMORY_ONLY';
    this.db = null;

    // Initialize storage and load existing state
    this._initPersistence();
  }

  /**
   * Build composite lookup key
   * @param {string} agentName 
   * @param {string} eventClass 
   * @returns {string}
   */
  _getKey(agentName, eventClass) {
    const normAgent = this._normalizeAgentName(agentName);
    const normClass = this._normalizeEventClass(eventClass);
    return `${normAgent}:${normClass}`;
  }

  /**
   * Normalize agent name against canonical registry
   * @param {string} name 
   * @returns {string}
   */
  _normalizeAgentName(name) {
    if (!name || typeof name !== 'string') return 'LogicAgent';
    const clean = name.trim();
    const matched = AGENT_NAMES.find(a => a.toLowerCase() === clean.toLowerCase());
    return matched || clean;
  }

  /**
   * Normalize event class against canonical registry or aliases
   * @param {string} eventClass 
   * @returns {string}
   */
  _normalizeEventClass(eventClass) {
    if (!eventClass || typeof eventClass !== 'string') return 'ECONOMICS';
    const clean = eventClass.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (EVENT_CLASSES.includes(clean)) return clean;

    const aliases = {
      'FED': 'FED_POLICY',
      'RATES': 'FED_POLICY',
      'RATE_DECISION': 'FED_POLICY',
      'ELECTION': 'US_ELECTION',
      'ELECTIONS': 'US_ELECTION',
      'POLITICS': 'US_ELECTION',
      'POLITICAL': 'US_ELECTION',
      'CRYPTO': 'CRYPTO_POLICY',
      'BITCOIN': 'CRYPTO_POLICY',
      'ETHEREUM': 'CRYPTO_POLICY',
      'DEFI': 'CRYPTO_POLICY',
      'GEOPOLITICAL': 'GEOPOLITICS',
      'WAR': 'GEOPOLITICS',
      'CONFLICT': 'GEOPOLITICS',
      'DIPLOMACY': 'GEOPOLITICS',
      'MACRO': 'ECONOMICS',
      'ECONOMY': 'ECONOMICS',
      'INFLATION': 'ECONOMICS',
      'CPI': 'ECONOMICS',
      'JOBS': 'ECONOMICS',
      'NFP': 'ECONOMICS',
      'CLIMATE': 'WEATHER',
      'HURRICANE': 'WEATHER',
      'TECHNOLOGY': 'TECH',
      'AI': 'TECH',
      'SEMICONDUCTOR': 'TECH',
      'ENTERTAINMENT': 'CULTURE',
      'MEDIA': 'CULTURE',
      'CELEBRITY': 'CULTURE'
    };

    return aliases[clean] || (EVENT_CLASSES.includes(clean) ? clean : 'ECONOMICS');
  }

  /**
   * Infer event class from raw question text or title
   * @param {string} text 
   * @returns {string}
   */
  inferEventClass(text) {
    if (!text || typeof text !== 'string') return 'ECONOMICS';
    const str = text.trim();

    for (const rule of DOMAIN_KEYWORD_RULES) {
      if (rule.regex.test(str)) {
        return rule.eventClass;
      }
    }

    return 'ECONOMICS';
  }

  /**
   * Initialize persistence (SQLite primary with automatic JSON mirroring, or JSON fallback)
   * @private
   */
  _initPersistence() {
    try {
      const jsonDir = path.dirname(this.jsonPath);
      if (!fs.existsSync(jsonDir)) {
        fs.mkdirSync(jsonDir, { recursive: true });
      }

      if (!this.disableSqlite) {
        try {
          const Database = require('better-sqlite3');
          const dbDir = path.dirname(this.dbPath);
          if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
          }
          this.db = new Database(this.dbPath);
          this._initSqliteTables();
          this.persistenceMode = 'SQLITE_PRIMARY';
          this._loadFromStorage();
          logger.info(`[AgentReputationEngine] Initialized with SQLite storage: ${this.dbPath}`);
          return;
        } catch (sqliteErr) {
          logger.warn(`[AgentReputationEngine] SQLite initialization failed (${sqliteErr.message}). Falling back to JSON storage.`);
        }
      }

      this.persistenceMode = 'JSON_FALLBACK';
      this._loadFromStorage();
      logger.info(`[AgentReputationEngine] Initialized with JSON storage: ${this.jsonPath}`);
    } catch (err) {
      this.persistenceMode = 'MEMORY_ONLY';
      logger.error(`[AgentReputationEngine] Persistence initialization failed: ${err.message}. Operating in MEMORY_ONLY mode.`);
    }
  }

  /**
   * Create SQLite schema if not exists and run migrations
   * @private
   */
  _initSqliteTables() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oracle_agent_forecasts (
        id TEXT PRIMARY KEY,
        agentName TEXT NOT NULL,
        eventClass TEXT NOT NULL,
        forecast REAL NOT NULL,
        outcome INTEGER NOT NULL,
        marketPrice REAL,
        leadTimeMs REAL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_event ON oracle_agent_forecasts(agentName, eventClass);

      CREATE TABLE IF NOT EXISTS oracle_agent_reputations (
        agentKey TEXT PRIMARY KEY,
        agentName TEXT NOT NULL,
        eventClass TEXT NOT NULL,
        rawBrierSkill REAL,
        effectiveBrierSkill REAL,
        skillLowerBound REAL,
        skillUpperBound REAL,
        effectiveSampleSize INTEGER,
        brierSkill REAL NOT NULL,
        logLossSkill REAL NOT NULL,
        calibrationError REAL NOT NULL,
        leadTime REAL NOT NULL,
        falseCatalystRate REAL NOT NULL,
        sampleSize INTEGER NOT NULL,
        relevanceTier TEXT NOT NULL,
        lastUpdated TEXT NOT NULL,
        metadataJson TEXT
      );
    `);

    // Dynamic non-destructive migrations for existing DB schemas
    try { this.db.exec(`ALTER TABLE oracle_agent_reputations ADD COLUMN rawBrierSkill REAL;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE oracle_agent_reputations ADD COLUMN effectiveBrierSkill REAL;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE oracle_agent_reputations ADD COLUMN skillLowerBound REAL;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE oracle_agent_reputations ADD COLUMN skillUpperBound REAL;`); } catch (_) {}
    try { this.db.exec(`ALTER TABLE oracle_agent_reputations ADD COLUMN effectiveSampleSize INTEGER;`); } catch (_) {}
  }

  /**
   * Load historical observations and reputations from storage
   * @private
   */
  _loadFromStorage() {
    // 1. Try SQLite if active
    if (this.persistenceMode === 'SQLITE_PRIMARY' && this.db) {
      try {
        const rows = this.db.prepare(`SELECT * FROM oracle_agent_forecasts ORDER BY timestamp ASC`).all();
        for (const row of rows) {
          const key = this._getKey(row.agentName, row.eventClass);
          if (!this.observations.has(key)) {
            this.observations.set(key, []);
          }
          this.observations.get(key).push({
            id: row.id,
            agentName: row.agentName,
            eventClass: row.eventClass,
            forecast: row.forecast,
            outcome: row.outcome,
            marketPrice: row.marketPrice,
            leadTimeMs: row.leadTimeMs,
            timestamp: row.timestamp
          });
        }

        // Recompute all reputation metrics from loaded observations
        this._recomputeAllReputations();

        // Also ensure JSON file is synced
        this._saveToJsonFile();
        return;
      } catch (err) {
        logger.warn(`[AgentReputationEngine] Failed to read from SQLite (${err.message}). Attempting JSON fallback.`);
      }
    }

    // 2. Try JSON file storage
    if (fs.existsSync(this.jsonPath)) {
      try {
        const raw = fs.readFileSync(this.jsonPath, 'utf8');
        if (raw && raw.trim().length > 0) {
          const data = JSON.parse(raw);
          if (Array.isArray(data.observations)) {
            for (const obs of data.observations) {
              const key = this._getKey(obs.agentName, obs.eventClass);
              if (!this.observations.has(key)) {
                this.observations.set(key, []);
              }
              this.observations.get(key).push(obs);
            }
          }
          this._recomputeAllReputations();
        }
      } catch (err) {
        logger.error(`[AgentReputationEngine] Failed to load JSON reputation file: ${err.message}`);
      }
    }
  }

  /**
   * Persist current state to active storage backends
   * @private
   */
  _persist() {
    this._saveToJsonFile();

    if (this.persistenceMode === 'SQLITE_PRIMARY' && this.db) {
      try {
        const insertRep = this.db.prepare(`
          INSERT OR REPLACE INTO oracle_agent_reputations 
          (agentKey, agentName, eventClass, rawBrierSkill, effectiveBrierSkill, skillLowerBound, skillUpperBound, effectiveSampleSize, brierSkill, logLossSkill, calibrationError, leadTime, falseCatalystRate, sampleSize, relevanceTier, lastUpdated, metadataJson)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const tx = this.db.transaction((reps) => {
          for (const rep of reps) {
            const key = this._getKey(rep.agentName, rep.eventClass);
            insertRep.run(
              key,
              rep.agentName,
              rep.eventClass,
              rep.rawBrierSkill !== undefined ? rep.rawBrierSkill : rep.brierSkill,
              rep.effectiveBrierSkill !== undefined ? rep.effectiveBrierSkill : rep.brierSkill,
              rep.skillLowerBound !== undefined ? rep.skillLowerBound : 0.0,
              rep.skillUpperBound !== undefined ? rep.skillUpperBound : 0.0,
              rep.effectiveSampleSize !== undefined ? rep.effectiveSampleSize : rep.sampleSize,
              rep.brierSkill,
              rep.logLossSkill,
              rep.calibrationError,
              rep.leadTime,
              rep.falseCatalystRate,
              rep.sampleSize,
              rep.relevanceTier,
              rep.lastUpdated,
              JSON.stringify(rep)
            );
          }
        });

        tx(Array.from(this.reputations.values()));
      } catch (err) {
        logger.error(`[AgentReputationEngine] SQLite reputation sync error: ${err.message}`);
      }
    }
  }

  /**
   * Save complete state snapshot to JSON file atomically
   * @private
   */
  _saveToJsonFile() {
    try {
      const allObservations = [];
      for (const obsList of this.observations.values()) {
        allObservations.push(...obsList);
      }

      const reputationsObj = {};
      for (const [key, rep] of this.reputations.entries()) {
        reputationsObj[key] = rep;
      }

      const payload = {
        schemaVersion: '2.0.0',
        governance: GOVERNANCE_POLICY,
        lastUpdated: new Date().toISOString(),
        totalObservations: allObservations.length,
        totalScoredTuples: this.reputations.size,
        reputations: reputationsObj,
        observations: allObservations
      };

      const tmpPath = `${this.jsonPath}.tmp_${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.jsonPath);
    } catch (err) {
      logger.error(`[AgentReputationEngine] Failed to write JSON file: ${err.message}`);
    }
  }

  /**
   * Empirical Bayes skill shrinkage estimator.
   * Shrinks noisy small-sample empirical skill scores toward a neutral prior.
   * 
   * Formula:
   * effectiveSkill = (sampleSize * rawSkill + priorWeight * neutralPrior) / (sampleSize + priorWeight)
   * 
   * @param {number} rawSkill - Empirical raw skill score (e.g. Brier Skill Score)
   * @param {number} sampleSize - Number of resolved forecast observations
   * @param {number} [neutralPrior=0.0] - Prior mean skill (0.0 for BSS, 0.5 for generic probability)
   * @param {number} [priorWeight=20] - Pseudo-observation weight representing prior confidence
   * @returns {number} Shrunk effective skill score
   */
  shrinkSkill(rawSkill, sampleSize, neutralPrior = DEFAULT_NEUTRAL_PRIOR, priorWeight = DEFAULT_PRIOR_WEIGHT) {
    const n = typeof sampleSize === 'number' && !isNaN(sampleSize) && sampleSize > 0 ? sampleSize : 0;
    const p = typeof neutralPrior === 'number' && !isNaN(neutralPrior) ? neutralPrior : DEFAULT_NEUTRAL_PRIOR;
    const s = typeof rawSkill === 'number' && !isNaN(rawSkill) ? rawSkill : p;
    const w = typeof priorWeight === 'number' && !isNaN(priorWeight) && priorWeight > 0 ? priorWeight : DEFAULT_PRIOR_WEIGHT;

    if (n === 0) return p;

    const effective = (n * s + w * p) / (n + w);
    return parseFloat(effective.toFixed(5));
  }

  /**
   * Compute conservative uncertainty confidence bounds around the shrunk skill score.
   * 
   * Formula:
   * skillMean = shrinkSkill(rawSkill, sampleSize, neutralPrior=0.0, priorWeight=20)
   * skillLowerBound = skillMean - z * sqrt(variance / effectiveSampleSize)
   * skillUpperBound = skillMean + z * sqrt(variance / effectiveSampleSize)
   * effectiveSampleSize = actual sample size
   * 
   * @param {number} rawSkill - Empirical raw skill score
   * @param {number} sampleSize - Actual sample size (effectiveSampleSize)
   * @param {number} [confidence=0.95] - Confidence level (default 0.95 -> z = 1.96)
   * @param {number} [variance=0.25] - Score variance (default 0.25 uninformative Bernoulli/Brier variance)
   * @returns {{ mean: number, lower: number, upper: number, skillMean: number, skillLowerBound: number, skillUpperBound: number }}
   */
  computeConfidenceBounds(rawSkill, sampleSize, confidence = 0.95, variance = DEFAULT_SKILL_VARIANCE) {
    const effectiveSampleSize = typeof sampleSize === 'number' && !isNaN(sampleSize) && sampleSize > 0 ? sampleSize : 0;

    if (effectiveSampleSize === 0) {
      return {
        mean: 0.0,
        lower: 0.0,
        upper: 0.0,
        skillMean: 0.0,
        skillLowerBound: 0.0,
        skillUpperBound: 0.0
      };
    }

    const mean = this.shrinkSkill(rawSkill, effectiveSampleSize, DEFAULT_NEUTRAL_PRIOR, DEFAULT_PRIOR_WEIGHT);

    // Determine critical z value
    let z = 1.96;
    if (typeof confidence === 'number') {
      if (confidence >= 0.99) z = 2.576;
      else if (confidence >= 0.98) z = 2.326;
      else if (confidence >= 0.95) z = 1.96;
      else if (confidence >= 0.90) z = 1.645;
      else if (confidence >= 0.80) z = 1.282;
    }

    const varValue = (typeof variance === 'number' && !isNaN(variance) && variance > 0) ? variance : DEFAULT_SKILL_VARIANCE;
    const stdError = Math.sqrt(varValue / effectiveSampleSize);
    const margin = z * stdError;

    const lower = mean - margin;
    const upper = mean + margin;

    const cleanMean = parseFloat(mean.toFixed(5));
    const cleanLower = parseFloat(lower.toFixed(5));
    const cleanUpper = parseFloat(upper.toFixed(5));

    return {
      mean: cleanMean,
      lower: cleanLower,
      upper: cleanUpper,
      skillMean: cleanMean,
      skillLowerBound: cleanLower,
      skillUpperBound: cleanUpper
    };
  }

  /**
   * Determine routing relevance tier based on Brier Skill Score and sample size
   * 
   * Criteria:
   * - HIGH: brierSkill > 0.3 and sampleSize >= 10
   * - MEDIUM: brierSkill > 0 and sampleSize >= 5
   * - LOW: brierSkill > 0 and sampleSize < 5 (positive provisional skill, gathering data)
   * - SKIP: brierSkill <= 0 or sampleSize < 5 with brierSkill <= 0
   * 
   * @param {number} brierSkill - Effective or raw Brier skill score
   * @param {number} sampleSize - Number of resolved forecasts
   * @returns {'HIGH'|'MEDIUM'|'LOW'|'SKIP'}
   */
  determineRelevance(brierSkill, sampleSize) {
    if (sampleSize >= 10 && brierSkill > 0.3) {
      return RELEVANCE_TIERS.HIGH;
    }
    if (sampleSize >= 5 && brierSkill > 0) {
      return RELEVANCE_TIERS.MEDIUM;
    }
    if (sampleSize > 0 && sampleSize < 5 && brierSkill > 0) {
      return RELEVANCE_TIERS.LOW;
    }
    return RELEVANCE_TIERS.SKIP;
  }

  /**
   * Compute Expected Calibration Error (ECE) across 10 probability bins
   * @param {Array<Object>} observations 
   * @returns {number} ECE value (0.0 to 1.0)
   */
  calculateExpectedCalibrationError(observations) {
    if (!observations || observations.length === 0) return 0.0;

    const N = observations.length;
    let totalWeightedDelta = 0.0;

    for (let b = 0; b < ECE_BINS_COUNT; b++) {
      const binMin = b / ECE_BINS_COUNT;
      const binMax = (b + 1) / ECE_BINS_COUNT;
      const isLastBin = b === ECE_BINS_COUNT - 1;

      const matching = observations.filter(obs => {
        const p = obs.forecast;
        return isLastBin ? (p >= binMin && p <= binMax) : (p >= binMin && p < binMax);
      });

      const count = matching.length;
      if (count > 0) {
        const avgConfidence = matching.reduce((sum, o) => sum + o.forecast, 0) / count;
        const avgAccuracy = matching.reduce((sum, o) => sum + o.outcome, 0) / count;
        const binDelta = Math.abs(avgConfidence - avgAccuracy);
        totalWeightedDelta += (count / N) * binDelta;
      }
    }

    return parseFloat(totalWeightedDelta.toFixed(5));
  }

  /**
   * Compute full reputation score object for a specific (agentName, eventClass) from observations
   * Incorporates Empirical Bayes skill shrinkage and conservative lower/upper confidence bounds.
   * 
   * @param {string} agentName 
   * @param {string} eventClass 
   * @param {Array<Object>} [obsList] 
   * @returns {Object} Complete score dimension object
   */
  computeReputationScore(agentName, eventClass, obsList) {
    const normAgent = this._normalizeAgentName(agentName);
    const normClass = this._normalizeEventClass(eventClass);
    const key = this._getKey(normAgent, normClass);
    const observations = obsList || this.observations.get(key) || [];

    const sampleSize = observations.length;

    if (sampleSize === 0) {
      return {
        agentName: normAgent,
        eventClass: normClass,
        rawBrierSkill: 0.0,
        effectiveBrierSkill: 0.0,
        skillMean: 0.0,
        skillLowerBound: 0.0,
        skillUpperBound: 0.0,
        effectiveSampleSize: 0,
        brierSkill: 0.0,
        brierScore: {
          agent: null,
          baseline: null
        },
        rawLogLossSkill: 0.0,
        effectiveLogLossSkill: 0.0,
        logLossSkill: 0.0,
        logLoss: {
          agent: null,
          baseline: null
        },
        calibrationError: 0.0,
        leadTime: 0.0,
        falseCatalystRate: 0.0,
        sampleSize: 0,
        relevanceTier: RELEVANCE_TIERS.SKIP,
        lastUpdated: null
      };
    }

    // 1. Calculate Brier Score and Brier Skill Score
    let sumAgentSqErr = 0;
    let sumBaselineSqErr = 0;
    let sumAgentLogLoss = 0;
    let sumBaselineLogLoss = 0;
    let sumLeadTimeMs = 0;
    let highConfCount = 0;
    let highConfWrongCount = 0;
    let latestTimestamp = observations[0].timestamp;

    for (const obs of observations) {
      const p = Math.max(EPSILON, Math.min(1 - EPSILON, obs.forecast));
      const y = obs.outcome === 1 || obs.outcome === true ? 1 : 0;
      const pMarketRaw = typeof obs.marketPrice === 'number' && !isNaN(obs.marketPrice) ? obs.marketPrice : 0.5;
      const pMarket = Math.max(EPSILON, Math.min(1 - EPSILON, pMarketRaw));

      // Brier calculations
      sumAgentSqErr += Math.pow(p - y, 2);
      sumBaselineSqErr += Math.pow(pMarket - y, 2);

      // Log Loss calculations: -(y * ln(p) + (1-y) * ln(1-p))
      sumAgentLogLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      sumBaselineLogLoss += -(y * Math.log(pMarket) + (1 - y) * Math.log(1 - pMarket));

      // Lead time (in milliseconds)
      if (typeof obs.leadTimeMs === 'number' && !isNaN(obs.leadTimeMs)) {
        sumLeadTimeMs += obs.leadTimeMs;
      }

      // False Catalyst detection: Strong stance (p >= 0.70 or p <= 0.30)
      const isHighConf = (obs.forecast >= HIGH_CONF_UPPER || obs.forecast <= HIGH_CONF_LOWER);
      if (isHighConf) {
        highConfCount++;
        const isWrong = (obs.forecast >= HIGH_CONF_UPPER && y === 0) || (obs.forecast <= HIGH_CONF_LOWER && y === 1);
        if (isWrong) {
          highConfWrongCount++;
        }
      }

      if (obs.timestamp && obs.timestamp > latestTimestamp) {
        latestTimestamp = obs.timestamp;
      }
    }

    const agentBrier = sumAgentSqErr / sampleSize;
    const baselineBrier = sumBaselineSqErr / sampleSize || DEFAULT_BASELINE_BRIER;

    // Raw Brier Skill Score: 1 - (agentBrier / baselineBrier)
    let rawBrierSkill = 0.0;
    if (baselineBrier > 0) {
      rawBrierSkill = 1.0 - (agentBrier / baselineBrier);
    } else {
      rawBrierSkill = agentBrier === 0 ? 1.0 : 0.0;
    }

    // Raw Log Loss and Log Loss Skill
    const agentLogLoss = sumAgentLogLoss / sampleSize;
    const baselineLogLoss = sumBaselineLogLoss / sampleSize;
    let rawLogLossSkill = 0.0;
    if (baselineLogLoss > 0) {
      rawLogLossSkill = 1.0 - (agentLogLoss / baselineLogLoss);
    }

    // Empirical Bayes Shrinkage
    const effectiveBrierSkill = this.shrinkSkill(rawBrierSkill, sampleSize, DEFAULT_NEUTRAL_PRIOR, DEFAULT_PRIOR_WEIGHT);
    const effectiveLogLossSkill = this.shrinkSkill(rawLogLossSkill, sampleSize, DEFAULT_NEUTRAL_PRIOR, DEFAULT_PRIOR_WEIGHT);

    // Uncertainty Confidence Bounds (z = 1.96 for 95% CI)
    const bounds = this.computeConfidenceBounds(rawBrierSkill, sampleSize, 0.95, DEFAULT_SKILL_VARIANCE);
    const skillMean = bounds.mean;
    const skillLowerBound = bounds.lower;
    const skillUpperBound = bounds.upper;
    const effectiveSampleSize = sampleSize;

    // Calibration Error (ECE)
    const calibrationError = this.calculateExpectedCalibrationError(observations);

    // Lead time (average seconds)
    const leadTimeSeconds = (sumLeadTimeMs / sampleSize) / 1000;

    // False Catalyst Rate
    const falseCatalystRate = highConfCount > 0 ? (highConfWrongCount / highConfCount) : 0.0;

    // Cleaned numbers
    const cleanRawBrierSkill = parseFloat(rawBrierSkill.toFixed(5));
    const cleanEffectiveBrierSkill = parseFloat(effectiveBrierSkill.toFixed(5));
    const cleanRawLogLossSkill = parseFloat(rawLogLossSkill.toFixed(5));
    const cleanEffectiveLogLossSkill = parseFloat(effectiveLogLossSkill.toFixed(5));
    const cleanCalibError = parseFloat(calibrationError.toFixed(5));
    const cleanLeadTime = parseFloat(leadTimeSeconds.toFixed(2));
    const cleanFalseCatalystRate = parseFloat(falseCatalystRate.toFixed(5));

    // Relevance tier: evaluated against effective shrunk skill
    const relevanceTier = this.determineRelevance(cleanEffectiveBrierSkill, sampleSize);

    return {
      agentName: normAgent,
      eventClass: normClass,
      rawBrierSkill: cleanRawBrierSkill,
      effectiveBrierSkill: cleanEffectiveBrierSkill,
      brierSkill: cleanEffectiveBrierSkill, // maintain backwards compatibility
      skillMean,
      skillLowerBound,
      skillUpperBound,
      effectiveSampleSize,
      brierScore: {
        agent: parseFloat(agentBrier.toFixed(5)),
        baseline: parseFloat(baselineBrier.toFixed(5))
      },
      rawLogLossSkill: cleanRawLogLossSkill,
      effectiveLogLossSkill: cleanEffectiveLogLossSkill,
      logLossSkill: cleanEffectiveLogLossSkill,
      logLoss: {
        agent: parseFloat(agentLogLoss.toFixed(5)),
        baseline: parseFloat(baselineLogLoss.toFixed(5))
      },
      calibrationError: cleanCalibError,
      leadTime: cleanLeadTime,
      falseCatalystRate: cleanFalseCatalystRate,
      sampleSize,
      relevanceTier,
      lastUpdated: latestTimestamp || new Date().toISOString()
    };
  }

  /**
   * Recalculate all in-memory reputations
   * @private
   */
  _recomputeAllReputations() {
    for (const [key, obsList] of this.observations.entries()) {
      const [agentName, eventClass] = key.split(':');
      const score = this.computeReputationScore(agentName, eventClass, obsList);
      this.reputations.set(key, score);
    }
  }

  /**
   * Record a resolved forecast outcome for an agent in an event class
   * 
   * @param {string} agentName - Agent identity (e.g. 'MacroAgent', 'PoliticalAgent')
   * @param {string} eventClass - Domain class (e.g. 'FED_POLICY', 'US_ELECTION')
   * @param {number} forecast - Agent probability forecast in [0.0, 1.0]
   * @param {number|boolean} outcome - Realized binary outcome (1 for YES/TRUE, 0 for NO/FALSE)
   * @param {number} [marketPrice] - Optional market implied probability at forecast time (e.g. 0.52)
   * @param {number} [leadTimeMs=0] - Lead time in milliseconds between forecast and resolution
   * @returns {Object} Updated score reputation object
   */
  recordAgentForecast(agentName, eventClass, forecast, outcome, marketPrice = null, leadTimeMs = 0) {
    if (!agentName || typeof agentName !== 'string') {
      throw new Error('[AgentReputationEngine] agentName is required and must be a string.');
    }
    if (!eventClass || typeof eventClass !== 'string') {
      throw new Error('[AgentReputationEngine] eventClass is required and must be a string.');
    }
    if (forecast === undefined || forecast === null || isNaN(forecast)) {
      throw new Error('[AgentReputationEngine] forecast must be a valid probability number between 0 and 1.');
    }
    if (outcome === undefined || outcome === null) {
      throw new Error('[AgentReputationEngine] outcome is required (1 or 0).');
    }

    const normAgent = this._normalizeAgentName(agentName);
    const normClass = this._normalizeEventClass(eventClass);
    const key = this._getKey(normAgent, normClass);

    const cleanForecast = Math.max(0.0, Math.min(1.0, Number(forecast)));
    const cleanOutcome = outcome === 1 || outcome === true || outcome === '1' ? 1 : 0;
    const cleanMarketPrice = (typeof marketPrice === 'number' && !isNaN(marketPrice)) 
      ? Math.max(0.0, Math.min(1.0, marketPrice)) 
      : null;
    const cleanLeadTimeMs = (typeof leadTimeMs === 'number' && !isNaN(leadTimeMs) && leadTimeMs >= 0)
      ? leadTimeMs
      : 0;
    const timestamp = new Date().toISOString();
    const id = `obs_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const observation = {
      id,
      agentName: normAgent,
      eventClass: normClass,
      forecast: cleanForecast,
      outcome: cleanOutcome,
      marketPrice: cleanMarketPrice,
      leadTimeMs: cleanLeadTimeMs,
      timestamp
    };

    // Store in memory
    if (!this.observations.has(key)) {
      this.observations.set(key, []);
    }
    this.observations.get(key).push(observation);

    // If SQLite is active, insert row
    if (this.persistenceMode === 'SQLITE_PRIMARY' && this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO oracle_agent_forecasts (id, agentName, eventClass, forecast, outcome, marketPrice, leadTimeMs, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(id, normAgent, normClass, cleanForecast, cleanOutcome, cleanMarketPrice, cleanLeadTimeMs, timestamp);
      } catch (err) {
        logger.error(`[AgentReputationEngine] SQLite insert observation failed: ${err.message}`);
      }
    }

    // Recompute reputation score for this tuple
    const score = this.computeReputationScore(normAgent, normClass);
    this.reputations.set(key, score);

    // Persist changes
    this._persist();

    logger.info(`[AgentReputationEngine] Recorded forecast for ${normAgent} on ${normClass}: p=${cleanForecast}, y=${cleanOutcome}, BSS=${score.effectiveBrierSkill} (raw=${score.rawBrierSkill}, lower=${score.skillLowerBound}, N=${score.sampleSize})`);
    return score;
  }

  /**
   * Get the reputation score object for an (agentName, eventClass) tuple
   * 
   * @param {string} agentName 
   * @param {string} eventClass 
   * @returns {Object} Score object
   */
  getReputation(agentName, eventClass) {
    const normAgent = this._normalizeAgentName(agentName);
    const normClass = this._normalizeEventClass(eventClass);
    const key = this._getKey(normAgent, normClass);

    if (this.reputations.has(key)) {
      return this.reputations.get(key);
    }

    // If not cached, compute (handles unobserved zero-sample state)
    const score = this.computeReputationScore(normAgent, normClass);
    this.reputations.set(key, score);
    return score;
  }

  /**
   * Get the full agent × eventClass reputation matrix
   * @returns {Object} Complete reputation matrix
   */
  getReputationMatrix() {
    const matrix = {};

    for (const agent of AGENT_NAMES) {
      matrix[agent] = {};
      for (const eventClass of EVENT_CLASSES) {
        matrix[agent][eventClass] = this.getReputation(agent, eventClass);
      }
    }

    return {
      agents: [...AGENT_NAMES],
      eventClasses: [...EVENT_CLASSES],
      matrix,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Select qualified domain experts for an event class, filtered and sorted by conservative lower confidence bound (skillLowerBound)
   * 
   * @param {string} eventClass 
   * @param {number} [minSampleSize=10] - Minimum resolved observations required
   * @param {number} [minBrierSkill=0.0] - Minimum skill threshold
   * @returns {Array<Object>} Sorted list of qualified expert objects
   */
  selectExperts(eventClass, minSampleSize = 10, minBrierSkill = 0.0) {
    const normClass = this._normalizeEventClass(eventClass);
    const candidateList = [];

    // Collect reputations across all known agents
    for (const agent of AGENT_NAMES) {
      const rep = this.getReputation(agent, normClass);
      if (rep.sampleSize >= minSampleSize && (rep.effectiveBrierSkill >= minBrierSkill || rep.rawBrierSkill >= minBrierSkill || rep.skillLowerBound >= minBrierSkill)) {
        candidateList.push(rep);
      }
    }

    // Sort descending by conservative lower confidence bound (skillLowerBound), then sampleSize, then ascending calibrationError
    candidateList.sort((a, b) => {
      if (b.skillLowerBound !== a.skillLowerBound) return b.skillLowerBound - a.skillLowerBound;
      if (b.effectiveSampleSize !== a.effectiveSampleSize) return b.effectiveSampleSize - a.effectiveSampleSize;
      return a.calibrationError - b.calibrationError;
    });

    // Compute softmax weights among the selected experts using conservative lower confidence bounds
    if (candidateList.length > 0) {
      const maxBound = Math.max(...candidateList.map(c => c.skillLowerBound));
      const expValues = candidateList.map(c => Math.exp(c.skillLowerBound - maxBound));
      const sumExp = expValues.reduce((sum, v) => sum + v, 0);

      return candidateList.map((c, idx) => ({
        agent: c.agentName,
        agentName: c.agentName,
        eventClass: normClass,
        rawBrierSkill: c.rawBrierSkill,
        effectiveBrierSkill: c.effectiveBrierSkill,
        brierSkill: c.effectiveBrierSkill,
        skillMean: c.skillMean,
        skillLowerBound: c.skillLowerBound,
        skillUpperBound: c.skillUpperBound,
        effectiveSampleSize: c.effectiveSampleSize,
        logLossSkill: c.logLossSkill,
        calibrationError: c.calibrationError,
        leadTime: c.leadTime,
        falseCatalystRate: c.falseCatalystRate,
        sampleSize: c.sampleSize,
        relevanceTier: c.relevanceTier,
        weight: parseFloat((expValues[idx] / sumExp).toFixed(4)),
        reputation: c
      }));
    }

    return [];
  }

  /**
   * Compute normalized ensemble weight for an agent in a specific event domain using conservative lower confidence bounds
   * 
   * @param {string} agentName 
   * @param {string} eventClass 
   * @returns {number} Normalized weight in [0.0, 1.0]
   */
  computeWeight(agentName, eventClass) {
    const normAgent = this._normalizeAgentName(agentName);
    const normClass = this._normalizeEventClass(eventClass);

    // Evaluate all agents in this domain
    const candidateScores = [];
    for (const agent of AGENT_NAMES) {
      const rep = this.getReputation(agent, normClass);
      candidateScores.push(rep);
    }

    // Qualified agents: relevanceTier !== 'SKIP' (or positive effective brier skill with sampleSize > 0)
    const qualified = candidateScores.filter(c => c.relevanceTier !== RELEVANCE_TIERS.SKIP && (c.effectiveBrierSkill > 0 || c.rawBrierSkill > 0));

    // Cold-start fallback: if no agents meet empirical threshold, use canonical domain priors
    if (qualified.length === 0) {
      const defaultSpecialists = CANONICAL_SPECIALISTS[normClass] || ['LogicAgent'];
      if (defaultSpecialists.includes(normAgent)) {
        return parseFloat((1.0 / defaultSpecialists.length).toFixed(4));
      }
      return 0.0;
    }

    // If agent is not among qualified, weight is 0
    const target = qualified.find(c => c.agentName === normAgent);
    if (!target) {
      return 0.0;
    }

    // Numerically stable softmax on skillLowerBound: exp(bound_i - max(bound)) / sum(exp(bound_j - max(bound)))
    const maxBound = Math.max(...qualified.map(q => q.skillLowerBound));
    const expValues = qualified.map(q => Math.exp(q.skillLowerBound - maxBound));
    const sumExp = expValues.reduce((sum, v) => sum + v, 0);

    const targetIdx = qualified.findIndex(c => c.agentName === normAgent);
    const weight = expValues[targetIdx] / sumExp;

    return parseFloat(weight.toFixed(4));
  }

  /**
   * Route a question to the most qualified agent specialist, returning relevance and ensemble weight
   * 
   * @param {string} question - Question or forecast prompt
   * @param {string} [eventClass] - Optional explicit event class (inferred if omitted)
   * @returns {Object} Routing decision object: { agent, relevance, weight, eventClass, question, ... }
   */
  getRouting(question, eventClass) {
    const promptText = question || '';
    const normClass = eventClass ? this._normalizeEventClass(eventClass) : this.inferEventClass(promptText);

    // Score all canonical agents on this domain
    const evaluations = AGENT_NAMES.map(agent => {
      const rep = this.getReputation(agent, normClass);
      const weight = this.computeWeight(agent, normClass);
      return {
        agent,
        agentName: agent,
        relevance: rep.relevanceTier,
        weight,
        rawBrierSkill: rep.rawBrierSkill,
        effectiveBrierSkill: rep.effectiveBrierSkill,
        brierSkill: rep.effectiveBrierSkill,
        skillMean: rep.skillMean,
        skillLowerBound: rep.skillLowerBound,
        skillUpperBound: rep.skillUpperBound,
        effectiveSampleSize: rep.effectiveSampleSize,
        logLossSkill: rep.logLossSkill,
        calibrationError: rep.calibrationError,
        sampleSize: rep.sampleSize,
        falseCatalystRate: rep.falseCatalystRate,
        leadTime: rep.leadTime
      };
    });

    // Sort by weight descending, then skillLowerBound descending, then sampleSize descending
    evaluations.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (b.skillLowerBound !== a.skillLowerBound) return b.skillLowerBound - a.skillLowerBound;
      return b.sampleSize - a.sampleSize;
    });

    // Qualified candidates
    const qualifiedCandidates = evaluations.filter(e => e.weight > 0);

    let primaryAgent = evaluations[0].agent;
    let primaryRelevance = evaluations[0].relevance;
    let primaryWeight = evaluations[0].weight;
    let routingReason = 'EMPIRICAL_SKILL_ROUTING';

    // Handle cold-start fallback when no empirical track record exists
    if (qualifiedCandidates.length === 0 || evaluations[0].sampleSize === 0) {
      const defaultSpecialists = CANONICAL_SPECIALISTS[normClass] || ['LogicAgent'];
      primaryAgent = defaultSpecialists[0];
      primaryRelevance = RELEVANCE_TIERS.MEDIUM; // Provisional baseline
      primaryWeight = parseFloat((1.0 / defaultSpecialists.length).toFixed(4));
      routingReason = 'CANONICAL_DOMAIN_PRIOR_COLD_START';
    } else if (primaryRelevance === RELEVANCE_TIERS.HIGH) {
      routingReason = 'EMPIRICAL_PROVEN_EXPERT';
    } else if (primaryRelevance === RELEVANCE_TIERS.MEDIUM) {
      routingReason = 'EMPIRICAL_MODERATE_SKILL_EXPERT';
    } else if (primaryRelevance === RELEVANCE_TIERS.LOW) {
      routingReason = 'PROVISIONAL_EXPLORATORY_EXPERT';
    } else {
      routingReason = 'DEFAULT_ROUTING_FALLBACK';
    }

    return {
      agent: primaryAgent,
      relevance: primaryRelevance,
      weight: primaryWeight,
      eventClass: normClass,
      question: promptText,
      routingReason,
      candidates: evaluations
    };
  }

  /**
   * Close any open database connection (useful during teardown / testing)
   */
  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch (_) {}
      this.db = null;
    }
  }

  /**
   * Reset reputation state (primarily for test harness and validation runs)
   */
  clearAll() {
    this.observations.clear();
    this.reputations.clear();

    if (this.persistenceMode === 'SQLITE_PRIMARY' && this.db) {
      try {
        this.db.exec(`
          DELETE FROM oracle_agent_forecasts;
          DELETE FROM oracle_agent_reputations;
        `);
      } catch (err) {
        logger.error(`[AgentReputationEngine] SQLite clear error: ${err.message}`);
      }
    }

    this._saveToJsonFile();
    logger.info('[AgentReputationEngine] All reputations and observations reset.');
  }

  /**
   * Get engine operational telemetry & diagnostics
   * @returns {Object}
   */
  getStats() {
    let totalObs = 0;
    for (const list of this.observations.values()) {
      totalObs += list.length;
    }

    return {
      persistenceMode: this.persistenceMode,
      jsonPath: this.jsonPath,
      dbPath: this.dbPath,
      totalObservations: totalObs,
      scoredTuplesCount: this.reputations.size,
      availableAgents: [...AGENT_NAMES],
      availableEventClasses: [...EVENT_CLASSES],
      governance: GOVERNANCE_POLICY
    };
  }
}

// Singleton instantiation
const agentReputationEngine = new AgentReputationEngine();

module.exports = {
  AgentReputationEngine,
  agentReputationEngine,
  EVENT_CLASSES,
  AGENT_NAMES,
  RELEVANCE_TIERS,
  CANONICAL_SPECIALISTS,
  GOVERNANCE_POLICY
};
