/**
 * @file calibrationMemory.js
 * @module intelligence/oracle/calibrationMemory
 * @description Online Calibration engine for Trading Brain's ORACLE Intelligence Layer.
 * Maintains calibration buckets and corrects systematic overconfidence/underconfidence
 * using Pool Adjacent Violators Algorithm (PAVA) Isotonic Regression and Piecewise
 * Linear Interpolation, ensuring that a raw forecast of '80%' reflects an empirical ~80% win probability.
 * 
 * Governance Notice:
 * ORACLE modules may observe, score, learn, and propose. They may NOT modify live execution,
 * risk caps, or historical trade ledgers directly.
 */

const fs = require('fs');
const path = require('path');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('CalibrationMemory');

/**
 * @typedef {Object} CalibrationBucket
 * @property {number} bucketIndex - 0-indexed bucket position (0 to 9)
 * @property {[number, number]} bucketRange - Min and max probability boundary [low, high]
 * @property {number} totalPredictions - Total number of forecasts falling in this bucket
 * @property {number} totalPositiveOutcomes - Total number of realized positive/win outcomes
 * @property {number} sumForecasts - Sum of raw forecast probabilities in this bucket
 * @property {number} meanForecast - Average raw forecast probability in this bucket
 * @property {number} observedFrequency - Empirical win rate (positive outcomes / total predictions)
 * @property {number} calibrationError - Absolute error (|meanForecast - observedFrequency|)
 * @property {string|null} lastUpdated - ISO 8601 timestamp of last update
 */

/**
 * @typedef {Object} ReliabilityPoint
 * @property {number} bucketIndex - Bucket index
 * @property {[number, number]} range - [low, high] range
 * @property {string} rangeLabel - Formatted label e.g. "70-80%"
 * @property {number} predicted - Mean predicted probability
 * @property {number} observed - Empirical observed frequency
 * @property {number} count - Sample count in bucket
 * @property {number} calibrationError - Calibration error for bucket
 * @property {number} weight - Relative sample weight across all buckets
 */

/**
 * @typedef {Object} CalibrationReport
 * @property {string} agentName - Agent name or 'ENSEMBLE'
 * @property {number} totalPredictions - Total predictions across all buckets
 * @property {number} totalPositiveOutcomes - Total realized wins
 * @property {number} overallWinRate - Overall empirical win rate
 * @property {number} ece - Expected Calibration Error
 * @property {number} mce - Maximum Calibration Error
 * @property {boolean} isCalibrated - Whether calibrated within threshold and sample size
 * @property {ReliabilityPoint[]} buckets - Per-bucket statistics
 * @property {string} timestamp - ISO 8601 report timestamp
 */

/**
 * CalibrationMemory Class
 * Manages empirical probability calibration tables, isotonic regression curves,
 * and reliability telemetry for individual trading agents and the ensemble consensus.
 */
