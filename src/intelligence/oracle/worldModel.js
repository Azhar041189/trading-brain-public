/**
 * @file worldModel.js
 * @module intelligence/oracle/worldModel
 * @description Probabilistic Causal and Correlational World Model for Trading Brain's ORACLE Intelligence Layer.
 * Maintains an interconnected relationship graph between US macroeconomic, monetary policy, and financial market
 * variables using typed edges (CAUSAL_HYPOTHESIS, CONDITIONAL, CORRELATIONAL, LOGICAL, TEMPORAL).
 * Propagates evidentiary updates and belief shifts across network edges using attenuated breadth-first search (BFS),
 * supports counterfactual scenario simulation with uncertainty bounds without mutating active state, and
 * generates episodic memory snapshots for downstream forecasting agents.
 * 
 * Governance Notice:
 * ORACLE modules observe, score, learn, and propose.
 * They may NOT modify live execution, risk caps, or historical trade records.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('WorldModel');

/**
 * Clamping boundaries for all probabilistic beliefs to prevent mathematical singularities.
 */
const PROB_MIN = 0.01;
const PROB_MAX = 0.99;

/**
 * Standard propagation hyperparameters
 */
const DEFAULT_DAMPING_FACTOR = 0.5;
const DEFAULT_MAX_DEPTH = 3;
const MIN_DELTA_THRESHOLD = 0.0001;

/**
 * Supported Edge Relationship Types
 * @typedef {'CAUSAL_HYPOTHESIS' | 'CONDITIONAL' | 'CORRELATIONAL' | 'LOGICAL' | 'TEMPORAL'} EdgeType
 */

/**
 * Supported Edge Directional Polarities
 * @typedef {'POSITIVE' | 'NEGATIVE'} EdgeDirection
 */

/**
 * Time unit for lag distributions
 * @typedef {'hours' | 'days' | 'weeks'} LagUnit
 */

/**
 * Node category classification
 * @typedef {'macro' | 'policy' | 'market'} NodeCategory
 */

/**
 * @typedef {Object} LagDistribution
 * @property {number} mean - Mean expected lag duration
 * @property {LagUnit} unit - Time unit ('hours' | 'days' | 'weeks')
 */

/**
 * @typedef {Object} NodeSource
 * @property {string} source - Source identifier or agent name
 * @property {string|null} evidence - Narrative summary or structured evidence
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {number} probability - Probability value at time of update
 * @property {number} delta - Probability shift applied
 */

/**
 * @typedef {Object} WorldNode
 * @property {string} id - Unique identifier (e.g. 'inflation_high')
 * @property {string} name - Human-readable descriptor
 * @property {NodeCategory|string} category - Category grouping ('macro', etc.)
 * @property {number} currentProbability - Belief probability clamped to [0.01, 0.99]
 * @property {number} uncertainty - Epistemic uncertainty metric [0, 1]
 * @property {string} lastUpdated - ISO 8601 timestamp of last state update
 * @property {NodeSource[]} sources - Historical evidence updates
 */

/**
 * @typedef {Object} WorldEdge
 * @property {string} from - Origin node ID
 * @property {string} to - Destination node ID
 * @property {EdgeType} edgeType - Edge relationship type
 * @property {EdgeDirection} direction - Directional polarity ('POSITIVE' | 'NEGATIVE')
 * @property {EdgeDirection} [relationship] - Legacy alias for direction ('POSITIVE' | 'NEGATIVE')
 * @property {number} strength - Influence coupling weight [0, 1]
 * @property {number} uncertainty - Epistemic uncertainty of this edge [0, 1]
 * @property {LagDistribution|null} lagDistribution - Expected lag distribution
 * @property {number} evidenceCount - Number of empirical validations recorded
 * @property {string[]} sourceProvenance - List of source references or agent IDs
 * @property {string} modelVersion - World model version identifier
 * @property {string} lastValidated - ISO 8601 timestamp of last validation
 * @property {string} description - Causal or correlational rationale
 * @property {string} [status='ACTIVE'] - Edge status ('ACTIVE' | 'UNVALIDATED')
 * @property {boolean} [isActive=true] - Whether edge participates in active propagation
 */

/**
 * @typedef {Object} PropagatedChange
 * @property {string} from - Source node of propagation hop
 * @property {string} to - Affected destination node
 * @property {EdgeType} edgeType - Edge relationship type
 * @property {EdgeDirection} direction - Directional polarity
 * @property {EdgeDirection} relationship - Legacy alias for direction
 * @property {number} edgeStrength - Edge coupling strength
 * @property {number} uncertainty - Edge uncertainty
 * @property {number} effectiveWeight - Effective weight after edgeType and uncertainty weighting
 * @property {number} previousProbability - Baseline probability before propagation
 * @property {number} newProbability - New probability after propagation
 * @property {number} delta - Effective delta applied
 * @property {number} depth - BFS traversal depth (1-3)
 * @property {string} description - Edge explanation
 */

/**
 * @typedef {Object} CounterfactualNodeResult
 * @property {number} projectedProbability - Projected probability value
 * @property {[number, number]} uncertaintyRange - [low, high] credible bounds
 */

/**
 * Baseline initial node definitions for US Macro universe (v1.0).
 * @type {WorldNode[]}
 */
const INITIAL_NODES = Object.freeze([
  {
    id: 'inflation_high',
    name: 'High Inflation',
    category: 'macro',
    currentProbability: 0.45,
    uncertainty: 0.20,
    sources: []
  },
  {
    id: 'employment_strong',
    name: 'Strong Employment',
    category: 'macro',
    currentProbability: 0.60,
    uncertainty: 0.20,
    sources: []
  },
  {
    id: 'gdp_growth_positive',
    name: 'Positive GDP Growth',
    category: 'macro',
    currentProbability: 0.55,
    uncertainty: 0.20,
    sources: []
  },
  {
    id: 'fed_rate_cut',
    name: 'Fed Rate Cut',
    category: 'macro',
    currentProbability: 0.35,
    uncertainty: 0.25,
    sources: []
  },
  {
    id: 'fed_rate_hold',
    name: 'Fed Rate Hold',
    category: 'macro',
    currentProbability: 0.45,
    uncertainty: 0.20,
    sources: []
  },
  {
    id: 'fed_rate_hike',
    name: 'Fed Rate Hike',
    category: 'macro',
    currentProbability: 0.20,
    uncertainty: 0.20,
    sources: []
  },
  {
    id: 'usd_strength',
    name: 'USD Strength',
    category: 'macro',
    currentProbability: 0.50,
    uncertainty: 0.20,
    sources: []
  },
  {
    id: 'treasury_rally',
    name: 'Treasury Rally',
    category: 'macro',
    currentProbability: 0.40,
    uncertainty: 0.25,
    sources: []
  },
  {
    id: 'equity_rally',
    name: 'Equity Rally',
    category: 'macro',
    currentProbability: 0.50,
    uncertainty: 0.25,
    sources: []
  },
  {
    id: 'recession_risk',
    name: 'Recession Risk',
    category: 'macro',
    currentProbability: 0.25,
    uncertainty: 0.25,
    sources: []
  }
]);

/**
 * Baseline causal and correlational directed typed edges for US Macro universe.
 * @type {WorldEdge[]}
 */
