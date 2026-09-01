/**
 * @file errorAttributionEngine.js
 * @module intelligence/oracle/errorAttributionEngine
 * @description Error Attribution Engine for Trading Brain's ORACLE Intelligence Layer.
 * Diagnoses WHY market predictions failed after resolution, identifies primary and
 * secondary failure modes across agents and evidence sources, generates structured
 * human-readable postmortems, and maintains an episodic attribution history.
 * 
 * Governance Compliance:
 * - Read-only observational analysis and postmortem learning.
 * - Does NOT modify live execution parameters, risk caps, or historical trade ledgers.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('ErrorAttributionEngine');

/**
 * Standardized Error Taxonomy (Enum) for ORACLE post-resolution diagnostics.
 * @readonly
 * @enum {string}
 */
const ERROR_TYPES = Object.freeze({
  SOURCE_STALE: 'SOURCE_STALE',                     // Evidence was too old at decision time (> 12h)
  SOURCE_FALSE: 'SOURCE_FALSE',                     // Evidence turned out to be incorrect or fabricated
  CONTRACT_MISREAD: 'CONTRACT_MISREAD',             // Market question, terms, or settlement rules were misunderstood
  OVERCONFIDENT_MODEL: 'OVERCONFIDENT_MODEL',       // Forecast was significantly higher than outcome warranted (|err| > 0.4 & forecast > 0.7)
  UNDERCONFIDENT_MODEL: 'UNDERCONFIDENT_MODEL',     // Forecast was significantly lower than outcome warranted (|err| > 0.4 & forecast < 0.3)
  MARKET_ALREADY_REPRICED: 'MARKET_ALREADY_REPRICED', // Market price moved before execution could occur
  EXECUTION_TOO_SLOW: 'EXECUTION_TOO_SLOW',         // Timing gap / latency caused adverse fill
  LOGICAL_RELATION_WRONG: 'LOGICAL_RELATION_WRONG', // Causal or correlational assumption was incorrect
  RESOLUTION_AMBIGUITY: 'RESOLUTION_AMBIGUITY',     // Outcome was unclear, disputed, or subject to irregular settlement
  CLUSTER_RISK_TOO_HIGH: 'CLUSTER_RISK_TOO_HIGH',   // Correlated positions amplified portfolio loss
  REGIME_SHIFT: 'REGIME_SHIFT',                     // Market regime changed unexpectedly between decision and resolution
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',   // Not enough data / sources to make reliable forecast
  UNKNOWN: 'UNKNOWN',                               // Cannot determine root cause with available information
  IRREDUCIBLE_EVENT_SHOCK: 'IRREDUCIBLE_EVENT_SHOCK', // Genuinely unpredictable event — no model could have known
  LOW_PROBABILITY_OUTCOME_OCCURRED: 'LOW_PROBABILITY_OUTCOME_OCCURRED' // CRITICAL: p=80% failing 20% of the time is NOT a model error
});

/**
 * Error priority weights used to rank primary vs secondary error classifications.
 */
const ERROR_PRIORITY_WEIGHTS = Object.freeze({
  RESOLUTION_AMBIGUITY: 100,
  CONTRACT_MISREAD: 95,
  SOURCE_FALSE: 90,
  SOURCE_STALE: 85,
  REGIME_SHIFT: 80,
  LOGICAL_RELATION_WRONG: 75,
  OVERCONFIDENT_MODEL: 70,
  UNDERCONFIDENT_MODEL: 70,
  MARKET_ALREADY_REPRICED: 65,
  EXECUTION_TOO_SLOW: 60,
  CLUSTER_RISK_TOO_HIGH: 55,
  INSUFFICIENT_EVIDENCE: 50,
  IRREDUCIBLE_EVENT_SHOCK: 30,
  UNKNOWN: 20,
  LOW_PROBABILITY_OUTCOME_OCCURRED: 10  // Not an error — calibrated outcome
});

/**
 * Default actionable lessons catalog mapped by error type.
 */
const ERROR_LESSON_CATALOG = Object.freeze({
  SOURCE_STALE: 'Enforce strict maximum evidence age threshold (< 12 hours) before committing model forecasts.',
  SOURCE_FALSE: 'Implement multi-source cross-verification and decrease weight on low-reputation feeds.',
  CONTRACT_MISREAD: 'Require explicit contract specification parsing and settlement condition checklist validation.',
  OVERCONFIDENT_MODEL: 'Apply Bayesian shrinkage / probability temperature scaling to dampen extreme confidence (> 0.7).',
  UNDERCONFIDENT_MODEL: 'Recalibrate lower-bound probability estimation when multi-agent directional consensus is positive.',
  MARKET_ALREADY_REPRICED: 'Incorporate real-time order book spread velocity checks and abort entry if edge is already absorbed.',
  EXECUTION_TOO_SLOW: 'Optimize order routing pipeline latency to prevent adverse execution timing gaps.',
  LOGICAL_RELATION_WRONG: 'Re-audit causal graph dependencies and invalidate stale correlation priors in the hypothesis module.',
  RESOLUTION_AMBIGUITY: 'Detect ambiguous oracle settlement criteria early and reduce position sizing on edge cases.',
  CLUSTER_RISK_TOO_HIGH: 'Enforce stringent multi-asset portfolio covariance caps during high-volatility regimes.',
  REGIME_SHIFT: 'Incorporate real-time volatility regime shift detectors to trigger proactive belief updates.',
  INSUFFICIENT_EVIDENCE: 'Require at least two independent verifiable sources prior to generating actionable signals.',
  UNKNOWN: 'Root cause could not be determined. Archive for future analysis when more context is available.',
  IRREDUCIBLE_EVENT_SHOCK: 'Genuinely unpredictable event. No model improvement possible. Verify position sizing was appropriate.',
  LOW_PROBABILITY_OUTCOME_OCCURRED: 'NO LESSON REQUIRED: A calibrated forecast that loses ~20% of the time SHOULD lose ~20% of the time. Do NOT retrain or adjust weights.'
});

/**
 * ErrorAttributionEngine
 * Diagnoses post-resolution prediction errors and maintains structured postmortems.
 */