class CalibrationMemory {
  /**
   * @param {Object} [options={}] - Configuration options
   * @param {string} [options.storagePath] - Path to JSON file storage
   * @param {string} [options.dbPath] - Path to SQLite database
   * @param {number} [options.bucketCount=10] - Number of probability buckets
   * @param {number} [options.minSamplesPerBucket=30] - Minimum samples per bucket for full calibration certification
   * @param {number} [options.eceThreshold=0.05] - ECE threshold for calibration certification
   * @param {number} [options.maxHistory=5000] - Maximum outcome records kept in memory log
   */
  constructor(options = {}) {
    this.bucketCount = options.bucketCount || 10;
    this.minSamplesPerBucket = options.minSamplesPerBucket || 30;
    this.eceThreshold = options.eceThreshold || 0.05;
    this.maxHistory = options.maxHistory || 5000;

    // Primary JSON persistence path
    this.storagePath = options.storagePath || path.join(
      process.cwd(),
      'data',
      'oracle',
      'calibration_memory.json'
    );

    // Primary SQLite DB path
    this.dbPath = options.dbPath || path.join(
      process.cwd(),
      'data',
      'trading_brain.db'
    );

    /** @type {Object.<string, CalibrationBucket[]>} */
    this.calibrationByAgent = {};

    /** @type {CalibrationBucket[]} */
    this.ensembleCalibration = this._createEmptyBuckets();

    /** @type {Array<Object>} */
    this.history = [];

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

      // Initialize SQLite if better-sqlite3 is available
      this._initSqlite();

      // Load existing state from JSON file
      this._loadFromJson();
      
      logger.info(`Initialized CalibrationMemory [Mode: ${this.persistenceMode}] at ${this.storagePath}`);
    } catch (err) {
      logger.error(`Error initializing CalibrationMemory storage: ${err.message}`, { stack: err.stack });
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
        CREATE TABLE IF NOT EXISTS oracle_calibration_records (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          raw_forecast REAL NOT NULL,
          outcome INTEGER NOT NULL,
          bucket_index INTEGER NOT NULL,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_oracle_cal_agent ON oracle_calibration_records(agent_name);
        CREATE INDEX IF NOT EXISTS idx_oracle_cal_time ON oracle_calibration_records(timestamp);
      `);

      this.persistenceMode = 'SQLITE_PRIMARY';
    } catch (err) {
      this.persistenceMode = 'JSON_FALLBACK';
      this.db = null;
      logger.debug(`SQLite unavailable for calibration records (${err.message}), using JSON fallback.`);
    }
  }

  /**
   * Generates a clean set of 10 calibration buckets spanning [0.0, 1.0].
   * @private
   * @returns {CalibrationBucket[]}
   */
  _createEmptyBuckets() {
    const buckets = [];
    const step = 1.0 / this.bucketCount;

    for (let i = 0; i < this.bucketCount; i++) {
      const low = Number((i * step).toFixed(2));
      const high = Number(((i + 1) * step).toFixed(2));
      const mid = Number(((low + high) / 2).toFixed(2));

      buckets.push({
        bucketIndex: i,
        bucketRange: [low, high],
        totalPredictions: 0,
        totalPositiveOutcomes: 0,
        sumForecasts: 0,
        meanForecast: mid,
        observedFrequency: 0.0,
        calibrationError: 0.0,
        lastUpdated: null
      });
    }

    return buckets;
  }

  /**
   * Recomputes meanForecast, observedFrequency, and calibrationError for a bucket.
   * @private
   * @param {CalibrationBucket} bucket
   */
  _updateBucketStats(bucket) {
    const defaultMidpoint = (bucket.bucketRange[0] + bucket.bucketRange[1]) / 2;

    if (bucket.totalPredictions > 0) {
      bucket.meanForecast = bucket.sumForecasts / bucket.totalPredictions;
      bucket.observedFrequency = bucket.totalPositiveOutcomes / bucket.totalPredictions;
      bucket.calibrationError = Math.abs(bucket.meanForecast - bucket.observedFrequency);
    } else {
      bucket.meanForecast = defaultMidpoint;
      bucket.observedFrequency = 0.0;
      bucket.calibrationError = 0.0;
    }

    bucket.lastUpdated = new Date().toISOString();
  }

  /**
   * Maps a raw forecast probability to its corresponding bucket index (0 to 9).
   * @private
   * @param {number} forecast - Raw forecast in [0.0, 1.0]
   * @returns {number} Bucket index (0 to 9)
   */
  _findBucketIndex(forecast) {
    let p = forecast;
    if (typeof p !== 'number' || isNaN(p)) p = 0.5;

    // Handle percentage inputs (e.g. 80 -> 0.80)
    if (p > 1.0 && p <= 100.0) {
      p = p / 100.0;
    }

    // Clamp to [0.0, 1.0]
    p = Math.max(0.0, Math.min(1.0, p));

    let idx = Math.floor(p * this.bucketCount);
    if (idx >= this.bucketCount) idx = this.bucketCount - 1;
    if (idx < 0) idx = 0;
    return idx;
  }

  /**
   * Normalizes an agent name key.
   * @private
   * @param {string} agentName
   * @returns {string}
   */
  _normalizeAgentName(agentName) {
    if (!agentName || typeof agentName !== 'string') return 'UNKNOWN';
    return agentName.trim().toUpperCase();
  }

  /**
   * Records an observed binary outcome for an agent's forecast and persists the update.
   * 
   * @param {string} agentName - Name of the predicting agent (e.g., 'ARES', 'ATHENA')
   * @param {number} rawForecast - Probability forecast between 0.0 and 1.0 (or 0-100)
   * @param {boolean|number|string} outcome - Realized outcome: true/1/'WIN' for positive, false/0/'LOSS' for negative
   * @param {Object} [metadata={}] - Optional context (symbol, tradeId, regime, etc.)
   * @returns {Object} Record summary with updated bucket stats
   */
  recordOutcome(agentName, rawForecast, outcome, metadata = {}) {
    const normAgent = this._normalizeAgentName(agentName);
    
    // Normalize raw forecast
    let p = Number(rawForecast);
    if (isNaN(p)) p = 0.5;
    if (p > 1.0 && p <= 100.0) p = p / 100.0;
    p = Math.max(0.0, Math.min(1.0, p));

    // Normalize binary outcome (1 = positive/win, 0 = negative/loss)
    const isPositive = (
      outcome === true ||
      outcome === 1 ||
      outcome === '1' ||
      outcome === 'WIN' ||
      outcome === 'SUCCESS' ||
      outcome === 'PROFIT'
    ) ? 1 : 0;

    const bucketIdx = this._findBucketIndex(p);

    // Initialize agent bucket array if not present
    if (!this.calibrationByAgent[normAgent]) {
      this.calibrationByAgent[normAgent] = this._createEmptyBuckets();
    }

    // 1. Update Agent-Specific Bucket
    const agentBucket = this.calibrationByAgent[normAgent][bucketIdx];
    agentBucket.totalPredictions += 1;
    if (isPositive === 1) agentBucket.totalPositiveOutcomes += 1;
    agentBucket.sumForecasts += p;
    this._updateBucketStats(agentBucket);

    // 2. Update Aggregate Ensemble Bucket
    const ensembleBucket = this.ensembleCalibration[bucketIdx];
    ensembleBucket.totalPredictions += 1;
    if (isPositive === 1) ensembleBucket.totalPositiveOutcomes += 1;
    ensembleBucket.sumForecasts += p;
    this._updateBucketStats(ensembleBucket);

    // 3. Create historical telemetry record
    const recordId = `cal_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const timestamp = new Date().toISOString();
    const historyEntry = {
      id: recordId,
      timestamp,
      agentName: normAgent,
      rawForecast: p,
      outcome: isPositive,
      bucketIndex: bucketIdx,
      metadata
    };

    this.history.push(historyEntry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // 4. Persist to SQLite if enabled
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO oracle_calibration_records 
          (id, timestamp, agent_name, raw_forecast, outcome, bucket_index, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          recordId,
          timestamp,
          normAgent,
          p,
          isPositive,
          bucketIdx,
          JSON.stringify(metadata)
        );
      } catch (dbErr) {
        logger.warn(`Failed to insert calibration record into SQLite: ${dbErr.message}`);
      }
    }

    // 5. Persist to JSON file
    this._saveToJson();

    logger.debug(`[Calibration] Recorded outcome for ${normAgent}: forecast=${p.toFixed(3)}, outcome=${isPositive}, bucket=${bucketIdx}`);

    return {
      recordId,
      agentName: normAgent,
      rawForecast: p,
      outcome: isPositive,
      bucketIndex: bucketIdx,
      agentBucket: { ...agentBucket },
      ensembleBucket: { ...ensembleBucket }
    };
  }