const INITIAL_EDGES = Object.freeze([
  {
    from: 'inflation_high',
    to: 'fed_rate_hike',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'POSITIVE',
    strength: 0.7,
    uncertainty: 0.30,
    lagDistribution: { mean: 30, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'High inflation increases probability of Fed rate hike'
  },
  {
    from: 'inflation_high',
    to: 'fed_rate_cut',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'NEGATIVE',
    strength: 0.6,
    uncertainty: 0.35,
    lagDistribution: { mean: 30, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'High inflation prevents Fed rate cuts'
  },
  {
    from: 'employment_strong',
    to: 'recession_risk',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'NEGATIVE',
    strength: 0.6,
    uncertainty: 0.30,
    lagDistribution: { mean: 60, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Strong labor market significantly dampens near-term recession likelihood'
  },
  {
    from: 'employment_strong',
    to: 'gdp_growth_positive',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'POSITIVE',
    strength: 0.6,
    uncertainty: 0.35,
    lagDistribution: { mean: 45, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Robust employment supports consumer spending and economic expansion'
  },
  {
    from: 'gdp_growth_positive',
    to: 'recession_risk',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'NEGATIVE',
    strength: 0.7,
    uncertainty: 0.30,
    lagDistribution: { mean: 90, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Positive economic growth directly contradicts recessionary conditions'
  },
  {
    from: 'gdp_growth_positive',
    to: 'equity_rally',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'POSITIVE',
    strength: 0.5,
    uncertainty: 0.40,
    lagDistribution: { mean: 14, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Economic expansion supports corporate earnings and equity multiples'
  },
  {
    from: 'recession_risk',
    to: 'equity_rally',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'NEGATIVE',
    strength: 0.7,
    uncertainty: 0.30,
    lagDistribution: { mean: 7, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Recession fears depress corporate earnings forecasts and equity valuations'
  },
  {
    from: 'recession_risk',
    to: 'fed_rate_cut',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'POSITIVE',
    strength: 0.6,
    uncertainty: 0.35,
    lagDistribution: { mean: 30, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Recession threats prompt the Federal Reserve to cut rates aggressively'
  },
  {
    from: 'fed_rate_cut',
    to: 'equity_rally',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'POSITIVE',
    strength: 0.5,
    uncertainty: 0.35,
    lagDistribution: { mean: 7, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Fed rate cuts ease liquidity and boost equity valuations'
  },
  {
    from: 'fed_rate_cut',
    to: 'usd_strength',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'NEGATIVE',
    strength: 0.5,
    uncertainty: 0.40,
    lagDistribution: { mean: 3, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Fed rate cuts diminish US dollar yield advantage'
  },
  {
    from: 'fed_rate_cut',
    to: 'treasury_rally',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'POSITIVE',
    strength: 0.6,
    uncertainty: 0.30,
    lagDistribution: { mean: 1, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Fed rate cuts lower yields and boost Treasury bond prices'
  },
  {
    from: 'fed_rate_hike',
    to: 'usd_strength',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'POSITIVE',
    strength: 0.6,
    uncertainty: 0.30,
    lagDistribution: { mean: 3, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Higher policy interest rates attract international capital to USD'
  },
  {
    from: 'fed_rate_hike',
    to: 'equity_rally',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'NEGATIVE',
    strength: 0.5,
    uncertainty: 0.40,
    lagDistribution: { mean: 7, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Higher discount rates and cost of capital depress equity valuations'
  },
  {
    from: 'fed_rate_hike',
    to: 'treasury_rally',
    edgeType: 'CAUSAL_HYPOTHESIS',
    direction: 'NEGATIVE',
    strength: 0.6,
    uncertainty: 0.30,
    lagDistribution: { mean: 1, unit: 'days' },
    evidenceCount: 0,
    sourceProvenance: [],
    modelVersion: 'world_model_v1.0',
    lastValidated: new Date().toISOString(),
    description: 'Higher policy rates push bond yields up and bond prices down'
  }
]);

/**
 * List of deprecated crypto node IDs removed in v1.0.
 */
const DEPRECATED_CRYPTO_NODE_IDS = new Set([
  'btc_bullish',
  'eth_bullish',
  'crypto_regulation_positive',
  'stablecoin_supply_growing',
  'defi_tvl_growing'
]);

/**
 * Clamps a numerical probability strictly between [PROB_MIN, PROB_MAX].
 * 
 * @param {number} p - Raw input value
 * @returns {number} Clamped probability
 */
function clampProbability(p) {
  if (typeof p !== 'number' || isNaN(p)) return 0.5;
  return Math.min(PROB_MAX, Math.max(PROB_MIN, p));
}

/**
 * Determines whether the lag duration for a TEMPORAL edge has elapsed.
 * 
 * @param {LagDistribution|null} lagDistribution - Lag specification
 * @param {Object} [options={}] - Options specifying elapsed time
 * @returns {boolean} True if lag has elapsed or is non-positive
 */
function isLagElapsed(lagDistribution, options = {}) {
  if (!lagDistribution || typeof lagDistribution.mean !== 'number' || lagDistribution.mean <= 0) {
    return true;
  }
  if (options.ignoreLag === true || options.assumeLagElapsed === true || options.forceTemporal === true) {
    return true;
  }

  let elapsedMs = null;
  if (typeof options.elapsedTime === 'number') {
    if (options.elapsedUnit === 'hours') elapsedMs = options.elapsedTime * 3600 * 1000;
    else if (options.elapsedUnit === 'days') elapsedMs = options.elapsedTime * 24 * 3600 * 1000;
    else if (options.elapsedUnit === 'weeks') elapsedMs = options.elapsedTime * 7 * 24 * 3600 * 1000;
    else elapsedMs = options.elapsedTime;
  } else if (typeof options.elapsedHours === 'number') {
    elapsedMs = options.elapsedHours * 3600 * 1000;
  } else if (typeof options.elapsedDays === 'number') {
    elapsedMs = options.elapsedDays * 24 * 3600 * 1000;
  } else if (typeof options.elapsedWeeks === 'number') {
    elapsedMs = options.elapsedWeeks * 7 * 24 * 3600 * 1000;
  } else if (typeof options.elapsedTime === 'object' && options.elapsedTime !== null) {
    const { value = 0, unit = 'days' } = options.elapsedTime;
    if (unit === 'hours') elapsedMs = value * 3600 * 1000;
    else if (unit === 'days') elapsedMs = value * 24 * 3600 * 1000;
    else if (unit === 'weeks') elapsedMs = value * 7 * 24 * 3600 * 1000;
    else elapsedMs = value;
  }

  if (elapsedMs === null) {
    if (options.currentTime && options.startTime) {
      elapsedMs = new Date(options.currentTime).getTime() - new Date(options.startTime).getTime();
    } else {
      return false;
    }
  }

  let requiredLagMs = 0;
  const unit = (lagDistribution.unit || 'days').toLowerCase();
  if (unit === 'hours' || unit === 'hour') {
    requiredLagMs = lagDistribution.mean * 3600 * 1000;
  } else if (unit === 'weeks' || unit === 'week') {
    requiredLagMs = lagDistribution.mean * 7 * 24 * 3600 * 1000;
  } else {
    requiredLagMs = lagDistribution.mean * 24 * 3600 * 1000;
  }

  return elapsedMs >= requiredLagMs;
}

/**
 * Computes the effective edge propagation weight based on edgeType, strength, uncertainty, and lag.
 * 
 * Rules:
 * - LOGICAL edges: propagate at full strength (hard constraint)
 * - CAUSAL_HYPOTHESIS edges: propagate at strength * (1 - uncertainty)
 * - CORRELATIONAL edges: propagate at strength * 0.5 * (1 - uncertainty)
 * - TEMPORAL edges: propagate only if lag has elapsed (at strength * (1 - uncertainty))
 * - CONDITIONAL edges: propagate at strength * (1 - uncertainty)
 * 
 * @param {WorldEdge} edge - Directed edge definition
 * @param {Object} [options={}] - Traversal options
 * @returns {number} Effective propagation multiplier [0, 1]
 */
function computeEffectiveEdgeWeight(edge, options = {}) {
  const edgeType = edge.edgeType || 'CAUSAL_HYPOTHESIS';
  const strength = typeof edge.strength === 'number' ? Math.min(1, Math.max(0, edge.strength)) : 0.5;
  const uncertainty = typeof edge.uncertainty === 'number' ? Math.min(1, Math.max(0, edge.uncertainty)) : 0.35;

  switch (edgeType) {
    case 'LOGICAL':
      return strength;

    case 'CAUSAL_HYPOTHESIS':
      return strength * (1 - uncertainty);

    case 'CORRELATIONAL':
      return strength * 0.5 * (1 - uncertainty);

    case 'TEMPORAL':
      if (isLagElapsed(edge.lagDistribution, options)) {
        return strength * (1 - uncertainty);
      }
      return 0;

    case 'CONDITIONAL':
      return strength * (1 - uncertainty);

    default:
      return strength * (1 - uncertainty);
  }
}

/**
 * Safely writes data to a JSON file atomically using a temporary staging file.
 * Handles cross-platform rename locks on Windows environments.
 * 
 * @param {string} filePath - Absolute target file path
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
 * Probabilistic Causal and Correlational World Model Engine (ORACLE Layer).
 * Implements belief propagation across typed edges, counterfactual simulations with uncertainty ranges,
 * and episodic memory snapshots.
 */
class WorldModel {
  /**
   * @param {Object} [options={}] - Configuration options
   * @param {string} [options.storagePath] - Custom absolute path for JSON persistence
   * @param {string} [options.dbPath] - Custom absolute path for SQLite persistence
   * @param {number} [options.dampingFactor=0.5] - Attenuation factor for BFS propagation
   * @param {number} [options.maxDepth=3] - Maximum edge traversal hops in BFS
   * @param {boolean} [options.autoSave=true] - Automatically persist on mutations
   */
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.resolve(__dirname, '../../../data/oracle/world_model.json');
    this.dbPath = options.dbPath || path.resolve(__dirname, '../../../data/oracle/oracle.db');
    this.dampingFactor = typeof options.dampingFactor === 'number' ? options.dampingFactor : DEFAULT_DAMPING_FACTOR;
    this.maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : DEFAULT_MAX_DEPTH;
    this.autoSave = options.autoSave !== false;

    /** @type {Map<string, WorldNode>} Map of nodeId -> WorldNode */
    this.nodes = new Map();

    /** @type {WorldEdge[]} Array of directed graph typed edges */
    this.edges = [];

    /** @type {'SQLITE_PRIMARY' | 'JSON_FALLBACK' | 'MEMORY_ONLY'} */
    this.persistenceMode = 'MEMORY_ONLY';
    this.db = null;

    this._initializeStorage();
  }

  /**
   * Initializes persistence layer and loads or bootstraps graph nodes and typed edges.
   * @private
   */
  _initializeStorage() {
    try {
      const jsonDir = path.dirname(this.storagePath);
      if (!fs.existsSync(jsonDir)) {
        fs.mkdirSync(jsonDir, { recursive: true });
      }

      // Try better-sqlite3 initialization if available
      try {
        const Database = require('better-sqlite3');
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }
        this.db = new Database(this.dbPath);
        this._initSqliteSchema();
        this.persistenceMode = 'SQLITE_PRIMARY';
        logger.info('WorldModel initialized with SQLite and JSON persistence', {
          dbPath: this.dbPath,
          storagePath: this.storagePath
        });
      } catch (sqliteErr) {
        this.persistenceMode = 'JSON_FALLBACK';
        logger.info('better-sqlite3 unavailable or failed; using JSON persistence', {
          storagePath: this.storagePath,
          error: sqliteErr.message
        });
      }

      // Load existing state or populate initial graph
      this.load();
    } catch (err) {
      this.persistenceMode = 'MEMORY_ONLY';
      logger.warn('Failed to initialize storage; loading default in-memory graph', { error: err.message });
      this._loadInitialGraph();
    }
  }

  /**
   * Creates SQLite tables for graph nodes and typed edges if not already present.
   * Recreates edge table if migrating from legacy schema.
   * @private
   */
  _initSqliteSchema() {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oracle_world_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        current_probability REAL NOT NULL,
        uncertainty REAL NOT NULL,
        last_updated TEXT NOT NULL,
        sources_json TEXT NOT NULL
      );
    `);

    try {
      const tableInfo = this.db.prepare(`PRAGMA table_info(oracle_world_edges)`).all();
      const hasEdgeType = tableInfo.some(col => col.name === 'edge_type');
      if (tableInfo.length > 0 && !hasEdgeType) {
        this.db.exec(`DROP TABLE oracle_world_edges`);
      }
    } catch (_) {}

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oracle_world_edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        direction TEXT NOT NULL,
        strength REAL NOT NULL,
        uncertainty REAL NOT NULL,
        lag_distribution TEXT,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        source_provenance TEXT,
        model_version TEXT,
        last_validated TEXT,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        PRIMARY KEY (from_id, to_id, direction)
      );

      CREATE INDEX IF NOT EXISTS idx_oracle_world_edges_from ON oracle_world_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_oracle_world_edges_to ON oracle_world_edges(to_id);
    `);
  }

  /**
   * Loads default initial macro nodes and typed edges into memory.
   * @private
   */
  _loadInitialGraph() {
    this.nodes.clear();
    this.edges = [];

    const nowIso = new Date().toISOString();

    for (const nodeDef of INITIAL_NODES) {
      this.nodes.set(nodeDef.id, {
        id: nodeDef.id,
        name: nodeDef.name,
        category: nodeDef.category,
        currentProbability: clampProbability(nodeDef.currentProbability),
        uncertainty: typeof nodeDef.uncertainty === 'number' ? nodeDef.uncertainty : 0.20,
        lastUpdated: nowIso,
        sources: []
      });
    }

    for (const edgeDef of INITIAL_EDGES) {
      const direction = edgeDef.direction || edgeDef.relationship || 'POSITIVE';
      this.edges.push({
        from: edgeDef.from,
        to: edgeDef.to,
        edgeType: edgeDef.edgeType || 'CAUSAL_HYPOTHESIS',
        direction: direction,
        relationship: direction,
        strength: Math.min(1, Math.max(0, edgeDef.strength)),
        uncertainty: typeof edgeDef.uncertainty === 'number' ? Math.min(1, Math.max(0, edgeDef.uncertainty)) : 0.35,
        lagDistribution: edgeDef.lagDistribution ? { ...edgeDef.lagDistribution } : null,
        evidenceCount: typeof edgeDef.evidenceCount === 'number' ? edgeDef.evidenceCount : 0,
        sourceProvenance: Array.isArray(edgeDef.sourceProvenance) ? [...edgeDef.sourceProvenance] : [],
        modelVersion: edgeDef.modelVersion || 'world_model_v1.0',
        lastValidated: edgeDef.lastValidated || nowIso,
        description: edgeDef.description || '',
        status: edgeDef.status || 'ACTIVE',
        isActive: edgeDef.isActive !== false
      });
    }
  }

  /**
   * Loads graph state from JSON persistent store.
   * Filters out deprecated crypto nodes and normalizes legacy edge structures.
   * If persistent files do not exist or are empty, initializes defaults.
   * 
   * @returns {boolean} True if loaded successfully
   */
  load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        if (raw && raw.trim().length > 0) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
            this.nodes.clear();
            const nowIso = new Date().toISOString();

            for (const node of parsed.nodes) {
              if (node && node.id && !DEPRECATED_CRYPTO_NODE_IDS.has(node.id) && node.category !== 'crypto') {
                this.nodes.set(node.id, {
                  id: node.id,
                  name: node.name || node.id,
                  category: node.category || 'macro',
                  currentProbability: clampProbability(node.currentProbability),
                  uncertainty: typeof node.uncertainty === 'number' ? node.uncertainty : 0.20,
                  lastUpdated: node.lastUpdated || nowIso,
                  sources: Array.isArray(node.sources) ? node.sources : []
                });
              }
            }

            this.edges = [];
            for (const e of parsed.edges) {
              if (!e || !e.from || !e.to) continue;
              if (DEPRECATED_CRYPTO_NODE_IDS.has(e.from) || DEPRECATED_CRYPTO_NODE_IDS.has(e.to)) continue;

              const direction = e.direction || e.relationship || 'POSITIVE';
              this.edges.push({
                from: e.from,
                to: e.to,
                edgeType: e.edgeType || 'CAUSAL_HYPOTHESIS',
                direction: direction,
                relationship: direction,
                strength: typeof e.strength === 'number' ? Math.min(1, Math.max(0, e.strength)) : 0.5,
                uncertainty: typeof e.uncertainty === 'number' ? Math.min(1, Math.max(0, e.uncertainty)) : 0.35,
                lagDistribution: e.lagDistribution || null,
                evidenceCount: typeof e.evidenceCount === 'number' ? e.evidenceCount : 0,
                sourceProvenance: Array.isArray(e.sourceProvenance) ? e.sourceProvenance : [],
                modelVersion: e.modelVersion || 'world_model_v1.0',
                lastValidated: e.lastValidated || nowIso,
                description: e.description || '',
                status: e.status || 'ACTIVE',
                isActive: e.isActive !== undefined ? Boolean(e.isActive) : (e.status !== 'UNVALIDATED')
              });
            }

            // Sync any missing default nodes or edges
            this._reconcileMissingDefaults();
            logger.info('WorldModel state loaded from JSON storage', {
              nodeCount: this.nodes.size,
              edgeCount: this.edges.length,
              storagePath: this.storagePath
            });
            return true;
          }
        }
      }

      // If no valid JSON file found, initialize defaults and persist
      this._loadInitialGraph();
      if (this.autoSave) {
        this.save();
      }
      logger.info('WorldModel initialized with default nodes and edges', {
        nodeCount: this.nodes.size,
        edgeCount: this.edges.length
      });
      return true;
    } catch (err) {
      logger.error('Error loading WorldModel; falling back to default graph', { error: err.message });
      this._loadInitialGraph();
      return false;
    }
  }

  /**
   * Ensures all baseline required US macro nodes and typed edges exist in the loaded graph.
   * @private
   */
  _reconcileMissingDefaults() {
    const nowIso = new Date().toISOString();
    let addedCount = 0;

    for (const nodeDef of INITIAL_NODES) {
      if (!this.nodes.has(nodeDef.id)) {
        this.nodes.set(nodeDef.id, {
          id: nodeDef.id,
          name: nodeDef.name,
          category: nodeDef.category,
          currentProbability: clampProbability(nodeDef.currentProbability),
          uncertainty: typeof nodeDef.uncertainty === 'number' ? nodeDef.uncertainty : 0.20,
          lastUpdated: nowIso,
          sources: []
        });
        addedCount++;
      }
    }

    for (const edgeDef of INITIAL_EDGES) {
      const direction = edgeDef.direction || edgeDef.relationship || 'POSITIVE';
      const exists = this.edges.some(e => e.from === edgeDef.from && e.to === edgeDef.to && (e.direction === direction || e.relationship === direction));
      if (!exists) {
        this.edges.push({
          from: edgeDef.from,
          to: edgeDef.to,
          edgeType: edgeDef.edgeType || 'CAUSAL_HYPOTHESIS',
          direction: direction,
          relationship: direction,
          strength: Math.min(1, Math.max(0, edgeDef.strength)),
          uncertainty: typeof edgeDef.uncertainty === 'number' ? Math.min(1, Math.max(0, edgeDef.uncertainty)) : 0.35,
          lagDistribution: edgeDef.lagDistribution ? { ...edgeDef.lagDistribution } : null,
          evidenceCount: typeof edgeDef.evidenceCount === 'number' ? edgeDef.evidenceCount : 0,
          sourceProvenance: Array.isArray(edgeDef.sourceProvenance) ? [...edgeDef.sourceProvenance] : [],
          modelVersion: edgeDef.modelVersion || 'world_model_v1.0',
          lastValidated: edgeDef.lastValidated || nowIso,
          description: edgeDef.description || '',
          status: edgeDef.status || 'ACTIVE',
          isActive: edgeDef.isActive !== false
        });
        addedCount++;
      }
    }

    if (addedCount > 0 && this.autoSave) {
      this.save();
    }
  }

  /**
   * Persists current graph state to JSON file and SQLite database.
   * 
   * @returns {boolean} True if saved successfully
   */
  save() {
    try {
      const serializedData = {
        version: '1.0.0',
        lastSaved: new Date().toISOString(),
        nodeCount: this.nodes.size,
        edgeCount: this.edges.length,
        nodes: Array.from(this.nodes.values()),
        edges: this.edges
      };

      // Atomic JSON persistence
      atomicWriteJsonSync(this.storagePath, serializedData);

      // SQLite synchronization if database handle is available
      if (this.db && this.persistenceMode === 'SQLITE_PRIMARY') {
        try {
          const insertNode = this.db.prepare(`
            INSERT OR REPLACE INTO oracle_world_nodes 
            (id, name, category, current_probability, uncertainty, last_updated, sources_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          const insertEdge = this.db.prepare(`
            INSERT OR REPLACE INTO oracle_world_edges 
            (from_id, to_id, edge_type, direction, strength, uncertainty, lag_distribution, evidence_count, source_provenance, model_version, last_validated, description, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          const deleteEdges = this.db.prepare(`DELETE FROM oracle_world_edges`);

          const tx = this.db.transaction(() => {
            for (const node of this.nodes.values()) {
              insertNode.run(
                node.id,
                node.name,
                node.category,
                node.currentProbability,
                node.uncertainty,
                node.lastUpdated,
                JSON.stringify(node.sources || [])
              );
            }

            deleteEdges.run();
            for (const edge of this.edges) {
              insertEdge.run(
                edge.from,
                edge.to,
                edge.edgeType || 'CAUSAL_HYPOTHESIS',
                edge.direction || edge.relationship || 'POSITIVE',
                edge.strength,
                edge.uncertainty !== undefined ? edge.uncertainty : 0.35,
                edge.lagDistribution ? JSON.stringify(edge.lagDistribution) : null,
                edge.evidenceCount || 0,
                JSON.stringify(edge.sourceProvenance || []),
                edge.modelVersion || 'world_model_v1.0',
                edge.lastValidated || new Date().toISOString(),
                edge.description || '',
                edge.status || 'ACTIVE'
              );
            }
          });

          tx();
        } catch (sqliteErr) {
          logger.warn('Failed to sync WorldModel to SQLite; JSON is up to date', { error: sqliteErr.message });
        }
      }

      return true;
    } catch (err) {
      logger.error('Failed to save WorldModel state', { error: err.message, storagePath: this.storagePath });
      return false;
    }
  }

  /**
   * Retrieves current state of a node by ID.
   * 
   * @param {string} nodeId - Node unique identifier
   * @returns {WorldNode|null} Deep copy of node or null if not found
   */
  getNode(nodeId) {
    if (!nodeId || typeof nodeId !== 'string') return null;
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    return {
      id: node.id,
      name: node.name,
      category: node.category,
      currentProbability: node.currentProbability,
      uncertainty: node.uncertainty,
      lastUpdated: node.lastUpdated,
      sources: (node.sources || []).map(s => ({ ...s }))
    };
  }

  /**
   * Returns complete graph state containing all nodes and typed edges.
   * 
   * @returns {{ nodes: WorldNode[], edges: WorldEdge[], nodeMap: Record<string, WorldNode> }}
   */
  getGraph() {
    const nodesList = Array.from(this.nodes.values()).map(node => ({
      id: node.id,
      name: node.name,
      category: node.category,
      currentProbability: node.currentProbability,
      uncertainty: node.uncertainty,
      lastUpdated: node.lastUpdated,
      sources: (node.sources || []).map(s => ({ ...s }))
    }));

    const nodeMap = {};
    for (const n of nodesList) {
      nodeMap[n.id] = n;
    }

    return {
      nodes: nodesList,
      edges: this.edges.map(e => ({
        ...e,
        sourceProvenance: Array.isArray(e.sourceProvenance) ? [...e.sourceProvenance] : [],
        lagDistribution: e.lagDistribution ? { ...e.lagDistribution } : null
      })),
      nodeMap
    };
  }

  /**
   * Returns directly connected incoming and outgoing neighbor nodes with typed edge metadata.
   * 
   * @param {string} nodeId - Node ID to inspect
   * @returns {Array<{ direction: 'incoming'|'outgoing', nodeId: string, node: WorldNode|null, edgeType: EdgeType, edgeDirection: EdgeDirection, relationship: EdgeDirection, strength: number, uncertainty: number, lagDistribution: LagDistribution|null, description: string, status: string }>}
   */
  getRelatedNodes(nodeId) {
    if (!nodeId || typeof nodeId !== 'string' || !this.nodes.has(nodeId)) {
      return [];
    }

    const results = [];

    // Outgoing edges (this node affects others)
    for (const edge of this.edges) {
      if (edge.from === nodeId) {
        const direction = edge.direction || edge.relationship || 'POSITIVE';
        results.push({
          direction: 'outgoing',
          nodeId: edge.to,
          node: this.getNode(edge.to),
          edgeType: edge.edgeType || 'CAUSAL_HYPOTHESIS',
          edgeDirection: direction,
          relationship: direction,
          strength: edge.strength,
          uncertainty: edge.uncertainty !== undefined ? edge.uncertainty : 0.35,
          lagDistribution: edge.lagDistribution ? { ...edge.lagDistribution } : null,
          evidenceCount: edge.evidenceCount || 0,
          sourceProvenance: Array.isArray(edge.sourceProvenance) ? [...edge.sourceProvenance] : [],
          modelVersion: edge.modelVersion || 'world_model_v1.0',
          lastValidated: edge.lastValidated || new Date().toISOString(),
          description: edge.description,
          status: edge.status || 'ACTIVE'
        });
      }
    }

    // Incoming edges (other nodes affect this node)
    for (const edge of this.edges) {
      if (edge.to === nodeId) {
        const direction = edge.direction || edge.relationship || 'POSITIVE';
        results.push({
          direction: 'incoming',
          nodeId: edge.from,
          node: this.getNode(edge.from),
          edgeType: edge.edgeType || 'CAUSAL_HYPOTHESIS',
          edgeDirection: direction,
          relationship: direction,
          strength: edge.strength,
          uncertainty: edge.uncertainty !== undefined ? edge.uncertainty : 0.35,
          lagDistribution: edge.lagDistribution ? { ...edge.lagDistribution } : null,
          evidenceCount: edge.evidenceCount || 0,
          sourceProvenance: Array.isArray(edge.sourceProvenance) ? [...edge.sourceProvenance] : [],
          modelVersion: edge.modelVersion || 'world_model_v1.0',
          lastValidated: edge.lastValidated || new Date().toISOString(),
          description: edge.description,
          status: edge.status || 'ACTIVE'
        });
      }
    }

    return results;
  }

  /**
   * Updates a single node's probability, records evidence provenance, and propagates belief shifts.
   * 
   * @param {string} nodeId - Node identifier to update
   * @param {number} newProbability - New probability belief in range [0, 1]
   * @param {string|Object} [source='system'] - Informational source or agent identifier
   * @param {string|Object|null} [evidence=null] - Narrative evidence or data payload
   * @param {Object} [options={}] - Optional propagation overrides
   * @returns {{ node: WorldNode, delta: number, propagatedChanges: PropagatedChange[] }}
   */
  updateNode(nodeId, newProbability, source = 'system', evidence = null, options = {}) {
    if (!nodeId || typeof nodeId !== 'string') {
      throw new Error('updateNode requires a valid string nodeId');
    }

    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node with id '${nodeId}' not found in WorldModel`);
    }

    const clampedProbability = clampProbability(newProbability);
    const oldProbability = node.currentProbability;
    const delta = clampedProbability - oldProbability;

    // Apply direct update
    const nowIso = new Date().toISOString();
    node.currentProbability = Number(clampedProbability.toFixed(6));
    node.lastUpdated = nowIso;

    // Format source entry
    const sourceName = typeof source === 'string' ? source : (source.name || source.source || 'system');
    let evidenceStr = null;
    if (typeof evidence === 'string') {
      evidenceStr = evidence;
    } else if (evidence !== null && typeof evidence === 'object') {
      try {
        evidenceStr = JSON.stringify(evidence);
      } catch (_) {
        evidenceStr = String(evidence);
      }
    }

    const sourceEntry = {
      source: sourceName,
      evidence: evidenceStr,
      timestamp: nowIso,
      probability: node.currentProbability,
      delta: Number(delta.toFixed(6))
    };

    if (!Array.isArray(node.sources)) {
      node.sources = [];
    }
    node.sources.unshift(sourceEntry);
    if (node.sources.length > 50) {
      node.sources = node.sources.slice(0, 50);
    }

    let propagatedChanges = [];

    // Propagate through the causal graph if delta exceeds threshold
    if (Math.abs(delta) >= MIN_DELTA_THRESHOLD) {
      propagatedChanges = this.propagateEvidence(nodeId, delta, options);
    }

    // Persist mutation
    if (this.autoSave) {
      this.save();
    }

    logger.info(`WorldModel node updated: ${nodeId}`, {
      nodeId,
      oldProbability,
      newProbability: node.currentProbability,
      delta: Number(delta.toFixed(6)),
      propagatedCount: propagatedChanges.length
    });

    return {
      node: this.getNode(nodeId),
      delta: Number(delta.toFixed(6)),
      propagatedChanges
    };
  }

  /**
   * Propagates belief shifts through network edges using attenuated Breadth-First Search (BFS).
   * Respects typed edge characteristics:
   * - LOGICAL edges: propagate at full strength (hard constraint)
   * - CAUSAL_HYPOTHESIS edges: propagate at strength * (1 - uncertainty)
   * - CORRELATIONAL edges: propagate at strength * 0.5 * (1 - uncertainty)
   * - TEMPORAL edges: propagate only if lag has elapsed
   * 
   * @param {string} nodeId - Origin node of the belief shift
   * @param {number} delta - Probability change applied to origin node
   * @param {Object} [options={}] - Override configuration
   * @param {number} [options.dampingFactor] - Custom attenuation factor (default 0.5)
   * @param {number} [options.maxDepth] - Custom max depth (default 3)
   * @param {boolean} [options.includeChallengers=false] - Include UNVALIDATED challenger edges
   * @param {number|Object} [options.elapsedTime] - Elapsed time for TEMPORAL edge evaluation
   * @param {number} [options.elapsedHours] - Elapsed hours for TEMPORAL edge evaluation
   * @param {number} [options.elapsedDays] - Elapsed days for TEMPORAL edge evaluation
   * @param {number} [options.elapsedWeeks] - Elapsed weeks for TEMPORAL edge evaluation
   * @param {boolean} [options.assumeLagElapsed=false] - Treat all temporal lags as elapsed
   * @returns {PropagatedChange[]} List of all applied probability adjustments
   */
  propagateEvidence(nodeId, delta, options = {}) {
    if (!nodeId || typeof delta !== 'number' || Math.abs(delta) < MIN_DELTA_THRESHOLD) {
      return [];
    }

    const damping = typeof options.dampingFactor === 'number' ? options.dampingFactor : this.dampingFactor;
    const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : this.maxDepth;
    const includeChallengers = options.includeChallengers === true;

    /** @type {Array<{ nodeId: string, currentDelta: number, depth: number }>} */
    const queue = [{ nodeId, currentDelta: delta, depth: 0 }];

    /** @type {Set<string>} Track visited nodes to prevent circular feedback in single wave */
    const visited = new Set([nodeId]);

    /** @type {PropagatedChange[]} */
    const changes = [];
    const nowIso = new Date().toISOString();

    while (queue.length > 0) {
      const { nodeId: currentId, currentDelta, depth } = queue.shift();

      if (depth >= maxDepth || Math.abs(currentDelta) < MIN_DELTA_THRESHOLD) {
        continue;
      }

      // Find all outgoing directed edges (excluding UNVALIDATED unless requested)
      const outgoingEdges = this.edges.filter(e => {
        if (e.from !== currentId) return false;
        if (!includeChallengers && (e.status === 'UNVALIDATED' || e.isActive === false)) return false;
        return true;
      });

      for (const edge of outgoingEdges) {
        const targetNode = this.nodes.get(edge.to);
        if (!targetNode) continue;
        if (visited.has(edge.to)) continue;

        const effectiveWeight = computeEffectiveEdgeWeight(edge, options);
        if (effectiveWeight <= 0) continue;

        const direction = edge.direction || edge.relationship || 'POSITIVE';
        const multiplier = direction === 'NEGATIVE' ? -1 : 1;

        const rawShift = multiplier * currentDelta * effectiveWeight * damping;
        const oldProb = targetNode.currentProbability;
        const targetNewProb = clampProbability(oldProb + rawShift);
        const actualDelta = targetNewProb - oldProb;

        if (Math.abs(actualDelta) >= MIN_DELTA_THRESHOLD) {
          targetNode.currentProbability = Number(targetNewProb.toFixed(6));
          targetNode.lastUpdated = nowIso;
          visited.add(edge.to);

          const changeRecord = {
            from: currentId,
            to: edge.to,
            edgeType: edge.edgeType || 'CAUSAL_HYPOTHESIS',
            direction: direction,
            relationship: direction,
            edgeStrength: edge.strength,
            uncertainty: edge.uncertainty !== undefined ? edge.uncertainty : 0.35,
            effectiveWeight: Number(effectiveWeight.toFixed(6)),
            previousProbability: oldProb,
            newProbability: targetNode.currentProbability,
            delta: Number(actualDelta.toFixed(6)),
            depth: depth + 1,
            description: edge.description
          };

          changes.push(changeRecord);

          // Enqueue next hop if within max traversal depth
          if (depth + 1 < maxDepth) {
            queue.push({
              nodeId: edge.to,
              currentDelta: actualDelta,
              depth: depth + 1
            });
          }
        }
      }
    }

    return changes;
  }

  /**
   * Performs an isolated counterfactual "what-if" simulation without mutating live graph state.
   * Computes projected probabilities and epistemic uncertainty ranges for all nodes.
   * 
   * Output structure:
   * { [nodeId]: { projectedProbability: number, uncertaintyRange: [low, high] } }
   * 
   * @param {string} nodeId - Target node to modify hypothetically
   * @param {number} hypotheticalProbability - Hypothetical probability value [0, 1]
   * @param {Object} [options={}] - Optional simulation overrides
   * @param {number} [options.dampingFactor] - Custom attenuation factor (default 0.5)
   * @param {number} [options.maxDepth] - Custom max depth (default 3)
   * @param {boolean} [options.includeChallengers=false] - Include UNVALIDATED challenger edges
   * @returns {Record<string, CounterfactualNodeResult>} Object mapping node IDs to projected probabilities & uncertainty bounds
   */
  runCounterfactual(nodeId, hypotheticalProbability, options = {}) {
    if (!nodeId || typeof nodeId !== 'string') {
      throw new Error('runCounterfactual requires a valid string nodeId');
    }

    if (!this.nodes.has(nodeId)) {
      throw new Error(`Node with id '${nodeId}' does not exist in WorldModel`);
    }

    const damping = typeof options.dampingFactor === 'number' ? options.dampingFactor : this.dampingFactor;
    const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : this.maxDepth;
    const includeChallengers = options.includeChallengers === true;

    // Clone isolated state map
    const simulatedProbs = new Map();
    for (const [id, node] of this.nodes.entries()) {
      simulatedProbs.set(id, node.currentProbability);
    }

    const currentProb = simulatedProbs.get(nodeId);
    const clampedHypothetical = clampProbability(hypotheticalProbability);
    const initialDelta = clampedHypothetical - currentProb;

    simulatedProbs.set(nodeId, Number(clampedHypothetical.toFixed(6)));

    const queue = [{ nodeId, currentDelta: initialDelta, depth: 0 }];
    const visited = new Set([nodeId]);
    const simulatedChanges = [];

    if (Math.abs(initialDelta) >= MIN_DELTA_THRESHOLD) {
      while (queue.length > 0) {
        const { nodeId: currentId, currentDelta, depth } = queue.shift();

        if (depth >= maxDepth || Math.abs(currentDelta) < MIN_DELTA_THRESHOLD) {
          continue;
        }

        const outgoingEdges = this.edges.filter(e => {
          if (e.from !== currentId) return false;
          if (!includeChallengers && (e.status === 'UNVALIDATED' || e.isActive === false)) return false;
          return true;
        });

        for (const edge of outgoingEdges) {
          if (!simulatedProbs.has(edge.to)) continue;
          if (visited.has(edge.to)) continue;

          const effectiveWeight = computeEffectiveEdgeWeight(edge, options);
          if (effectiveWeight <= 0) continue;

          const direction = edge.direction || edge.relationship || 'POSITIVE';
          const multiplier = direction === 'NEGATIVE' ? -1 : 1;

          const rawShift = multiplier * currentDelta * effectiveWeight * damping;
          const oldVal = simulatedProbs.get(edge.to);
          const newVal = clampProbability(oldVal + rawShift);
          const appliedDelta = newVal - oldVal;

          if (Math.abs(appliedDelta) >= MIN_DELTA_THRESHOLD) {
            simulatedProbs.set(edge.to, Number(newVal.toFixed(6)));
            visited.add(edge.to);

            simulatedChanges.push({
              from: currentId,
              to: edge.to,
              edgeType: edge.edgeType || 'CAUSAL_HYPOTHESIS',
              direction: direction,
              relationship: direction,
              strength: edge.strength,
              uncertainty: edge.uncertainty !== undefined ? edge.uncertainty : 0.35,
              effectiveWeight: Number(effectiveWeight.toFixed(6)),
              previousProbability: oldVal,
              projectedProbability: Number(newVal.toFixed(6)),
              delta: Number(appliedDelta.toFixed(6)),
              depth: depth + 1
            });

            if (depth + 1 < maxDepth) {
              queue.push({
                nodeId: edge.to,
                currentDelta: appliedDelta,
                depth: depth + 1
              });
            }
          }
        }
      }
    }

    // Build structured return projection dictionary with uncertainty bounds
    const projectionResult = {};
    for (const [id, node] of this.nodes.entries()) {
      const projProb = simulatedProbs.get(id);
      const nodeUncertainty = typeof node.uncertainty === 'number' ? node.uncertainty : 0.20;
      const margin = nodeUncertainty * 0.5;
      const low = clampProbability(Number((projProb - margin).toFixed(4)));
      const high = clampProbability(Number((projProb + margin).toFixed(4)));

      projectionResult[id] = {
        projectedProbability: projProb,
        uncertaintyRange: [low, high]
      };
    }

    // Attach non-enumerable simulation metadata for advanced callers
    Object.defineProperty(projectionResult, '_metadata', {
      enumerable: false,
      value: {
        targetNodeId: nodeId,
        baselineProbability: currentProb,
        hypotheticalProbability: Number(clampedHypothetical.toFixed(6)),
        initialDelta: Number(initialDelta.toFixed(6)),
        affectedNodeCount: simulatedChanges.length,
        changes: simulatedChanges
      }
    });

    return projectionResult;
  }

  /**
   * Generates a comprehensive, timestamped state snapshot for Episodic Memory and decision routing.
   * 
   * @returns {Object} Structured state snapshot
   */
  getSnapshot() {
    const timestamp = new Date().toISOString();
    const probabilities = {};
    const nodesSummary = {};

    for (const [id, node] of this.nodes.entries()) {
      probabilities[id] = node.currentProbability;
      nodesSummary[id] = {
        name: node.name,
        category: node.category,
        probability: node.currentProbability,
        uncertainty: node.uncertainty,
        lastUpdated: node.lastUpdated
      };
    }

    const macroScore = this.calculateCategoryScore('macro');

    // Categorize prevailing monetary policy posture
    const cutProb = this.getNode('fed_rate_cut')?.currentProbability || 0.33;
    const holdProb = this.getNode('fed_rate_hold')?.currentProbability || 0.33;
    const hikeProb = this.getNode('fed_rate_hike')?.currentProbability || 0.33;

    let fedPosture = 'NEUTRAL_HOLD';
    if (cutProb > holdProb && cutProb > hikeProb) {
      fedPosture = 'DOVISH_EASING';
    } else if (hikeProb > holdProb && hikeProb > cutProb) {
      fedPosture = 'HAWKISH_TIGHTENING';
    }

    return {
      timestamp,
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      probabilities,
      nodes: nodesSummary,
      regimes: {
        macroBullishScore: macroScore,
        recessionRisk: this.getNode('recession_risk')?.currentProbability || 0.25,
        inflationPressure: this.getNode('inflation_high')?.currentProbability || 0.45,
        fedPosture,
        fedRateCutOdds: cutProb,
        fedRateHikeOdds: hikeProb,
        treasuryRallyOdds: this.getNode('treasury_rally')?.currentProbability || 0.40,
        equityRallyOdds: this.getNode('equity_rally')?.currentProbability || 0.50,
        usdStrengthOdds: this.getNode('usd_strength')?.currentProbability || 0.50,
        gdpGrowthOdds: this.getNode('gdp_growth_positive')?.currentProbability || 0.55,
        employmentOdds: this.getNode('employment_strong')?.currentProbability || 0.60
      }
    };
  }

  /**
   * Closes active SQLite database handle and releases locks.
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
   * Restores initial default probabilities and typed edges, clearing transient states and saving to disk.
   * 
   * @returns {boolean} True if reset was successful
   */
  reset() {
    logger.info('Resetting WorldModel to initial default state');
    this._loadInitialGraph();
    if (this.autoSave) {
      this.save();
    }
    return true;
  }

  /**
   * Adds or updates a custom node in the graph.
   * 
   * @param {Object} nodeDef
   * @param {string} nodeDef.id - Unique ID
   * @param {string} nodeDef.name - Human-readable descriptor
   * @param {string} [nodeDef.category='macro'] - Category
   * @param {number} [nodeDef.currentProbability=0.5] - Probability [0.01, 0.99]
   * @param {number} [nodeDef.uncertainty=0.25] - Uncertainty [0, 1]
   * @returns {WorldNode} The registered node
   */
  addNode(nodeDef) {
    if (!nodeDef || !nodeDef.id) {
      throw new Error('addNode requires a valid node definition with an id');
    }

    const existing = this.nodes.get(nodeDef.id);
    const nowIso = new Date().toISOString();

    const node = {
      id: nodeDef.id,
      name: nodeDef.name || nodeDef.id,
      category: nodeDef.category || (existing ? existing.category : 'macro'),
      currentProbability: clampProbability(typeof nodeDef.currentProbability === 'number' ? nodeDef.currentProbability : (existing ? existing.currentProbability : 0.5)),
      uncertainty: typeof nodeDef.uncertainty === 'number' ? Math.min(1, Math.max(0, nodeDef.uncertainty)) : (existing ? existing.uncertainty : 0.25),
      lastUpdated: nowIso,
      sources: existing ? [...existing.sources] : []
    };

    this.nodes.set(node.id, node);
    if (this.autoSave) this.save();
    return this.getNode(node.id);
  }

  /**
   * Adds or updates an active directed typed edge in the causal graph.
   * 
   * @param {Object} edgeDef
   * @param {string} edgeDef.from - Source node ID
   * @param {string} edgeDef.to - Destination node ID
   * @param {EdgeType} [edgeDef.edgeType='CAUSAL_HYPOTHESIS'] - Link type
   * @param {EdgeDirection} [edgeDef.direction='POSITIVE'] - Directional polarity
   * @param {EdgeDirection} [edgeDef.relationship] - Legacy direction alias
   * @param {number} [edgeDef.strength=0.5] - Strength coupling weight [0, 1]
   * @param {number} [edgeDef.uncertainty=0.35] - Edge uncertainty [0, 1]
   * @param {LagDistribution|null} [edgeDef.lagDistribution=null] - Lag distribution
   * @param {number} [edgeDef.evidenceCount=0] - Empirical validation count
   * @param {string[]} [edgeDef.sourceProvenance=[]] - Source provenance
   * @param {string} [edgeDef.modelVersion='world_model_v1.0'] - Model version
   * @param {string} [edgeDef.description=''] - Descriptive rationale
   * @returns {WorldEdge} The registered edge
   */
  addEdge(edgeDef) {
    if (!edgeDef || !edgeDef.from || !edgeDef.to) {
      throw new Error('addEdge requires valid from and to node IDs');
    }

    if (!this.nodes.has(edgeDef.from)) {
      throw new Error(`Source node '${edgeDef.from}' does not exist in graph`);
    }
    if (!this.nodes.has(edgeDef.to)) {
      throw new Error(`Destination node '${edgeDef.to}' does not exist in graph`);
    }

    const direction = edgeDef.direction || edgeDef.relationship || 'POSITIVE';
    const edge = {
      from: edgeDef.from,
      to: edgeDef.to,
      edgeType: edgeDef.edgeType || 'CAUSAL_HYPOTHESIS',
      direction: direction === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE',
      relationship: direction === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE',
      strength: typeof edgeDef.strength === 'number' ? Math.min(1, Math.max(0, edgeDef.strength)) : 0.5,
      uncertainty: typeof edgeDef.uncertainty === 'number' ? Math.min(1, Math.max(0, edgeDef.uncertainty)) : 0.35,
      lagDistribution: edgeDef.lagDistribution ? { ...edgeDef.lagDistribution } : null,
      evidenceCount: typeof edgeDef.evidenceCount === 'number' ? edgeDef.evidenceCount : 0,
      sourceProvenance: Array.isArray(edgeDef.sourceProvenance) ? [...edgeDef.sourceProvenance] : [],
      modelVersion: edgeDef.modelVersion || 'world_model_v1.0',
      lastValidated: edgeDef.lastValidated || new Date().toISOString(),
      description: edgeDef.description || '',
      status: edgeDef.status || 'ACTIVE',
      isActive: edgeDef.isActive !== undefined ? Boolean(edgeDef.isActive) : (edgeDef.status !== 'UNVALIDATED')
    };

    // Remove existing edge between same nodes with same direction if present
    this.edges = this.edges.filter(e => !(e.from === edge.from && e.to === edge.to && (e.direction === edge.direction || e.relationship === edge.relationship)));
    this.edges.push(edge);

    if (this.autoSave) this.save();
    return { ...edge };
  }

  /**
   * Adds a new edge as an UNVALIDATED challenger hypothesis rather than immediately active.
   * Challenger edges are stored in the graph for hypothesis evaluation but are excluded
   * from default live propagation until validated.
   * 
   * @param {string} fromId - Origin source node ID
   * @param {string} toId - Destination target node ID
   * @param {Object} [edgeSpec={}] - Edge parameters and hypotheses specification
   * @param {EdgeType} [edgeSpec.edgeType='CAUSAL_HYPOTHESIS'] - Hypothesis edge type
   * @param {EdgeDirection} [edgeSpec.direction='POSITIVE'] - Directional polarity
   * @param {number} [edgeSpec.strength=0.5] - Hypothesized coupling strength [0, 1]
   * @param {number} [edgeSpec.uncertainty=0.5] - Epistemic uncertainty [0, 1]
   * @param {LagDistribution|null} [edgeSpec.lagDistribution=null] - Expected lag distribution
   * @param {string[]} [edgeSpec.sourceProvenance=[]] - Source agents or reasoning traces
   * @param {string} [edgeSpec.modelVersion='world_model_v1.0'] - Model version tag
   * @param {string} [edgeSpec.description=''] - Hypothesis rationale
   * @returns {WorldEdge} The registered challenger edge
   */
  addEdgeAsChallenger(fromId, toId, edgeSpec = {}) {
    if (!fromId || typeof fromId !== 'string' || !toId || typeof toId !== 'string') {
      throw new Error('addEdgeAsChallenger requires valid string fromId and toId');
    }

    if (!this.nodes.has(fromId)) {
      throw new Error(`Source node '${fromId}' does not exist in graph`);
    }
    if (!this.nodes.has(toId)) {
      throw new Error(`Destination node '${toId}' does not exist in graph`);
    }

    const direction = edgeSpec.direction || edgeSpec.relationship || 'POSITIVE';
    const edge = {
      from: fromId,
      to: toId,
      edgeType: edgeSpec.edgeType || 'CAUSAL_HYPOTHESIS',
      direction: direction === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE',
      relationship: direction === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE',
      strength: typeof edgeSpec.strength === 'number' ? Math.min(1, Math.max(0, edgeSpec.strength)) : 0.5,
      uncertainty: typeof edgeSpec.uncertainty === 'number' ? Math.min(1, Math.max(0, edgeSpec.uncertainty)) : 0.5,
      lagDistribution: edgeSpec.lagDistribution ? { ...edgeSpec.lagDistribution } : null,
      evidenceCount: typeof edgeSpec.evidenceCount === 'number' ? edgeSpec.evidenceCount : 0,
      sourceProvenance: Array.isArray(edgeSpec.sourceProvenance) ? [...edgeSpec.sourceProvenance] : [],
      modelVersion: edgeSpec.modelVersion || 'world_model_v1.0',
      lastValidated: edgeSpec.lastValidated || new Date().toISOString(),
      description: edgeSpec.description || 'Challenger hypothesis edge',
      status: 'UNVALIDATED',
      isActive: false
    };

    // Replace any existing unvalidated challenger edge with same endpoints & direction
    this.edges = this.edges.filter(e => !(e.from === fromId && e.to === toId && e.direction === edge.direction && e.status === 'UNVALIDATED'));
    this.edges.push(edge);

    if (this.autoSave) {
      this.save();
    }

    logger.info(`Challenger edge registered: ${fromId} -> ${toId} (${edge.direction}) [UNVALIDATED]`, {
      from: fromId,
      to: toId,
      edgeType: edge.edgeType,
      direction: edge.direction,
      strength: edge.strength,
      uncertainty: edge.uncertainty
    });

    return { ...edge };
  }

  /**
   * Promotes an UNVALIDATED challenger edge to ACTIVE status upon empirical confirmation.
   * 
   * @param {string} fromId - Source node ID
   * @param {string} toId - Destination node ID
   * @param {EdgeDirection|string} [direction] - Optional direction filter
   * @returns {WorldEdge|null} The promoted edge or null if not found
   */
  promoteChallengerEdge(fromId, toId, direction) {
    const edge = this.edges.find(e => 
      e.from === fromId && 
      e.to === toId && 
      (direction ? (e.direction === direction || e.relationship === direction) : true) &&
      (e.status === 'UNVALIDATED' || e.isActive === false)
    );

    if (!edge) return null;

    edge.status = 'ACTIVE';
    edge.isActive = true;
    edge.lastValidated = new Date().toISOString();
    edge.evidenceCount = (edge.evidenceCount || 0) + 1;

    if (this.autoSave) this.save();
    return { ...edge };
  }

  /**
   * Returns all UNVALIDATED challenger edges.
   * @returns {WorldEdge[]}
   */
  getChallengerEdges() {
    return this.edges.filter(e => e.status === 'UNVALIDATED' || e.isActive === false).map(e => ({ ...e }));
  }

  /**
   * Returns all ACTIVE validated edges.
   * @returns {WorldEdge[]}
   */
  getActiveEdges() {
    return this.edges.filter(e => e.status !== 'UNVALIDATED' && e.isActive !== false).map(e => ({ ...e }));
  }

  /**
   * Removes an existing edge from the graph.
   * 
   * @param {string} from - Source node ID
   * @param {string} to - Destination node ID
   * @param {EdgeDirection|string} [direction] - Optional specific direction to match
   * @returns {boolean} True if edge was removed
   */
  removeEdge(from, to, direction) {
    const initialLen = this.edges.length;
    this.edges = this.edges.filter(e => {
      if (direction) {
        return !(e.from === from && e.to === to && (e.direction === direction || e.relationship === direction));
      }
      return !(e.from === from && e.to === to);
    });

    const removed = this.edges.length < initialLen;
    if (removed && this.autoSave) {
      this.save();
    }
    return removed;
  }

  /**
   * Updates uncertainty score for a node.
   * 
   * @param {string} nodeId - Node ID
   * @param {number} uncertainty - Uncertainty metric [0, 1]
   * @returns {boolean} True if updated
   */
  setUncertainty(nodeId, uncertainty) {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.uncertainty = Math.min(1, Math.max(0, typeof uncertainty === 'number' ? uncertainty : 0.20));
    node.lastUpdated = new Date().toISOString();
    if (this.autoSave) this.save();
    return true;
  }

  /**
   * Computes an aggregate sentiment/bullishness score [0, 1] for a category of nodes.
   * 
   * @param {string} category - Category ('macro')
   * @returns {number} Normalized score
   */
  calculateCategoryScore(category) {
    const categoryNodes = Array.from(this.nodes.values()).filter(n => n.category === category);
    if (categoryNodes.length === 0) return 0.5;

    let scoreSum = 0;
    let weightSum = 0;

    for (const node of categoryNodes) {
      // Invert bearish nodes in bullish index calculations
      let directionalProb = node.currentProbability;
      if (node.id === 'recession_risk' || node.id === 'fed_rate_hike' || node.id === 'inflation_high') {
        directionalProb = 1 - node.currentProbability;
      }
      const weight = 1 - (node.uncertainty || 0.20);
      scoreSum += directionalProb * weight;
      weightSum += weight;
    }

    return weightSum > 0 ? Number((scoreSum / weightSum).toFixed(4)) : 0.5;
  }

  /**
   * Finds all directed causal paths connecting two nodes within max hops.
   * 
   * @param {string} fromNodeId - Origin node ID
   * @param {string} toNodeId - Target destination node ID
   * @param {number} [maxHops=3] - Maximum traversal length
   * @returns {Array<Array<WorldEdge>>}
   */
  findCausalPaths(fromNodeId, toNodeId, maxHops = 3) {
    if (!this.nodes.has(fromNodeId) || !this.nodes.has(toNodeId)) {
      return [];
    }

    const paths = [];

    const dfs = (currentId, targetId, currentPath, visitedNodes, remainingHops) => {
      if (currentId === targetId && currentPath.length > 0) {
        paths.push([...currentPath]);
        return;
      }
      if (remainingHops <= 0) return;

      const outgoing = this.edges.filter(e => e.from === currentId && e.status !== 'UNVALIDATED' && e.isActive !== false);
      for (const edge of outgoing) {
        if (!visitedNodes.has(edge.to)) {
          visitedNodes.add(edge.to);
          currentPath.push({ ...edge });
          dfs(edge.to, targetId, currentPath, visitedNodes, remainingHops - 1);
          currentPath.pop();
          visitedNodes.delete(edge.to);
        }
      }
    };

    const visited = new Set([fromNodeId]);
    dfs(fromNodeId, toNodeId, [], visited, maxHops);

    return paths;
  }

  /**
   * Generates human-readable causal reasoning explaining how sourceNode affects targetNode.
   * 
   * @param {string} sourceNodeId - Starting node
   * @param {string} targetNodeId - Destination node
   * @returns {{ connected: boolean, pathsCount: number, paths: string[], cumulativeDirection: 'POSITIVE'|'NEGATIVE'|'NEUTRAL' }}
   */
  explainRelationship(sourceNodeId, targetNodeId) {
    const paths = this.findCausalPaths(sourceNodeId, targetNodeId, 3);
    if (paths.length === 0) {
      return {
        connected: false,
        pathsCount: 0,
        paths: [],
        cumulativeDirection: 'NEUTRAL'
      };
    }

    let netSign = 0;
    const formattedPaths = paths.map(pathEdges => {
      let pathSign = 1;
      let pathWeight = 1;
      const stepStrs = pathEdges.map(e => {
        const dir = e.direction || e.relationship || 'POSITIVE';
        if (dir === 'NEGATIVE') pathSign *= -1;
        pathWeight *= e.strength;
        return `${e.from} --[${dir} (${e.strength})]--> ${e.to}`;
      });
      netSign += pathSign * pathWeight;
      return stepStrs.join(' -> ');
    });

    let cumulativeDirection = 'NEUTRAL';
    if (netSign > 0.05) cumulativeDirection = 'POSITIVE';
    else if (netSign < -0.05) cumulativeDirection = 'NEGATIVE';

    return {
      connected: true,
      pathsCount: paths.length,
      paths: formattedPaths,
      cumulativeDirection
    };
  }
}

// Instantiate singleton instance
const worldModel = new WorldModel();

module.exports = {
  WorldModel,
  worldModel,
  INITIAL_NODES,
  INITIAL_EDGES,
  PROB_MIN,
  PROB_MAX,
  DEFAULT_DAMPING_FACTOR,
  DEFAULT_MAX_DEPTH,
  isLagElapsed,
  computeEffectiveEdgeWeight
};