class ErrorAttributionEngine {
  /**
   * @param {Object} [options={}] - Configuration options.
   * @param {string} [options.jsonPath] - Path to JSON persistence file.
   * @param {string} [options.dbPath] - Path to SQLite database file.
   * @param {number} [options.maxHistory=5000] - In-memory maximum record cache limit.
   */
  constructor(options = {}) {
    this.jsonPath = options.jsonPath || path.join(process.cwd(), 'data', 'oracle', 'error_attributions.json');
    this.dbPath = options.dbPath || path.join(process.cwd(), 'data', 'oracle', 'oracle.db');
    this.maxHistory = options.maxHistory || 5000;

    /** @type {Map<string, Object>} In-memory store: attributionId -> attribution */
    this.attributions = new Map();

    /** @type {Map<string, string>} Index: episodeId -> attributionId */
    this.episodeIndex = new Map();

    /** @type {'SQLITE_PRIMARY' | 'JSON_FALLBACK' | 'MEMORY_ONLY'} */
    this.persistenceMode = 'MEMORY_ONLY';
    this.db = null;

    this._initPersistence();
  }

  /**
   * Initializes persistence layer (SQLite with fallback to JSON).
   * @private
   */
  _initPersistence() {
    try {
      const jsonDir = path.dirname(this.jsonPath);
      if (!fs.existsSync(jsonDir)) {
        fs.mkdirSync(jsonDir, { recursive: true });
      }

      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Attempt SQLite initialization via better-sqlite3
      try {
        const Database = require('better-sqlite3');
        this.db = new Database(this.dbPath);
        this._initSqliteTables();
        this.persistenceMode = 'SQLITE_PRIMARY';
        logger.info('ErrorAttributionEngine initialized with SQLite persistence', { dbPath: this.dbPath });
      } catch (sqliteErr) {
        this.persistenceMode = 'JSON_FALLBACK';
        logger.info('better-sqlite3 unavailable or failed; using JSON file fallback', { error: sqliteErr.message });
      }

      // Load records from persistent storage
      this._loadRecords();
    } catch (err) {
      this.persistenceMode = 'MEMORY_ONLY';
      logger.warn('Failed to initialize persistent storage; falling back to MEMORY_ONLY', { error: err.message });
    }
  }