  /**
   * Applies Pool Adjacent Violators Algorithm (PAVA) to generate monotonically non-decreasing
   * calibrated frequencies across buckets.
   * 
   * @private
   * @param {CalibrationBucket[]} buckets - Array of 10 buckets
   * @returns {Array<{ x: number, y: number, weight: number }>} Monotonic isotonic anchor points
   */
  _runIsotonicRegression(buckets) {
    // 1. Construct initial point array
    const points = buckets.map((b) => {
      const defaultMid = (b.bucketRange[0] + b.bucketRange[1]) / 2;
      const x = b.totalPredictions > 0 ? b.meanForecast : defaultMid;
      const y = b.totalPredictions > 0 ? b.observedFrequency : defaultMid;
      const weight = b.totalPredictions > 0 ? b.totalPredictions : 1; // Prior smoothing weight 1

      return { x, y, weight };
    });

    // Ensure sorted by x
    points.sort((a, b) => a.x - b.x);

    // 2. Initialize blocks for PAVA
    const blocks = points.map((p, idx) => ({
      weight: p.weight,
      sumY: p.weight * p.y,
      value: p.y,
      indices: [idx]
    }));

    // 3. Pool Adjacent Violators Loop
    let i = 0;
    while (i < blocks.length - 1) {
      if (blocks[i].value > blocks[i + 1].value) {
        // Monotonicity violation: merge block i and block i+1
        const b1 = blocks[i];
        const b2 = blocks[i + 1];
        const mergedWeight = b1.weight + b2.weight;
        const mergedSumY = b1.sumY + b2.sumY;
        const mergedValue = mergedWeight > 0 ? mergedSumY / mergedWeight : (b1.value + b2.value) / 2;

        const mergedBlock = {
          weight: mergedWeight,
          sumY: mergedSumY,
          value: mergedValue,
          indices: b1.indices.concat(b2.indices)
        };

        // Replace b1 and b2 with mergedBlock
        blocks.splice(i, 2, mergedBlock);

        // Step backwards to re-verify prior block monotonicity
        if (i > 0) {
          i--;
        }
      } else {
        i++;
      }
    }

    // 4. Map block values back to point indices
    const calibratedY = new Array(points.length);
    for (const block of blocks) {
      for (const idx of block.indices) {
        calibratedY[idx] = block.value;
      }
    }

    return points.map((p, idx) => ({
      x: p.x,
      y: Math.max(0.0, Math.min(1.0, calibratedY[idx])),
      weight: p.weight
    }));
  }

