/**
 * @file modelRegistry.js
 * @module intelligence/oracle/modelRegistry
 * @description Model Registry for Trading Brain's ORACLE Intelligence Layer.
 * Tracks and persists all prediction and forecasting models (Champions, Challengers,
 * and Retired) along with their agent weighting configurations, calibration methods,
 * empirical performance telemetry, and full audit lifecycle histories.
 * 
 * Governance Notice:
 * ORACLE modules observe, score, learn, and propose.
 * They may NOT modify live execution, risk caps, or historical records.
 * Model promotion requires passing validation gates before assuming Champion status.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('ModelRegistry');

/**
 * Model Type Classification Enum
 * @readonly
 * @enum {string}
 */
const MODEL_TYPES = Object.freeze({
  CHAMPION: 'CHAMPION',
  CHALLENGER: 'CHALLENGER',
  RETIRED: 'RETIRED'
});

/**
 * Model Lifecycle Event Enum
 * @readonly
 * @enum {string}
 */
const LIFECYCLE_EVENTS = Object.freeze({
  CREATED: 'CREATED',
  VALIDATED: 'VALIDATED',
  PROMOTED: 'PROMOTED',
  RETIRED: 'RETIRED'
});

/**
 * @typedef {Object} ModelConfig
 * @property {Object.<string, number>} agentWeights - Agent voting weight map (e.g. { macroAgent: 0.4, politicalAgent: 0.6 })
 * @property {string} calibrationMethod - Calibration technique (e.g. 'ISOTONIC_PAVA', 'TEMPERATURE_SCALING', 'PLATT_SCALING', 'NONE')
 * @property {string} ensembleMethod - Consensus aggregation method (e.g. 'WEIGHTED_AVERAGE', 'BAYESIAN_MODEL_AVERAGING', 'DYNAMIC_REGIME_ENSEMBLE')
 * @property {Object} [hyperparameters] - Optional model tuning parameters
 */

/**
 * @typedef {Object} ModelPerformance
 * @property {number|null} brierScore - Mean Brier score (lower is better, [0, 1])
 * @property {number|null} logLoss - Cross-entropy loss (lower is better)
 * @property {number|null} ece - Expected Calibration Error
 * @property {number} sampleSize - Total evaluated predictions/episodes
 * @property {string|null} evaluatedAt - ISO 8601 timestamp of last evaluation
 * @property {number} [directionalAccuracy] - Empirical win rate / directional hit rate
 * @property {number} [mce] - Maximum Calibration Error
 */

/**
 * @typedef {Object} LifecycleEvent
 * @property {'CREATED' | 'VALIDATED' | 'PROMOTED' | 'RETIRED'} event - Lifecycle transition event
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string|Object} details - Explanatory context, validation report, or promotion audit trail
 */

/**
 * @typedef {Object} ModelEntry
 * @property {string} modelId - Unique identifier (e.g. 'mod_1787918517581_challenger_v1')
 * @property {string} version - Semantic version string (e.g. '1.0.0')
 * @property {'CHAMPION' | 'CHALLENGER' | 'RETIRED'} type - Active status
 * @property {ModelConfig} config - Model structural configuration
 * @property {ModelPerformance} performance - Statistical telemetry metrics
 * @property {LifecycleEvent[]} lifecycle - Chronological audit trail of status changes
 * @property {string} createdAt - ISO 8601 creation timestamp
 */

/**
 * Safely writes data to a JSON file atomically using a temporary staging file.
 * Handles cross-platform file locking edge cases.
 * 
 * @param {string} filePath - Target file path
 * @param {any} data - Data to serialize
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
 * ModelRegistry Class
 * Manages champion and challenger forecast models, configuration persistence,
 * validation enforcement, and promotion governance.
 */
class ModelRegistry {
  /**
   * @param {Object} [options={}] - Registry options
   * @param {string} [options.storagePath] - Path to JSON persistence file
   * @param {string} [options.dbPath] - Path to SQLite database file
   * @param {boolean} [options.useSqlite=true] - Attempt SQLite initialization if available
   */
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.join(
      process.cwd(),
      'data',
      'oracle',
      'model_registry.json'
    );