  /**
   * Sets up SQLite database schema.
   * @private
   */
  _initSqliteTables() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oracle_error_attributions (
        attribution_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_class TEXT,
        forecast REAL NOT NULL,
        outcome INTEGER NOT NULL,
        brier_score REAL NOT NULL,
        primary_error TEXT NOT NULL,
        secondary_errors TEXT,
        agent_errors TEXT,
        source_analysis TEXT,
        market_comparison TEXT,
        postmortem TEXT,
        lessons TEXT,
        similar_past_errors TEXT,
        raw_attribution TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oracle_err_ep ON oracle_error_attributions(episode_id);
      CREATE INDEX IF NOT EXISTS idx_oracle_err_type ON oracle_error_attributions(primary_error);
      CREATE INDEX IF NOT EXISTS idx_oracle_err_class ON oracle_error_attributions(event_class);
      CREATE INDEX IF NOT EXISTS idx_oracle_err_ts ON oracle_error_attributions(timestamp);
    `);
  }

  /**
   * Loads records from SQLite or JSON into memory cache.
   * @private
   */
  _loadRecords() {
    let loaded = false;

    // 1. Try loading from SQLite
    if (this.db && this.persistenceMode === 'SQLITE_PRIMARY') {
      try {
        const rows = this.db.prepare(`
          SELECT raw_attribution FROM oracle_error_attributions ORDER BY timestamp ASC
        `).all();

        for (const row of rows) {
          try {
            const attr = JSON.parse(row.raw_attribution);
            if (attr && attr.attributionId) {
              this.attributions.set(attr.attributionId, attr);
              if (attr.episodeId) {
                this.episodeIndex.set(attr.episodeId, attr.attributionId);
              }
            }
          } catch (_) {}
        }
        loaded = true;
        logger.info(`Loaded ${this.attributions.size} error attributions from SQLite.`);
      } catch (err) {
        logger.warn('Failed reading from SQLite; attempting JSON fallback', { error: err.message });
      }
    }

    // 2. Load from JSON if SQLite was empty or failed
    if (!loaded || this.attributions.size === 0) {
      try {
        if (fs.existsSync(this.jsonPath)) {
          const raw = fs.readFileSync(this.jsonPath, 'utf8');
          const data = JSON.parse(raw);
          const list = Array.isArray(data) ? data : (data.attributions || []);

          for (const attr of list) {
            if (attr && attr.attributionId) {
              this.attributions.set(attr.attributionId, attr);
              if (attr.episodeId) {
                this.episodeIndex.set(attr.episodeId, attr.attributionId);
              }
              // If SQLite is primary, sync JSON records to SQLite
              if (this.db && this.persistenceMode === 'SQLITE_PRIMARY') {
                this._persistToSqlite(attr);
              }
            }
          }
          logger.info(`Loaded ${this.attributions.size} error attributions from JSON file.`);
        }
      } catch (err) {
        logger.warn('Failed reading from JSON fallback file', { error: err.message });
      }
    }
  }

  /**
   * Persists an attribution record to disk (both JSON and SQLite if active).
   * @private
   * @param {Object} attribution
   */
  _persistRecord(attribution) {
    // 1. Persist to SQLite
    if (this.db && this.persistenceMode === 'SQLITE_PRIMARY') {
      this._persistToSqlite(attribution);
    }

    // 2. Always maintain up-to-date JSON file as specified in requirements
    this._persistToJson();
  }

  /**
   * Persists record to SQLite.
   * @private
   * @param {Object} attr
   */
  _persistToSqlite(attr) {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO oracle_error_attributions (
          attribution_id, episode_id, timestamp, event_class, forecast, outcome,
          brier_score, primary_error, secondary_errors, agent_errors, source_analysis,
          market_comparison, postmortem, lessons, similar_past_errors, raw_attribution
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        attr.attributionId,
        attr.episodeId || '',
        attr.timestamp,
        attr.eventClass || 'DEFAULT',
        attr.forecast,
        attr.outcome,
        attr.brierScore,
        attr.primaryError,
        JSON.stringify(attr.secondaryErrors || []),
        JSON.stringify(attr.agentErrors || {}),
        JSON.stringify(attr.sourceAnalysis || []),
        JSON.stringify(attr.marketComparison || {}),
        attr.postmortem || '',
        JSON.stringify(attr.lessons || []),
        JSON.stringify(attr.similarPastErrors || []),
        JSON.stringify(attr)
      );
    } catch (err) {
      logger.error('Failed writing attribution to SQLite', { error: err.message, attributionId: attr.attributionId });
    }
  }

  /**
   * Writes all in-memory attributions safely to JSON file.
   * @private
   */
  _persistToJson() {
    try {
      const records = Array.from(this.attributions.values());
      const tempPath = `${this.jsonPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(records, null, 2), 'utf8');
      fs.renameSync(tempPath, this.jsonPath);
    } catch (err) {
      logger.error('Failed writing error attributions to JSON file', { error: err.message, path: this.jsonPath });
    }
  }

  /**
   * Analyzes a resolved episode and its ground-truth outcome, generates a structured attribution,
   * finds similar past errors, saves to persistent storage, and returns the attribution.
   * 
   * @param {Object} episode - The trading episode / forecast snapshot.
   * @param {number|boolean|string} outcome - The resolved outcome (0 or 1, true/false, 'YES'/'NO').
   * @returns {Object} Structured error attribution record.
   */
  attributeError(episode = {}, outcome) {
    const timestamp = new Date().toISOString();
    const episodeId = String(episode.episodeId || episode.id || `ep_${Date.now()}`);
    const eventClass = episode.eventClass || episode.category || episode.market || episode.symbol || 'DEFAULT';

    // Normalize forecast to [0, 1] range
    let forecast = 0.5;
    if (typeof episode.calibratedForecast === 'number' && !isNaN(episode.calibratedForecast)) {
      forecast = episode.calibratedForecast;
    } else if (typeof episode.ensembleForecast === 'number' && !isNaN(episode.ensembleForecast)) {
      forecast = episode.ensembleForecast;
    } else if (typeof episode.forecast === 'number' && !isNaN(episode.forecast)) {
      forecast = episode.forecast;
    } else if (typeof episode.probability === 'number' && !isNaN(episode.probability)) {
      forecast = episode.probability;
    } else if (typeof episode.p === 'number' && !isNaN(episode.p)) {
      forecast = episode.p;
    } else if (typeof episode.confidence === 'number' && !isNaN(episode.confidence)) {
      forecast = episode.confidence;
    } else if (episode.agentForecasts && typeof episode.agentForecasts === 'object') {
      const vals = Object.values(episode.agentForecasts).map(Number).filter(v => !isNaN(v));
      if (vals.length > 0) forecast = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    forecast = Math.max(0, Math.min(1, Number(forecast.toFixed(4))));

    // Normalize outcome to 0 | 1
    let normalizedOutcome = 0;
    if (outcome === 1 || outcome === true || outcome === '1' || outcome === 'YES' || outcome === 'SUCCESS' || outcome === 'WIN') {
      normalizedOutcome = 1;
    } else {
      normalizedOutcome = 0;
    }

    // Calculate Brier Score: (forecast - outcome)^2
    const brierScore = Number(Math.pow(forecast - normalizedOutcome, 2).toFixed(6));
    const forecastError = Math.abs(forecast - normalizedOutcome);

    // 1. Source Analysis & Freshness Detection
    const sourceAnalysis = this._analyzeSources(episode, normalizedOutcome);
    const hasStaleSource = sourceAnalysis.some(s => s.wasStale);
    const hasFalseSource = sourceAnalysis.some(s => !s.wasAccurate);
    const hasInsufficientEvidence = sourceAnalysis.length < 2 || episode.insufficientEvidence === true;

    // 2. Market Comparison
    const marketComparison = this._analyzeMarketComparison(episode, normalizedOutcome, forecast);

    // 3. Agent Errors Breakdown
    const agentErrors = this._analyzeAgentErrors(episode, normalizedOutcome);

    // 4. Diagnose Primary & Secondary Errors
    const { primaryError, secondaryErrors } = this._classifyErrors({
      episode,
      forecast,
      outcome: normalizedOutcome,
      forecastError,
      hasStaleSource,
      hasFalseSource,
      hasInsufficientEvidence,
      marketComparison,
      agentErrors
    });

    // 5. Generate Lessons
    const lessons = this._extractLessons(primaryError, secondaryErrors, episode);

    // 6. Interim attribution structure for similarity search
    const attributionId = `err_${Date.now()}_${episodeId}`;
    const interimAttribution = {
      attributionId,
      episodeId,
      timestamp,
      eventClass,
      forecast,
      outcome: normalizedOutcome,
      brierScore,
      primaryError,
      secondaryErrors,
      agentErrors,
      sourceAnalysis,
      marketComparison,
      lessons
    };

    // 7. Find Similar Past Errors
    const similarPastErrors = this.findSimilarErrors(interimAttribution, 5);

    // 8. Generate Human-Readable Postmortem
    const postmortem = this.generatePostmortem(episode, normalizedOutcome, {
      forecast,
      brierScore,
      primaryError,
      secondaryErrors,
      sourceAnalysis,
      marketComparison,
      agentErrors,
      lessons,
      similarPastErrors
    });

    // Complete attribution object
    const finalAttribution = {
      attributionId,
      episodeId,
      timestamp,
      eventClass,
      forecast,
      outcome: normalizedOutcome,
      brierScore,
      primaryError,
      secondaryErrors,
      agentErrors,
      sourceAnalysis,
      marketComparison,
      postmortem,
      lessons,
      similarPastErrors
    };

    // Maintain in-memory cache & indexes
    this.attributions.set(attributionId, finalAttribution);
    this.episodeIndex.set(episodeId, attributionId);

    // Trim memory cache if exceeding maximum
    if (this.attributions.size > this.maxHistory) {
      const oldestKey = this.attributions.keys().next().value;
      if (oldestKey) {
        const oldAttr = this.attributions.get(oldestKey);
        if (oldAttr && oldAttr.episodeId) {
          this.episodeIndex.delete(oldAttr.episodeId);
        }
        this.attributions.delete(oldestKey);
      }
    }

    // Persist to storage
    this._persistRecord(finalAttribution);

    logger.info(`Attributed error for episode ${episodeId}: Primary=${primaryError}, Brier=${brierScore}`, {
      attributionId,
      primaryError,
      secondaryErrorsCount: secondaryErrors.length
    });

    return finalAttribution;
  }

  /**
   * Analyzes evidence sources in the episode for staleness and veracity.
   * @private
   * @param {Object} episode
   * @param {number} outcome
   * @returns {Array<{ source: string, wasStale: boolean, wasAccurate: boolean, ageAtDecisionSec: number }>}
   */
  _analyzeSources(episode, outcome) {
    const rawSources = episode.sources || episode.sourceAnalysis || episode.evidence || episode.signals || [];
    const results = [];
    const twelveHoursInSec = 12 * 3600; // 43,200 seconds

    if (!Array.isArray(rawSources) || rawSources.length === 0) {
      return results;
    }

    const decisionTimeMs = episode.decisionTimestamp
      ? new Date(episode.decisionTimestamp).getTime()
      : (episode.timestamp ? new Date(episode.timestamp).getTime() : Date.now());

    for (const src of rawSources) {
      let sourceName = 'unknown_source';
      let ageAtDecisionSec = 0;
      let wasStale = false;
      let wasAccurate = true;

      if (typeof src === 'string') {
        sourceName = src;
      } else if (typeof src === 'object' && src !== null) {
        sourceName = src.source || src.name || src.id || src.feed || 'unknown_source';

        if (typeof src.ageAtDecisionSec === 'number') {
          ageAtDecisionSec = Math.max(0, Math.round(src.ageAtDecisionSec));
        } else if (typeof src.ageSec === 'number') {
          ageAtDecisionSec = Math.max(0, Math.round(src.ageSec));
        } else if (src.timestamp) {
          const srcTimeMs = new Date(src.timestamp).getTime();
          if (!isNaN(srcTimeMs) && srcTimeMs <= decisionTimeMs) {
            ageAtDecisionSec = Math.max(0, Math.round((decisionTimeMs - srcTimeMs) / 1000));
          }
        }

        // Freshness check: source age > 12 hours
        if (src.wasStale !== undefined) {
          wasStale = Boolean(src.wasStale);
        } else {
          wasStale = ageAtDecisionSec > twelveHoursInSec;
        }

        // Veracity check
        if (src.wasAccurate !== undefined) {
          wasAccurate = Boolean(src.wasAccurate);
        } else if (src.wasFalse === true || src.contradicted === true || src.isErroneous === true) {
          wasAccurate = false;
        }
      }

      results.push({
        source: String(sourceName),
        wasStale,
        wasAccurate,
        ageAtDecisionSec
      });
    }

    return results;
  }

  /**
   * Compares model prediction against prevailing market price at decision time.
   * @private
   * @param {Object} episode
   * @param {number} outcome
   * @param {number} forecast
   * @returns {{ marketPrice: number|null, marketWasBetter: boolean }}
   */
  _analyzeMarketComparison(episode, outcome, forecast) {
    let marketPrice = null;
    if (typeof episode.marketPrice === 'number' && !isNaN(episode.marketPrice)) {
      marketPrice = episode.marketPrice;
    } else if (typeof episode.marketComparison?.marketPrice === 'number') {
      marketPrice = episode.marketComparison.marketPrice;
    } else if (typeof episode.initialMarketPrice === 'number') {
      marketPrice = episode.initialMarketPrice;
    } else if (typeof episode.marketProbability === 'number') {
      marketPrice = episode.marketProbability;
    }

    if (marketPrice !== null && !isNaN(marketPrice)) {
      marketPrice = Math.max(0, Math.min(1, Number(marketPrice.toFixed(4))));
      const marketError = Math.abs(marketPrice - outcome);
      const forecastError = Math.abs(forecast - outcome);
      // Market was better if its price was closer to outcome than model forecast
      const marketWasBetter = marketError < forecastError;

      return {
        marketPrice,
        marketWasBetter
      };
    }

    return {
      marketPrice: null,
      marketWasBetter: false
    };
  }

  /**
   * Evaluates individual contributing agent forecasts.
   * @private
   * @param {Object} episode
   * @param {number} outcome
   * @returns {Object.<string, { forecast: number, error: number, errorType: string }>}
   */
  _analyzeAgentErrors(episode, outcome) {
    const agentErrors = {};
    const rawAgents = episode.agentForecasts || episode.agentVotes || episode.agents || episode.agentErrors || {};

    if (typeof rawAgents === 'object' && rawAgents !== null) {
      for (const [agentName, val] of Object.entries(rawAgents)) {
        let agentForecast = 0.5;

        if (typeof val === 'number') {
          agentForecast = val;
        } else if (typeof val === 'object' && val !== null) {
          if (typeof val.forecast === 'number') agentForecast = val.forecast;
          else if (typeof val.probability === 'number') agentForecast = val.probability;
          else if (typeof val.confidence === 'number') agentForecast = val.confidence;
          else if (typeof val.vote === 'number') agentForecast = val.vote;
        }

        agentForecast = Math.max(0, Math.min(1, Number(agentForecast.toFixed(4))));
        const error = Number(Math.abs(agentForecast - outcome).toFixed(4));

        let errorType = 'ACCURATE';
        if (error > 0.4 && agentForecast > 0.7) {
          errorType = ERROR_TYPES.OVERCONFIDENT_MODEL;
        } else if (error > 0.4 && agentForecast < 0.3) {
          errorType = ERROR_TYPES.UNDERCONFIDENT_MODEL;
        } else if (error > 0.4) {
          errorType = 'DIRECTIONAL_BIAS';
        } else if (error > 0.2) {
          errorType = 'MODERATE_ERROR';
        }

        agentErrors[agentName] = {
          forecast: agentForecast,
          error,
          errorType
        };
      }
    }

    // Also support supportingAgents / opposingAgents lists if present
    if (Array.isArray(episode.supportingAgents)) {
      for (const agent of episode.supportingAgents) {
        if (!agentErrors[agent]) {
          const inferredForecast = outcome === 1 ? 0.8 : 0.8;
          const error = Number(Math.abs(inferredForecast - outcome).toFixed(4));
          agentErrors[agent] = {
            forecast: inferredForecast,
            error,
            errorType: error > 0.4 ? ERROR_TYPES.OVERCONFIDENT_MODEL : 'ACCURATE'
          };
        }
      }
    }

    if (Array.isArray(episode.opposingAgents)) {
      for (const agent of episode.opposingAgents) {
        if (!agentErrors[agent]) {
          const inferredForecast = outcome === 1 ? 0.2 : 0.2;
          const error = Number(Math.abs(inferredForecast - outcome).toFixed(4));
          agentErrors[agent] = {
            forecast: inferredForecast,
            error,
            errorType: error > 0.4 ? ERROR_TYPES.UNDERCONFIDENT_MODEL : 'ACCURATE'
          };
        }
      }
    }

    return agentErrors;
  }

  /**
   * Diagnostic classifier that detects primary and secondary error categories.
   * 
   * Classification Logic:
   * - |forecast - outcome| > 0.4 and forecast > 0.7 => OVERCONFIDENT_MODEL
   * - |forecast - outcome| > 0.4 and forecast < 0.3 => UNDERCONFIDENT_MODEL
   * - Any source age > 12h => SOURCE_STALE
   * - Any source inaccurate => SOURCE_FALSE
   * - Ambiguous settlement or contract rules misunderstood => RESOLUTION_AMBIGUITY / CONTRACT_MISREAD
   * - Market moved before execution / slippage => MARKET_ALREADY_REPRICED / EXECUTION_TOO_SLOW
   * - Causal assumptions invalidated => LOGICAL_RELATION_WRONG
   * - Volatility jump / macro regime shift => REGIME_SHIFT
   * - Correlated position losses => CLUSTER_RISK_TOO_HIGH
   * - Insufficient data sources => INSUFFICIENT_EVIDENCE
   * 
   * @private
   * @returns {{ primaryError: string, secondaryErrors: string[] }}
   */
  _classifyErrors(params) {
    const {
      episode,
      forecast,
      outcome,
      forecastError,
      hasStaleSource,
      hasFalseSource,
      hasInsufficientEvidence,
      marketComparison
    } = params;

    const detected = new Map(); // errorType -> priorityScore

    // 0. Calibrated Probability Validation Check (Critical Scientific Discipline):
    // If the forecast was moderately confident (0.75 - 0.85) and lost, or (0.15 - 0.25) and won,
    // AND there were no stale/false sources, contract misreads, or execution defects:
    // This is a normal, calibrated statistical outcome (~20% realization), NOT a model bug.
    const isCalibratedBand = (forecast >= 0.70 && forecast <= 0.85 && outcome === 0) ||
                             (forecast >= 0.15 && forecast <= 0.30 && outcome === 1);
    const hasOperationalFailure = hasStaleSource || hasFalseSource || episode.resolutionAmbiguity ||
                                  episode.contractMisread || episode.executionTooSlow;

    if (isCalibratedBand && !hasOperationalFailure && !hasInsufficientEvidence) {
      detected.set(ERROR_TYPES.LOW_PROBABILITY_OUTCOME_OCCURRED, 150); // Highest priority: prevent false model mutation
    } else if (isCalibratedBand && !hasOperationalFailure) {
      // Even with scarce evidence, if specifically tagged as calibrated trade
      if (episode.isCalibratedTrade === true || (episode.question && episode.question.toLowerCase().includes('calibrated'))) {
        detected.set(ERROR_TYPES.LOW_PROBABILITY_OUTCOME_OCCURRED, 150);
      }
    }

    // 1. Model Overconfidence & Underconfidence rules
    if (forecastError > 0.4 && forecast > 0.85) {
      detected.set(ERROR_TYPES.OVERCONFIDENT_MODEL, ERROR_PRIORITY_WEIGHTS.OVERCONFIDENT_MODEL + (forecastError * 10));
    } else if (forecastError > 0.4 && forecast < 0.15) {
      detected.set(ERROR_TYPES.UNDERCONFIDENT_MODEL, ERROR_PRIORITY_WEIGHTS.UNDERCONFIDENT_MODEL + (forecastError * 10));
    } else if (forecastError > 0.4 && forecast > 0.7 && !detected.has(ERROR_TYPES.LOW_PROBABILITY_OUTCOME_OCCURRED)) {
      detected.set(ERROR_TYPES.OVERCONFIDENT_MODEL, ERROR_PRIORITY_WEIGHTS.OVERCONFIDENT_MODEL + (forecastError * 10));
    } else if (forecastError > 0.4 && forecast < 0.3 && !detected.has(ERROR_TYPES.LOW_PROBABILITY_OUTCOME_OCCURRED)) {
      detected.set(ERROR_TYPES.UNDERCONFIDENT_MODEL, ERROR_PRIORITY_WEIGHTS.UNDERCONFIDENT_MODEL + (forecastError * 10));
    }

    // 2. Evidence Staleness & Veracity rules
    if (hasStaleSource) {
      detected.set(ERROR_TYPES.SOURCE_STALE, ERROR_PRIORITY_WEIGHTS.SOURCE_STALE);
    }
    if (hasFalseSource) {
      detected.set(ERROR_TYPES.SOURCE_FALSE, ERROR_PRIORITY_WEIGHTS.SOURCE_FALSE);
    }
    if (hasInsufficientEvidence) {
      detected.set(ERROR_TYPES.INSUFFICIENT_EVIDENCE, ERROR_PRIORITY_WEIGHTS.INSUFFICIENT_EVIDENCE);
    }

    // 3. Contract & Resolution Ambiguity rules
    if (episode.resolutionAmbiguity || episode.isDisputed || episode.unclearOutcome || episode.resolutionDisputed) {
      detected.set(ERROR_TYPES.RESOLUTION_AMBIGUITY, ERROR_PRIORITY_WEIGHTS.RESOLUTION_AMBIGUITY);
    }
    if (episode.contractMisread || episode.rulesMisunderstood || episode.contractAmbiguity) {
      detected.set(ERROR_TYPES.CONTRACT_MISREAD, ERROR_PRIORITY_WEIGHTS.CONTRACT_MISREAD);
    }

    // 4. Market Timing & Execution rules
    if (episode.marketAlreadyRepriced || episode.repricedBeforeExecution || (marketComparison.marketWasBetter && episode.priceMovedPreFill)) {
      detected.set(ERROR_TYPES.MARKET_ALREADY_REPRICED, ERROR_PRIORITY_WEIGHTS.MARKET_ALREADY_REPRICED);
    }
    if (episode.executionTooSlow || episode.timingGapAdverseFill || (typeof episode.latencyMs === 'number' && episode.latencyMs > 5000)) {
      detected.set(ERROR_TYPES.EXECUTION_TOO_SLOW, ERROR_PRIORITY_WEIGHTS.EXECUTION_TOO_SLOW);
    }

    // 5. Causal & Logical Relations rules
    if (episode.logicalRelationWrong || episode.causalAssumptionFailed || episode.correlationalAssumptionFailed) {
      detected.set(ERROR_TYPES.LOGICAL_RELATION_WRONG, ERROR_PRIORITY_WEIGHTS.LOGICAL_RELATION_WRONG);
    }

    // 6. Regime Shift & Cluster Risk rules
    if (episode.regimeShift || (episode.regimeAtDecision && episode.regimeAtResolution && episode.regimeAtDecision !== episode.regimeAtResolution)) {
      detected.set(ERROR_TYPES.REGIME_SHIFT, ERROR_PRIORITY_WEIGHTS.REGIME_SHIFT);
    }
    if (episode.clusterRiskTooHigh || episode.correlatedLossAmplified || (typeof episode.clusterCorrelation === 'number' && episode.clusterCorrelation > 0.8)) {
      detected.set(ERROR_TYPES.CLUSTER_RISK_TOO_HIGH, ERROR_PRIORITY_WEIGHTS.CLUSTER_RISK_TOO_HIGH);
    }

    // Fallback: If no explicit error detected but error is high, deduce based on bias
    if (detected.size === 0) {
      if (forecastError > 0.4) {
        if (forecast >= 0.5) {
          detected.set(ERROR_TYPES.OVERCONFIDENT_MODEL, ERROR_PRIORITY_WEIGHTS.OVERCONFIDENT_MODEL);
        } else {
          detected.set(ERROR_TYPES.UNDERCONFIDENT_MODEL, ERROR_PRIORITY_WEIGHTS.UNDERCONFIDENT_MODEL);
        }
      } else if (forecastError > 0.25) {
        detected.set(
          forecast >= outcome ? ERROR_TYPES.OVERCONFIDENT_MODEL : ERROR_TYPES.UNDERCONFIDENT_MODEL,
          40
        );
      } else {
        // Low error episode
        detected.set(ERROR_TYPES.INSUFFICIENT_EVIDENCE, 10);
      }
    }

    // Sort detected errors by priority weight
    const sortedErrors = Array.from(detected.entries()).sort((a, b) => b[1] - a[1]);
    const primaryError = sortedErrors[0][0];
    const secondaryErrors = sortedErrors.slice(1).map(entry => entry[0]);

    return {
      primaryError,
      secondaryErrors
    };
  }

  /**
   * Generates actionable improvement lessons for diagnosed errors.
   * @private
   * @param {string} primaryError
   * @param {string[]} secondaryErrors
   * @param {Object} episode
   * @returns {string[]}
   */
  _extractLessons(primaryError, secondaryErrors = [], episode = {}) {
    const lessons = new Set();

    if (ERROR_LESSON_CATALOG[primaryError]) {
      lessons.add(ERROR_LESSON_CATALOG[primaryError]);
    }

    for (const secErr of secondaryErrors) {
      if (ERROR_LESSON_CATALOG[secErr]) {
        lessons.add(ERROR_LESSON_CATALOG[secErr]);
      }
    }

    // Context-specific custom lessons
    if (episode.symbol && (primaryError === ERROR_TYPES.OVERCONFIDENT_MODEL || primaryError === ERROR_TYPES.UNDERCONFIDENT_MODEL)) {
      lessons.add(`Re-calibrate historical base rates for ${episode.symbol} across varying volatility regimes.`);
    }

    return Array.from(lessons);
  }

  /**
   * Produces a human-readable postmortem summary of why the prediction failed.
   * 
   * @param {Object} episode - The trading episode object.
   * @param {number|boolean} outcome - The resolution outcome (0 or 1).
   * @param {Object} [diagnosticContext] - Optional pre-computed context.
   * @returns {string} Human-readable postmortem string.
   */
  generatePostmortem(episode = {}, outcome, diagnosticContext = null) {
    const epId = episode.episodeId || episode.id || 'N/A';
    const symbol = episode.symbol || episode.market || episode.eventClass || 'Unknown Asset';
    const normOutcome = (outcome === 1 || outcome === true || outcome === '1' || outcome === 'YES') ? 1 : 0;

    let ctx = diagnosticContext;
    if (!ctx) {
      const forecast = typeof episode.forecast === 'number' ? episode.forecast : 0.5;
      const brierScore = Number(Math.pow(forecast - normOutcome, 2).toFixed(6));
      const sourceAnalysis = this._analyzeSources(episode, normOutcome);
      const marketComparison = this._analyzeMarketComparison(episode, normOutcome, forecast);
      const agentErrors = this._analyzeAgentErrors(episode, normOutcome);
      const { primaryError, secondaryErrors } = this._classifyErrors({
        episode,
        forecast,
        outcome: normOutcome,
        forecastError: Math.abs(forecast - normOutcome),
        hasStaleSource: sourceAnalysis.some(s => s.wasStale),
        hasFalseSource: sourceAnalysis.some(s => !s.wasAccurate),
        hasInsufficientEvidence: sourceAnalysis.length < 2,
        marketComparison,
        agentErrors
      });
      const lessons = this._extractLessons(primaryError, secondaryErrors, episode);
      ctx = {
        forecast,
        brierScore,
        primaryError,
        secondaryErrors,
        sourceAnalysis,
        marketComparison,
        agentErrors,
        lessons,
        similarPastErrors: []
      };
    }

    const lines = [];
    lines.push(`======================================================================`);
    lines.push(`ORACLE POSTMORTEM REPORT: Episode ${epId} [${symbol}]`);
    lines.push(`======================================================================`);
    lines.push(`Outcome: ${normOutcome} | Model Forecast: ${(ctx.forecast * 100).toFixed(1)}% | Brier Score: ${ctx.brierScore}`);
    lines.push(`Primary Diagnosis: [${ctx.primaryError}]`);

    if (ctx.secondaryErrors && ctx.secondaryErrors.length > 0) {
      lines.push(`Secondary Factors: ${ctx.secondaryErrors.map(e => `[${e}]`).join(', ')}`);
    }

    // Market comparison summary
    if (ctx.marketComparison && ctx.marketComparison.marketPrice !== null) {
      const mktPct = (ctx.marketComparison.marketPrice * 100).toFixed(1);
      if (ctx.marketComparison.marketWasBetter) {
        lines.push(`Market Efficiency: Prevailing market price (${mktPct}%) was CLOSER to outcome than model forecast.`);
      } else {
        lines.push(`Market Efficiency: Model forecast outperformed prevailing market price (${mktPct}%).`);
      }
    }

    // Evidence analysis summary
    if (ctx.sourceAnalysis && ctx.sourceAnalysis.length > 0) {
      lines.push(`Evidence Sources Evaluated (${ctx.sourceAnalysis.length}):`);
      for (const src of ctx.sourceAnalysis) {
        const staleNote = src.wasStale ? ` [STALE: ${Math.round(src.ageAtDecisionSec / 3600)}h old]` : '';
        const accNote = !src.wasAccurate ? ' [INACCURATE]' : ' [VERIFIED]';
        lines.push(`  - ${src.source}: Age=${src.ageAtDecisionSec}s${staleNote}${accNote}`);
      }
    } else {
      lines.push(`Evidence Sources: No explicit evidence sources recorded at decision time.`);
    }

    // Agent voting breakdown
    if (ctx.agentErrors && Object.keys(ctx.agentErrors).length > 0) {
      lines.push(`Agent Breakdown:`);
      for (const [agent, data] of Object.entries(ctx.agentErrors)) {
        lines.push(`  - ${agent}: Forecast=${(data.forecast * 100).toFixed(1)}%, Error=${data.error.toFixed(4)} (${data.errorType})`);
      }
    }

    // Actionable lessons
    if (ctx.lessons && ctx.lessons.length > 0) {
      lines.push(`Key Actionable Lessons:`);
      ctx.lessons.forEach((lesson, idx) => {
        lines.push(`  ${idx + 1}. ${lesson}`);
      });
    }

    // Similar past errors
    if (ctx.similarPastErrors && ctx.similarPastErrors.length > 0) {
      lines.push(`Recurring Pattern Linkages: Similar failure modes in episodes [${ctx.similarPastErrors.join(', ')}]`);
    }

    lines.push(`======================================================================`);
    return lines.join('\n');
  }

  /**
   * Finds past attributions that exhibit a matching or similar error pattern.
   * 
   * @param {Object} attribution - The target attribution object.
   * @param {number} [limit=5] - Maximum number of similar episodes to return.
   * @returns {string[]} Array of similar episode IDs.
   */
  findSimilarErrors(attribution, limit = 5) {
    if (!attribution || !attribution.primaryError) {
      return [];
    }

    const currentEpisodeId = attribution.episodeId;
    const currentPrimary = attribution.primaryError;
    const currentSecondaries = new Set(attribution.secondaryErrors || []);
    const currentForecast = typeof attribution.forecast === 'number' ? attribution.forecast : 0.5;
    const currentClass = attribution.eventClass || 'DEFAULT';

    const scored = [];

    for (const [id, past] of this.attributions.entries()) {
      if (past.episodeId === currentEpisodeId) continue;

      let score = 0;

      // 1. Primary error match is the strongest signal
      if (past.primaryError === currentPrimary) {
        score += 50;
      }

      // 2. Secondary error intersections
      if (Array.isArray(past.secondaryErrors)) {
        for (const sec of past.secondaryErrors) {
          if (currentSecondaries.has(sec)) {
            score += 15;
          }
          if (sec === currentPrimary) {
            score += 10;
          }
        }
      }

      // 3. Event class / asset class match
      if (past.eventClass && past.eventClass === currentClass) {
        score += 15;
      }

      // 4. Forecast proximity match
      const forecastDelta = Math.abs((past.forecast || 0.5) - currentForecast);
      score += Math.max(0, 10 - (forecastDelta * 10));

      // 5. Ground truth outcome alignment
      if (past.outcome === attribution.outcome) {
        score += 10;
      }

      if (score >= 30) {
        scored.push({
          episodeId: past.episodeId,
          score,
          timestamp: past.timestamp
        });
      }
    }

    // Sort descending by similarity score, then newest first
    scored.sort((a, b) => b.score - a.score || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return scored.slice(0, limit).map(item => item.episodeId);
  }

  /**
   * Returns the most common error types across past attributions, optionally filtered by eventClass.
   * 
   * @param {string} [eventClass] - Optional event class / category filter.
   * @param {number} [limit=20] - Maximum pattern items to return.
   * @returns {Array<{ errorType: string, count: number, primaryCount: number, secondaryCount: number, percentage: number, avgBrierScore: number }>}
   */
  getErrorPatterns(eventClass = null, limit = 20) {
    const counts = {};
    const primaryCounts = {};
    const secondaryCounts = {};
    const brierSums = {};

    let totalAttributions = 0;

    for (const attr of this.attributions.values()) {
      if (eventClass && attr.eventClass !== eventClass && attr.symbol !== eventClass) {
        continue;
      }

      totalAttributions++;

      // Track primary error
      const primary = attr.primaryError;
      if (primary) {
        counts[primary] = (counts[primary] || 0) + 1;
        primaryCounts[primary] = (primaryCounts[primary] || 0) + 1;
        brierSums[primary] = (brierSums[primary] || 0) + (attr.brierScore || 0);
      }

      // Track secondary errors
      if (Array.isArray(attr.secondaryErrors)) {
        for (const sec of attr.secondaryErrors) {
          counts[sec] = (counts[sec] || 0) + 1;
          secondaryCounts[sec] = (secondaryCounts[sec] || 0) + 1;
          brierSums[sec] = (brierSums[sec] || 0) + (attr.brierScore || 0);
        }
      }
    }

    if (totalAttributions === 0) {
      return [];
    }

    const patterns = Object.keys(counts).map(errorType => {
      const count = counts[errorType];
      const pCount = primaryCounts[errorType] || 0;
      const sCount = secondaryCounts[errorType] || 0;
      const avgBrier = Number((brierSums[errorType] / count).toFixed(4));
      const percentage = Number(((count / totalAttributions) * 100).toFixed(2));

      return {
        errorType,
        count,
        primaryCount: pCount,
        secondaryCount: sCount,
        percentage,
        avgBrierScore: avgBrier
      };
    });

    // Sort descending by occurrence count
    patterns.sort((a, b) => b.count - a.count);

    return patterns.slice(0, limit);
  }

  /**
   * Returns the error distribution and accuracy profile for a specific agent.
   * 
   * @param {string} agentName - Name of the agent (e.g. 'ARES', 'ATHENA', 'THOTH').
   * @returns {{ agentName: string, totalEvaluated: number, totalErrors: number, meanAbsoluteError: number, accuracyRate: number, errorTypeDistribution: Object.<string, number>, bias: 'OVERESTIMATING' | 'UNDERESTIMATING' | 'NEUTRAL' }}
   */
  getAgentErrorProfile(agentName) {
    if (!agentName) {
      return {
        agentName: 'UNKNOWN',
        totalEvaluated: 0,
        totalErrors: 0,
        meanAbsoluteError: 0,
        accuracyRate: 0,
        errorTypeDistribution: {},
        bias: 'NEUTRAL'
      };
    }

    let totalEvaluated = 0;
    let totalErrors = 0;
    let errorSum = 0;
    let overCount = 0;
    let underCount = 0;
    const errorTypeDistribution = {};

    for (const attr of this.attributions.values()) {
      if (attr.agentErrors && attr.agentErrors[agentName]) {
        const agData = attr.agentErrors[agentName];
        totalEvaluated++;
        errorSum += agData.error;

        if (agData.error > 0.25) {
          totalErrors++;
        }

        const type = agData.errorType || 'UNKNOWN';
        errorTypeDistribution[type] = (errorTypeDistribution[type] || 0) + 1;

        if (agData.forecast > (attr.outcome ?? 0.5)) {
          overCount++;
        } else if (agData.forecast < (attr.outcome ?? 0.5)) {
          underCount++;
        }
      }
    }

    const meanAbsoluteError = totalEvaluated > 0 ? Number((errorSum / totalEvaluated).toFixed(4)) : 0;
    const accuracyRate = totalEvaluated > 0 ? Number((((totalEvaluated - totalErrors) / totalEvaluated) * 100).toFixed(2)) : 0;

    let bias = 'NEUTRAL';
    if (totalEvaluated >= 3) {
      if (overCount > underCount * 1.5) bias = 'OVERESTIMATING';
      else if (underCount > overCount * 1.5) bias = 'UNDERESTIMATING';
    }

    return {
      agentName,
      totalEvaluated,
      totalErrors,
      meanAbsoluteError,
      accuracyRate,
      errorTypeDistribution,
      bias
    };
  }

  /**
   * Generates aggregate statistics across all recorded error attributions.
   * 
   * @returns {{ totalAttributions: number, averageBrierScore: number, marketBetterRatio: number, errorTypeDistribution: Object.<string, number>, primaryErrorDistribution: Object.<string, number>, mostErrorProneAgents: Array<{ agentName: string, totalErrors: number, meanAbsoluteError: number }>, mostCommonLessons: Array<{ lesson: string, count: number }> }}
   */
  getStatistics() {
    const totalAttributions = this.attributions.size;
    if (totalAttributions === 0) {
      return {
        totalAttributions: 0,
        averageBrierScore: 0,
        marketBetterRatio: 0,
        errorTypeDistribution: {},
        primaryErrorDistribution: {},
        mostErrorProneAgents: [],
        mostCommonLessons: []
      };
    }

    let brierSum = 0;
    let marketBetterCount = 0;
    const errorTypeDistribution = {};
    const primaryErrorDistribution = {};
    const lessonCounts = {};
    const agentStats = {};

    for (const attr of this.attributions.values()) {
      brierSum += (attr.brierScore || 0);

      if (attr.marketComparison?.marketWasBetter) {
        marketBetterCount++;
      }

      const pErr = attr.primaryError;
      if (pErr) {
        primaryErrorDistribution[pErr] = (primaryErrorDistribution[pErr] || 0) + 1;
        errorTypeDistribution[pErr] = (errorTypeDistribution[pErr] || 0) + 1;
      }

      if (Array.isArray(attr.secondaryErrors)) {
        for (const sErr of attr.secondaryErrors) {
          errorTypeDistribution[sErr] = (errorTypeDistribution[sErr] || 0) + 1;
        }
      }

      if (Array.isArray(attr.lessons)) {
        for (const lesson of attr.lessons) {
          lessonCounts[lesson] = (lessonCounts[lesson] || 0) + 1;
        }
      }

      if (attr.agentErrors && typeof attr.agentErrors === 'object') {
        for (const [agName, agData] of Object.entries(attr.agentErrors)) {
          if (!agentStats[agName]) {
            agentStats[agName] = { count: 0, errorCount: 0, totalError: 0 };
          }
          agentStats[agName].count++;
          agentStats[agName].totalError += agData.error;
          if (agData.error > 0.25) {
            agentStats[agName].errorCount++;
          }
        }
      }
    }

    const averageBrierScore = Number((brierSum / totalAttributions).toFixed(4));
    const marketBetterRatio = Number((marketBetterCount / totalAttributions).toFixed(4));

    const mostErrorProneAgents = Object.keys(agentStats).map(agName => ({
      agentName: agName,
      totalErrors: agentStats[agName].errorCount,
      meanAbsoluteError: Number((agentStats[agName].totalError / agentStats[agName].count).toFixed(4)),
      totalEvaluations: agentStats[agName].count
    })).sort((a, b) => b.totalErrors - a.totalErrors || b.meanAbsoluteError - a.meanAbsoluteError);

    const mostCommonLessons = Object.keys(lessonCounts).map(lesson => ({
      lesson,
      count: lessonCounts[lesson]
    })).sort((a, b) => b.count - a.count).slice(0, 10);

    return {
      totalAttributions,
      averageBrierScore,
      marketBetterRatio,
      errorTypeDistribution,
      primaryErrorDistribution,
      mostErrorProneAgents,
      mostCommonLessons
    };
  }

  /**
   * Retrieves an attribution by its attribution ID or episode ID.
   * @param {string} id
   * @returns {Object|null}
   */
  getAttribution(id) {
    if (!id) return null;
    if (this.attributions.has(id)) {
      return this.attributions.get(id);
    }
    const mappedAttrId = this.episodeIndex.get(id);
    if (mappedAttrId && this.attributions.has(mappedAttrId)) {
      return this.attributions.get(mappedAttrId);
    }
    return null;
  }

  /**
   * Clears in-memory records and flushes persistence (primarily for unit tests).
   */
  clear() {
    this.attributions.clear();
    this.episodeIndex.clear();
    if (this.db && this.persistenceMode === 'SQLITE_PRIMARY') {
      try {
        this.db.exec(`DELETE FROM oracle_error_attributions;`);
      } catch (_) {}
    }
    this._persistToJson();
  }
}

// Singleton instance
const errorAttributionEngine = new ErrorAttributionEngine();

module.exports = {
  ERROR_TYPES,
  ErrorAttributionEngine,
  errorAttributionEngine
};