  /**
   * Performs piecewise linear interpolation between isotonic calibration anchors.
   * 
   * @private
   * @param {number} forecast - Raw forecast in [0.0, 1.0]
   * @param {Array<{ x: number, y: number }>} anchors - Monotonic isotonic anchors
   * @returns {number} Calibrated probability in [0.0, 1.0]
   */
  _interpolateIsotonic(forecast, anchors) {
    let p = forecast;
    if (p > 1.0 && p <= 100.0) p = p / 100.0;
    p = Math.max(0.0, Math.min(1.0, p));

    if (!anchors || anchors.length === 0) {
      return p;
    }

    // Build complete anchor curve with [0.0, 0.0] and [1.0, 1.0] boundaries
    const fullCurve = [];
    
    // Boundary lower anchor
    const firstAnchor = anchors[0];
    if (firstAnchor.x > 0.0) {
      const lowerY = Math.min(firstAnchor.y, 0.0);
      fullCurve.push({ x: 0.0, y: Math.max(0.0, lowerY) });
    }

    for (const pt of anchors) {
      // Prevent duplicate x coords
      if (fullCurve.length > 0 && Math.abs(fullCurve[fullCurve.length - 1].x - pt.x) < 1e-6) {
        continue;
      }
      fullCurve.push(pt);
    }

    // Boundary upper anchor
    const lastAnchor = fullCurve[fullCurve.length - 1];
    if (lastAnchor.x < 1.0) {
      const upperY = Math.max(lastAnchor.y, 1.0);
      fullCurve.push({ x: 1.0, y: Math.min(1.0, upperY) });
    }

    // Fast boundary checks
    if (p <= fullCurve[0].x) return fullCurve[0].y;
    if (p >= fullCurve[fullCurve.length - 1].x) return fullCurve[fullCurve.length - 1].y;

    // Find segment [k, k+1]
    for (let k = 0; k < fullCurve.length - 1; k++) {
      const p0 = fullCurve[k];
      const p1 = fullCurve[k + 1];

      if (p >= p0.x && p <= p1.x) {
        const span = p1.x - p0.x;
        if (span <= 1e-7) return p0.y;

        const t = (p - p0.x) / span;
        const interpolated = p0.y + t * (p1.y - p0.y);
        return Math.max(0.0, Math.min(1.0, Number(interpolated.toFixed(6))));
      }
    }

    return p;
  }