    this.dbPath = options.dbPath || path.join(
      process.cwd(),
      'data',
      'trading_brain.db'
    );

    this.useSqlite = options.useSqlite !== false;

    /** @type {Map<string, ModelEntry>} In-memory store: modelId -> ModelEntry */
    this.models = new Map();

    /** @type {any|null} SQLite Database instance if initialized */
    this.db = null;

    /** @type {'SQLITE_PRIMARY' | 'JSON_FALLBACK'} */
    this.persistenceBackend = 'JSON_FALLBACK';

    this._initializeStorage();
    this._loadAll();
  }

  /**
   * Initializes SQLite connection and tables if better-sqlite3 is available,
   * falling back cleanly to JSON persistence.
   * @private
   */
  _initializeStorage() {
    // Ensure parent directories exist
    const jsonDir = path.dirname(this.storagePath);
    if (!fs.existsSync(jsonDir)) {
      fs.mkdirSync(jsonDir, { recursive: true });
    }

    if (this.useSqlite) {
      try {
        const Database = require('better-sqlite3');
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }

        this.db = new Database(this.dbPath, { timeout: 5000 });
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

        // Create table for model entries
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS oracle_model_registry (
            model_id TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            type TEXT NOT NULL,
            config_json TEXT NOT NULL,
            performance_json TEXT NOT NULL,
            lifecycle_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_oracle_models_type ON oracle_model_registry(type);
        `);

        this.persistenceBackend = 'SQLITE_PRIMARY';
        logger.info(`[ModelRegistry] SQLite storage initialized successfully at: ${this.dbPath}`);
      } catch (sqliteErr) {
        this.db = null;
        this.persistenceBackend = 'JSON_FALLBACK';
        logger.warn(`[ModelRegistry] SQLite initialization bypassed (${sqliteErr.message}). Using JSON storage at: ${this.storagePath}`);
      }
    }
  }

  /**
   * Loads all model entries from persistent storage into the in-memory cache.
   * Prioritizes SQLite if active, with automatic fallback and JSON synchronization.
   * @private
   */
  _loadAll() {
    this.models.clear();

    // 1. Try loading from SQLite
    if (this.db && this.persistenceBackend === 'SQLITE_PRIMARY') {
      try {
        const rows = this.db.prepare('SELECT * FROM oracle_model_registry ORDER BY created_at ASC').all();
        if (rows && rows.length > 0) {
          for (const row of rows) {
            const entry = {
              modelId: row.model_id,
              version: row.version,
              type: row.type,
              config: JSON.parse(row.config_json || '{}'),
              performance: JSON.parse(row.performance_json || '{}'),
              lifecycle: JSON.parse(row.lifecycle_json || '[]'),
              createdAt: row.created_at
            };
            this.models.set(entry.modelId, entry);
          }
          logger.info(`[ModelRegistry] Loaded ${this.models.size} models from SQLite`);
          this._syncToJsonFile();
          return;
        }
      } catch (err) {
        logger.warn(`[ModelRegistry] SQLite load error: ${err.message}. Falling back to JSON`);
      }
    }

    // 2. Load from JSON file if SQLite was empty or failed
    if (fs.existsSync(this.storagePath)) {
      try {
        const content = fs.readFileSync(this.storagePath, 'utf8');
        const list = JSON.parse(content);
        if (Array.isArray(list)) {
          for (const entry of list) {
            if (entry && entry.modelId) {
              this.models.set(entry.modelId, entry);
              // Mirror into SQLite if available
              if (this.db) {
                this._persistModelToSqlite(entry);
              }
            }
          }
          logger.info(`[ModelRegistry] Loaded ${this.models.size} models from JSON file`);
        }
      } catch (err) {
        logger.error(`[ModelRegistry] Failed to parse JSON file at ${this.storagePath}: ${err.message}`);
      }
    }
  }

  /**
   * Persists a single model entry to SQLite if active.
   * @param {ModelEntry} model 
   * @private
   */
  _persistModelToSqlite(model) {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO oracle_model_registry (
          model_id, version, type, config_json, performance_json, lifecycle_json, created_at, updated_at
        ) VALUES (
          @model_id, @version, @type, @config_json, @performance_json, @lifecycle_json, @created_at, @updated_at
        )
        ON CONFLICT(model_id) DO UPDATE SET
          version = excluded.version,
          type = excluded.type,
          config_json = excluded.config_json,
          performance_json = excluded.performance_json,
          lifecycle_json = excluded.lifecycle_json,
          updated_at = excluded.updated_at
      `);

      stmt.run({
        model_id: model.modelId,
        version: model.version,
        type: model.type,
        config_json: JSON.stringify(model.config || {}),
        performance_json: JSON.stringify(model.performance || {}),
        lifecycle_json: JSON.stringify(model.lifecycle || []),
        created_at: model.createdAt,
        updated_at: new Date().toISOString()
      });
    } catch (err) {
      logger.error(`[ModelRegistry] Failed to persist model ${model.modelId} to SQLite: ${err.message}`);
    }
  }

  /**
   * Synchronizes the complete model registry to the canonical JSON file.
   * @private
   */
  _syncToJsonFile() {
    try {
      const allEntries = Array.from(this.models.values());
      atomicWriteJsonSync(this.storagePath, allEntries);
    } catch (err) {
      logger.error(`[ModelRegistry] Failed to sync models to JSON file: ${err.message}`);
    }
  }

  /**
   * Persists a single updated model to both SQLite and JSON file.
   * @param {ModelEntry} model 
   * @private
   */
  _persist(model) {
    if (this.db) {
      this._persistModelToSqlite(model);
    }
    this._syncToJsonFile();
  }

  /**
   * Generates a unique model identifier.
   * 
   * @param {string} [type='CHALLENGER'] - Model type prefix
   * @returns {string} Formatted model ID (e.g. 'mod_1787918517581_a8f2')
   * @private
   */
  _generateModelId(type = 'CHALLENGER') {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(2).toString('hex');
    const prefix = type.toLowerCase().slice(0, 5);
    return `mod_${timestamp}_${prefix}_${nonce}`;
  }

  /**
   * Compute a SHA-256 hash of model configuration for immutability verification.
   * Used to detect drift: if parameterHash changes, a new version must be created.
   * @param {ModelConfig} config
   * @returns {string} SHA-256 hex digest
   * @private
   */
  _computeParameterHash(config) {
    const sortObject = (obj) => {
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
      return Object.keys(obj).sort().reduce((acc, key) => {
        acc[key] = sortObject(obj[key]);
        return acc;
      }, {});
    };
    const canonical = JSON.stringify(sortObject(config));
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  /**
   * Registers a new model configuration into the registry.
   * 
   * @param {ModelConfig} config - Model configuration (agent weights, calibration, ensemble method)
   * @param {'CHAMPION' | 'CHALLENGER' | 'RETIRED'} [type='CHALLENGER'] - Model classification
   * @param {Object} [options={}] - Additional registration options
   * @param {string} [options.modelId] - Custom model identifier (optional)
   * @param {string} [options.version='1.0.0'] - Model version string
   * @param {string} [options.description] - Creation notes or hypothesis origin
   * @param {boolean} [options.forceChampion=false] - Force champion replacement if type is CHAMPION
   * @returns {ModelEntry} The registered model entry
   */
  registerModel(config, type = MODEL_TYPES.CHALLENGER, options = {}) {
    if (!config || typeof config !== 'object') {
      throw new Error('[ModelRegistry] Invalid model registration: "config" must be an object');
    }

    const modelType = Object.values(MODEL_TYPES).includes(type) ? type : MODEL_TYPES.CHALLENGER;
    const modelId = options.modelId || this._generateModelId(modelType);
    const version = options.version || '1.0.0';
    const now = new Date().toISOString();

    // Default configuration structure
    const sanitizedConfig = {
      agentWeights: config.agentWeights && typeof config.agentWeights === 'object' ? { ...config.agentWeights } : {},
      calibrationMethod: typeof config.calibrationMethod === 'string' ? config.calibrationMethod : 'ISOTONIC_PAVA',
      ensembleMethod: typeof config.ensembleMethod === 'string' ? config.ensembleMethod : 'WEIGHTED_AVERAGE',
      ...(config.hyperparameters ? { hyperparameters: { ...config.hyperparameters } } : {})
    };

    // Default initial performance metrics
    const initialPerformance = {
      brierScore: null,
      logLoss: null,
      ece: null,
      sampleSize: 0,
      evaluatedAt: null
    };

    // Initialize lifecycle audit trail
    const creationDetails = options.description || `Registered new ${modelType} model with version ${version}`;
    const lifecycle = [
      {
        event: LIFECYCLE_EVENTS.CREATED,
        timestamp: now,
        details: creationDetails
      }
    ];

    // If registering as CHAMPION, handle existing champion retirement
    if (modelType === MODEL_TYPES.CHAMPION) {
      const existingChampion = this.getChampion();
      if (existingChampion && existingChampion.modelId !== modelId) {
        if (options.forceChampion || this.models.size === 0) {
          existingChampion.type = MODEL_TYPES.RETIRED;
          existingChampion.lifecycle.push({
            event: LIFECYCLE_EVENTS.RETIRED,
            timestamp: now,
            details: `Retired and replaced by newly registered champion ${modelId}`
          });
          this._persist(existingChampion);
          logger.info(`[ModelRegistry] Existing champion ${existingChampion.modelId} retired for new champion ${modelId}`);
        } else {
          logger.warn(`[ModelRegistry] A Champion (${existingChampion.modelId}) already exists. Registering ${modelId} as CHALLENGER instead.`);
          return this.registerModel(config, MODEL_TYPES.CHALLENGER, options);
        }
      }
    }

    /** @type {ModelEntry} */
    const modelEntry = {
      modelId,
      version,
      type: modelType,
      config: sanitizedConfig,
      performance: initialPerformance,
      lifecycle,
      createdAt: now,
      // Versioned lineage — every learned update creates a new version with these fields
      parentVersion: options.parentVersion || null,         // modelId of the model this was derived from
      trainingCutoff: options.trainingCutoff || now,        // ISO8601 — no observation after this date was used
      observationSetHash: options.observationSetHash || null, // SHA-256 of the observation set used for training
      parameterHash: this._computeParameterHash(sanitizedConfig) // SHA-256 of config for drift detection
    };

    this.models.set(modelId, modelEntry);
    this._persist(modelEntry);

    logger.info(`[ModelRegistry] Registered model "${modelId}" (${modelType}, v${version})`);
    return modelEntry;
  }

  /**
   * Retrieves the current active CHAMPION model.
   * 
   * @returns {ModelEntry|null} Current champion model or null if none registered
   */
  getChampion() {
    for (const model of this.models.values()) {
      if (model.type === MODEL_TYPES.CHAMPION) {
        return model;
      }
    }
    return null;
  }

  /**
   * Retrieves all active CHALLENGER models.
   * 
   * @returns {ModelEntry[]} Array of active challengers
   */
  getChallengers() {
    const challengers = [];
    for (const model of this.models.values()) {
      if (model.type === MODEL_TYPES.CHALLENGER) {
        challengers.push(model);
      }
    }
    return challengers;
  }

  /**
   * Retrieves a model by its unique identifier.
   * 
   * @param {string} modelId 
   * @returns {ModelEntry|null}
   */
  getModel(modelId) {
    return this.models.get(modelId) || null;
  }

  /**
   * Updates performance statistics for a specific model.
   * 
   * @param {string} modelId - Model ID to update
   * @param {Object} metrics - Performance metrics
   * @param {number} [metrics.brierScore] - Updated Brier score
   * @param {number} [metrics.logLoss] - Updated Log loss
   * @param {number} [metrics.ece] - Expected Calibration Error
   * @param {number} [metrics.sampleSize] - Total evaluations
   * @param {string} [metrics.evaluatedAt] - ISO 8601 timestamp
   * @param {number} [metrics.directionalAccuracy] - Directional hit rate
   * @returns {ModelEntry} Updated model entry
   */
  updatePerformance(modelId, metrics) {
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`[ModelRegistry] Cannot update performance: Model "${modelId}" not found`);
    }

    if (!metrics || typeof metrics !== 'object') {
      throw new Error('[ModelRegistry] Performance metrics must be an object');
    }

    const now = metrics.evaluatedAt || new Date().toISOString();

    model.performance = {
      brierScore: typeof metrics.brierScore === 'number' ? Number(metrics.brierScore.toFixed(6)) : model.performance.brierScore,
      logLoss: typeof metrics.logLoss === 'number' ? Number(metrics.logLoss.toFixed(6)) : model.performance.logLoss,
      ece: typeof metrics.ece === 'number' ? Number(metrics.ece.toFixed(6)) : model.performance.ece,
      sampleSize: typeof metrics.sampleSize === 'number' ? metrics.sampleSize : (model.performance.sampleSize || 0),
      evaluatedAt: now,
      ...(typeof metrics.directionalAccuracy === 'number' ? { directionalAccuracy: Number(metrics.directionalAccuracy.toFixed(4)) } : {}),
      ...(typeof metrics.mce === 'number' ? { mce: Number(metrics.mce.toFixed(4)) } : {})
    };

    this._persist(model);
    logger.info(`[ModelRegistry] Updated performance for model "${modelId}" (Brier: ${model.performance.brierScore}, Samples: ${model.performance.sampleSize})`);
    return model;
  }

  /**
   * Marks a model as VALIDATED after passing out-of-sample statistical testing.
   * Governance prerequisite for champion promotion.
   * 
   * @param {string} modelId - Model ID to validate
   * @param {string|Object} [details] - Validation report or benchmark summary
   * @returns {ModelEntry} The validated model entry
   */
  validateModel(modelId, details = null) {
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`[ModelRegistry] Cannot validate: Model "${modelId}" not found`);
    }

    const now = new Date().toISOString();
    const validationDetails = details || 'Passed statistical out-of-sample validation tests against historical benchmark';

    model.lifecycle.push({
      event: LIFECYCLE_EVENTS.VALIDATED,
      timestamp: now,
      details: validationDetails
    });

    this._persist(model);
    logger.info(`[ModelRegistry] Model "${modelId}" marked as VALIDATED`);
    return model;
  }

  /**
   * Promotes an active challenger model to CHAMPION.
   * 
   * Governance Rules:
   * 1. Logs promotion event and audit rationale.
   * 2. REQUIRES that the target challenger has a 'VALIDATED' lifecycle status.
   * 3. Retires the existing champion and records its retirement event.
   * 
   * @param {string} modelId - Challenger model ID to promote
   * @param {string|Object} [details] - Audit justification or performance comparison
   * @returns {ModelEntry} The newly promoted champion model
   */
  promoteToChampion(modelId, details = null) {
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`[ModelRegistry] Promotion failed: Model "${modelId}" not found`);
    }

    if (model.type === MODEL_TYPES.CHAMPION) {
      logger.info(`[ModelRegistry] Model "${modelId}" is already the active CHAMPION`);
      return model;
    }

    // Governance Check: Must have a VALIDATED lifecycle event
    const isValidated = model.lifecycle.some(eventObj => eventObj.event === LIFECYCLE_EVENTS.VALIDATED);
    if (!isValidated) {
      const errMsg = `Governance Violation: Cannot promote model "${modelId}" to CHAMPION. Challenger must pass the VALIDATED stage before promotion.`;
      logger.warn(`[ModelRegistry] ${errMsg}`);
      throw new Error(errMsg);
    }

    const now = new Date().toISOString();
    const promotionAudit = details || `Promoted challenger to CHAMPION after outperforming previous champion (Brier: ${model.performance.brierScore ?? 'N/A'})`;

    // 1. Retire existing champion
    const currentChampion = this.getChampion();
    if (currentChampion && currentChampion.modelId !== modelId) {
      currentChampion.type = MODEL_TYPES.RETIRED;
      currentChampion.lifecycle.push({
        event: LIFECYCLE_EVENTS.RETIRED,
        timestamp: now,
        details: `Retired from CHAMPION; superseded by validated challenger "${modelId}"`
      });
      this._persist(currentChampion);
      logger.info(`[ModelRegistry] Previous champion "${currentChampion.modelId}" has been retired`);
    }

    // 2. Promote target model
    model.type = MODEL_TYPES.CHAMPION;
    model.lifecycle.push({
      event: LIFECYCLE_EVENTS.PROMOTED,
      timestamp: now,
      details: promotionAudit
    });

    this._persist(model);
    logger.info(`[ModelRegistry] SUCCESS: Model "${modelId}" promoted to CHAMPION.`);
    return model;
  }

  /**
   * Retires a model from active challenger or champion rotation.
   * 
   * @param {string} modelId - Model ID to retire
   * @param {string} [reason='Model retired by operator or performance criteria'] - Retirement rationale
   * @returns {ModelEntry} The retired model entry
   */
  retireModel(modelId, reason = 'Model retired by operator or performance criteria') {
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`[ModelRegistry] Cannot retire: Model "${modelId}" not found`);
    }

    if (model.type === MODEL_TYPES.RETIRED) {
      logger.info(`[ModelRegistry] Model "${modelId}" is already retired`);
      return model;
    }

    const now = new Date().toISOString();
    model.type = MODEL_TYPES.RETIRED;
    model.lifecycle.push({
      event: LIFECYCLE_EVENTS.RETIRED,
      timestamp: now,
      details: reason
    });

    this._persist(model);
    logger.info(`[ModelRegistry] Model "${modelId}" retired. Reason: ${reason}`);
    return model;
  }

  /**
   * Retrieves the full lifecycle audit history.
   * If a modelId is specified, returns that model's lifecycle events.
   * If modelId is omitted, returns a flattened, chronologically sorted list
   * of all lifecycle events across all models in the registry.
   * 
   * @param {string} [modelId=null] - Optional model identifier
   * @returns {Array<Object>} Chronological audit history
   */
  getHistory(modelId = null) {
    if (modelId) {
      const model = this.models.get(modelId);
      if (!model) {
        throw new Error(`[ModelRegistry] Cannot get history: Model "${modelId}" not found`);
      }
      return [...model.lifecycle];
    }

    // Flatten all events across models
    const aggregatedHistory = [];
    for (const model of this.models.values()) {
      for (const eventObj of model.lifecycle) {
        aggregatedHistory.push({
          modelId: model.modelId,
          version: model.version,
          modelType: model.type,
          event: eventObj.event,
          timestamp: eventObj.timestamp,
          details: eventObj.details
        });
      }
    }

    // Sort chronologically ascending
    aggregatedHistory.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return aggregatedHistory;
  }

  /**
   * Returns all models currently registered.
   * 
   * @returns {ModelEntry[]} Array of all models
   */
  getAllModels() {
    return Array.from(this.models.values());
  }

  /**
   * Clears in-memory registry and purges storage records (primarily for testing/reset).
   */
  clear() {
    this.models.clear();
    if (this.db) {
      try {
        this.db.exec('DELETE FROM oracle_model_registry');
      } catch (_) {}
    }
    this._syncToJsonFile();
    logger.info('[ModelRegistry] Cleared all models from registry');
  }
}

// Instantiate singleton instance
const modelRegistry = new ModelRegistry();

module.exports = {
  ModelRegistry,
  modelRegistry,
  MODEL_TYPES,
  LIFECYCLE_EVENTS
};