  /**
   * Calibrates a single agent's raw probability forecast using isotonic regression
   * (piecewise linear interpolation between bucket observed frequencies).
   * 
   * @param {string} agentName - Name of the agent
   * @param {number} rawForecast - Raw forecast probability [0.0, 1.0]
   * @returns {number} Calibrated probability forecast [0.0, 1.0]
   */
  calibrate(agentName, rawForecast) {
    const normAgent = this._normalizeAgentName(agentName);
    const agentBuckets = this.calibrationByAgent[normAgent];

    let p = Number(rawForecast);
    if (isNaN(p)) return 0.5;
    if (p > 1.0 && p <= 100.0) p = p / 100.0;
    p = Math.max(0.0, Math.min(1.0, p));

    // If agent has no specific data, fall back to ensemble calibration
    if (!agentBuckets) {
      return this.calibrateEnsemble(p);
    }

    // Check if agent has at least 1 prediction
    const totalSamples = agentBuckets.reduce((sum, b) => sum + b.totalPredictions, 0);
    if (totalSamples === 0) {
      return this.calibrateEnsemble(p);
    }

    // Run Isotonic Regression (PAVA) and interpolate
    const anchors = this._runIsotonicRegression(agentBuckets);
    return this._interpolateIsotonic(p, anchors);
  }

  /**
   * Calibrates a raw probability forecast using aggregate (all agents combined) buckets.
   * 
   * @param {number} rawForecast - Raw ensemble forecast probability [0.0, 1.0]
   * @returns {number} Calibrated probability forecast [0.0, 1.0]
   */
  calibrateEnsemble(rawForecast) {
    let p = Number(rawForecast);
    if (isNaN(p)) return 0.5;
    if (p > 1.0 && p <= 100.0) p = p / 100.0;
    p = Math.max(0.0, Math.min(1.0, p));

    const totalSamples = this.ensembleCalibration.reduce((sum, b) => sum + b.totalPredictions, 0);
    if (totalSamples === 0) {
      // Identity fallback when no data has been accumulated yet
      return p;
    }

    const anchors = this._runIsotonicRegression(this.ensembleCalibration);
    return this._interpolateIsotonic(p, anchors);
  }

  /**
   * Calculates Expected Calibration Error (ECE) across a set of buckets:
   * ECE = sum( (totalPredictions_i / totalPredictions_all) * |meanForecast_i - observedFrequency_i| )
   * 
   * @param {CalibrationBucket[]} buckets - Buckets to evaluate
   * @returns {number} Expected Calibration Error in [0.0, 1.0]
   */
  calculateECE(buckets) {
    const totalSamples = buckets.reduce((sum, b) => sum + b.totalPredictions, 0);
    if (totalSamples === 0) return 0.0;

    let weightedErrorSum = 0;
    for (const b of buckets) {
      if (b.totalPredictions > 0) {
        const weight = b.totalPredictions / totalSamples;
        const meanForecast = b.sumForecasts / b.totalPredictions;
        const observed = b.totalPositiveOutcomes / b.totalPredictions;
        const err = Math.abs(meanForecast - observed);
        weightedErrorSum += weight * err;
      }
    }

    return Number(weightedErrorSum.toFixed(6));
  }

  /**
   * Calculates Maximum Calibration Error (MCE) across non-empty buckets:
   * MCE = max( |meanForecast_i - observedFrequency_i| )
   * 
   * @param {CalibrationBucket[]} buckets - Buckets to evaluate
   * @returns {number} Maximum Calibration Error in [0.0, 1.0]
   */
  calculateMCE(buckets) {
    let maxError = 0.0;
    for (const b of buckets) {
      if (b.totalPredictions > 0) {
        const meanForecast = b.sumForecasts / b.totalPredictions;
        const observed = b.totalPositiveOutcomes / b.totalPredictions;
        const err = Math.abs(meanForecast - observed);
        if (err > maxError) {
          maxError = err;
        }
      }
    }

    return Number(maxError.toFixed(6));
  }

  /**
   * Evaluates if an agent (or ensemble) meets the formal calibration threshold:
   * ECE < threshold AND min N samples per bucket across all buckets.
   * 
   * @param {string|null} [agentName=null] - Agent name or null for ensemble
   * @param {number} [threshold=0.05] - Maximum acceptable ECE
   * @param {number} [minSamplesPerBucket=30] - Required minimum observations per bucket
   * @returns {boolean} True if calibrated, false otherwise
   */
  isCalibrated(agentName = null, threshold = this.eceThreshold, minSamplesPerBucket = this.minSamplesPerBucket) {
    let buckets;

    if (!agentName || agentName.toUpperCase() === 'ENSEMBLE' || agentName.toUpperCase() === 'AGGREGATE') {
      buckets = this.ensembleCalibration;
    } else {
      const normAgent = this._normalizeAgentName(agentName);
      buckets = this.calibrationByAgent[normAgent];
    }

    if (!buckets) return false;

    // Check sample size constraint across all buckets
    for (const b of buckets) {
      if (b.totalPredictions < minSamplesPerBucket) {
        return false;
      }
    }

    const ece = this.calculateECE(buckets);
    return ece < threshold;
  }

  /**
   * Generates reliability diagram points formatted for visual charts or diagnostic logging.
   * 
   * @param {string|null} [agentName=null] - Agent name, or null/'ENSEMBLE' for aggregate
   * @returns {ReliabilityPoint[]}
   */
  getReliabilityDiagram(agentName = null) {
    let buckets;
    let label = 'ENSEMBLE';

    if (!agentName || agentName.toUpperCase() === 'ENSEMBLE' || agentName.toUpperCase() === 'AGGREGATE') {
      buckets = this.ensembleCalibration;
    } else {
      label = this._normalizeAgentName(agentName);
      buckets = this.calibrationByAgent[label] || this._createEmptyBuckets();
    }

    const totalSamples = buckets.reduce((sum, b) => sum + b.totalPredictions, 0);

    return buckets.map((b) => {
      const lowPct = Math.round(b.bucketRange[0] * 100);
      const highPct = Math.round(b.bucketRange[1] * 100);
      const defaultMid = (b.bucketRange[0] + b.bucketRange[1]) / 2;

      const predicted = b.totalPredictions > 0 ? Number((b.sumForecasts / b.totalPredictions).toFixed(4)) : defaultMid;
      const observed = b.totalPredictions > 0 ? Number((b.totalPositiveOutcomes / b.totalPredictions).toFixed(4)) : defaultMid;
      const calibrationError = b.totalPredictions > 0 ? Number(Math.abs(predicted - observed).toFixed(4)) : 0.0;
      const weight = totalSamples > 0 ? Number((b.totalPredictions / totalSamples).toFixed(4)) : 0.0;

      return {
        bucketIndex: b.bucketIndex,
        range: b.bucketRange,
        rangeLabel: `${lowPct}-${highPct}%`,
        predicted,
        observed,
        count: b.totalPredictions,
        calibrationError,
        weight
      };
    });
  }

  /**
   * Generates a comprehensive calibration diagnostic report.
   * 
   * @param {string|null} [agentName=null] - Specific agent name, or null for all
   * @returns {CalibrationReport|{ ensemble: CalibrationReport, agents: Object.<string, CalibrationReport> }}
   */
  getCalibrationReport(agentName = null) {
    if (agentName && agentName.toUpperCase() !== 'ALL') {
      const isEnsemble = (agentName.toUpperCase() === 'ENSEMBLE' || agentName.toUpperCase() === 'AGGREGATE');
      const name = isEnsemble ? 'ENSEMBLE' : this._normalizeAgentName(agentName);
      const buckets = isEnsemble ? this.ensembleCalibration : (this.calibrationByAgent[name] || this._createEmptyBuckets());

      return this._buildSingleReport(name, buckets);
    }

    // Build comprehensive multi-agent report
    const ensembleReport = this._buildSingleReport('ENSEMBLE', this.ensembleCalibration);
    const agentReports = {};

    for (const [agentKey, agentBuckets] of Object.entries(this.calibrationByAgent)) {
      agentReports[agentKey] = this._buildSingleReport(agentKey, agentBuckets);
    }

    return {
      ensemble: ensembleReport,
      agents: agentReports,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Helper to construct a single CalibrationReport object.
   * @private
   * @param {string} agentName
   * @param {CalibrationBucket[]} buckets
   * @returns {CalibrationReport}
   */
  _buildSingleReport(agentName, buckets) {
    const totalPredictions = buckets.reduce((sum, b) => sum + b.totalPredictions, 0);
    const totalPositiveOutcomes = buckets.reduce((sum, b) => sum + b.totalPositiveOutcomes, 0);
    const overallWinRate = totalPredictions > 0 ? Number((totalPositiveOutcomes / totalPredictions).toFixed(4)) : 0.0;

    const ece = this.calculateECE(buckets);
    const mce = this.calculateMCE(buckets);
    const calibrated = this.isCalibrated(agentName);
    const diagram = this.getReliabilityDiagram(agentName);

    return {
      agentName,
      totalPredictions,
      totalPositiveOutcomes,
      overallWinRate,
      ece,
      mce,
      isCalibrated: calibrated,
      buckets: diagram,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Returns a list of all registered agent names.
   * @returns {string[]}
   */
  getAgentNames() {
    return Object.keys(this.calibrationByAgent);
  }

  /**
   * Creates an immutable, versioned calibration snapshot.
   * Ensures that learning creates auditable versioned checkpoints rather than silent in-place mutations.
   * 
   * @param {string} [modelVersion='v1.0.0'] - Model version or challenger ID to tag this snapshot with
   * @param {Object} [metadata={}] - Optional context metadata (trainingCutoff, datasetHash, etc.)
   * @returns {Object} Immutable snapshot object
   */
  createSnapshot(modelVersion = 'v1.0.0', metadata = {}) {
    const crypto = require('crypto');
    const timestamp = new Date().toISOString();
    const trainingCutoff = metadata.trainingCutoff || timestamp;

    const payload = {
      snapshotId: `calsnap_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      modelVersion,
      timestamp,
      trainingCutoff,
      ensembleCalibration: JSON.parse(JSON.stringify(this.ensembleCalibration)),
      calibrationByAgent: JSON.parse(JSON.stringify(this.calibrationByAgent)),
      ece: this.calculateECE(this.ensembleCalibration),
      totalPredictions: this.ensembleCalibration.reduce((sum, b) => sum + b.totalPredictions, 0),
      metadata
    };

    const snapshotCanonical = JSON.stringify({
      ensembleCalibration: payload.ensembleCalibration,
      calibrationByAgent: payload.calibrationByAgent,
      trainingCutoff: payload.trainingCutoff
    });
    payload.snapshotHash = crypto.createHash('sha256').update(snapshotCanonical).digest('hex').slice(0, 16);

    if (!this.snapshots) this.snapshots = new Map();
    this.snapshots.set(payload.snapshotId, payload);
    this.snapshots.set(modelVersion, payload);

    logger.info(`[CalibrationMemory] Created calibration snapshot "${payload.snapshotId}" for version ${modelVersion} (hash: ${payload.snapshotHash})`);
    return payload;
  }

  /**
   * Retrieves a calibration snapshot by snapshotId or modelVersion.
   * @param {string} versionOrId
   * @returns {Object|null}
   */
  getSnapshot(versionOrId) {
    if (!this.snapshots) return null;
    return this.snapshots.get(versionOrId) || null;
  }

  /**
   * Calibrates raw forecast against a specific historical snapshot / model version
   * ensuring strictly reproducible backtesting without lookahead bias.
   * 
   * @param {string} agentName
   * @param {number} rawForecast
   * @param {string} [snapshotVersion=null]
   * @returns {number}
   */
  calibrateWithSnapshot(agentName, rawForecast, snapshotVersion = null) {
    if (!snapshotVersion) return this.calibrate(agentName, rawForecast);
    const snap = this.getSnapshot(snapshotVersion);
    if (!snap) {
      logger.warn(`[CalibrationMemory] Snapshot "${snapshotVersion}" not found, falling back to current active calibration`);
      return this.calibrate(agentName, rawForecast);
    }

    const normAgent = this._normalizeAgentName(agentName);
    const buckets = snap.calibrationByAgent[normAgent] || snap.ensembleCalibration;
    const anchors = this._runIsotonicRegression(buckets);
    return this._interpolateIsotonic(rawForecast, anchors);
  }

  /**
   * Resets calibration memory for a single agent or the entire system.
   * @param {string|null} [agentName=null] - Agent name to reset, or null to reset all
   */
  reset(agentName = null) {
    if (agentName) {
      const normAgent = this._normalizeAgentName(agentName);
      if (this.calibrationByAgent[normAgent]) {
        delete this.calibrationByAgent[normAgent];
        logger.info(`Reset calibration memory for agent: ${normAgent}`);
      }
    } else {
      this.calibrationByAgent = {};
      this.ensembleCalibration = this._createEmptyBuckets();
      this.history = [];
      logger.info('Reset entire calibration memory (all agents & ensemble)');
    }

    this._saveToJson();
  }

  /**
   * Loads calibration memory from JSON file.
   * @private
   */
  _loadFromJson() {
    try {
      if (!fs.existsSync(this.storagePath)) {
        this._saveToJson();
        return;
      }

      const raw = fs.readFileSync(this.storagePath, 'utf8');
      if (!raw || raw.trim() === '') {
        return;
      }

      const parsed = JSON.parse(raw);

      // Restore ensemble buckets
      if (Array.isArray(parsed.ensembleCalibration) && parsed.ensembleCalibration.length === this.bucketCount) {
        this.ensembleCalibration = parsed.ensembleCalibration;
      } else {
        this.ensembleCalibration = this._createEmptyBuckets();
      }

      // Restore per-agent calibration
      if (parsed.calibrationByAgent && typeof parsed.calibrationByAgent === 'object') {
        this.calibrationByAgent = {};
        for (const [agent, buckets] of Object.entries(parsed.calibrationByAgent)) {
          if (Array.isArray(buckets) && buckets.length === this.bucketCount) {
            this.calibrationByAgent[agent] = buckets;
          }
        }
      }

      // Restore recent history
      if (Array.isArray(parsed.history)) {
        this.history = parsed.history.slice(-this.maxHistory);
      }

      // Recalculate stats for consistency
      this.ensembleCalibration.forEach(b => this._updateBucketStats(b));
      for (const buckets of Object.values(this.calibrationByAgent)) {
        buckets.forEach(b => this._updateBucketStats(b));
      }
    } catch (err) {
      logger.warn(`Failed to parse calibration memory from JSON: ${err.message}. Initializing empty state.`);
      this.ensembleCalibration = this._createEmptyBuckets();
      this.calibrationByAgent = {};
      this.history = [];
    }
  }

  /**
   * Persists calibration state atomically to JSON file.
   * @private
   */
  _saveToJson() {
    try {
      const dataDir = path.dirname(this.storagePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const payload = {
        version: '1.0.0',
        lastSaved: new Date().toISOString(),
        totalAgents: Object.keys(this.calibrationByAgent).length,
        ensembleTotalPredictions: this.ensembleCalibration.reduce((sum, b) => sum + b.totalPredictions, 0),
        ensembleCalibration: this.ensembleCalibration,
        calibrationByAgent: this.calibrationByAgent,
        history: this.history
      };

      const tmpPath = `${this.storagePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.storagePath);
    } catch (err) {
      logger.error(`Failed to save calibration memory to JSON: ${err.message}`, { stack: err.stack });
    }
  }
}

// Singleton instance
const calibrationMemory = new CalibrationMemory();

module.exports = {
  CalibrationMemory,
  calibrationMemory
};
