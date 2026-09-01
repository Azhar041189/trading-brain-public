/**
 * MetaLearningEngine - Controlled Meta-Learning & Champion/Challenger Engine
 * ORACLE Intelligence Layer - Trading Brain
 * 
 * Governance Notice & Invariants:
 * ---------------------------------------------------------------------------
 * The ORACLE Meta-Learning Engine observes performance, identifies failure patterns,
 * formulates hypotheses, proposes weight adjustments, and validates challenger
 * models offline and through shadow forward observation.
 * 
 * STRICT GOVERNANCE INVARIANTS ENFORCED IN CODE:
 * - MAY: identify failure patterns, propose hypotheses, propose weight changes,
 *        run offline experiments, compare candidate models.
 * - MAY NOT: modify live execution, modify risk limits/caps, deploy models without
 *            explicit human approval, activate live trading, or rewrite historical evidence.
 * ---------------------------------------------------------------------------
 * 
 * Persistence Target: data/oracle/meta_learning.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('MetaLearningEngine');

/**
 * Clamping epsilon for log-loss computation to avoid numerical singularities
 */
const LOG_LOSS_EPSILON = 1e-15;

/**
 * Default baseline champion metrics
 */
const DEFAULT_INITIAL_CHAMPION = {
  modelId: 'champion_v1',
  promotedAt: new Date().toISOString(),
  brierScore: 0.1500,
  logLoss: 0.4500,
  calibrationECE: 0.0400,
  totalForecasts: 100
};

/**
 * Governance Invariant Definition
 */
const GOVERNANCE_INVARIANTS = Object.freeze({
  MAY: [
    'IDENTIFY_FAILURE_PATTERNS',
    'PROPOSE_HYPOTHESES',
    'PROPOSE_WEIGHT_CHANGES',
    'RUN_OFFLINE_EXPERIMENTS',
    'COMPARE_CANDIDATES',
    'RECORD_FORWARD_OBSERVATION',
    'REQUEST_PROMOTION'
  ],
  MAY_NOT: [
    'CHANGE_PRODUCTION_MODEL_WITHOUT_HUMAN_APPROVAL',
    'CHANGE_RISK_LIMITS',
    'DEPLOY_AUTONOMOUSLY',
    'ACTIVATE_LIVE_TRADING',
    'REWRITE_HISTORICAL_EVIDENCE'
  ]
});

/**
 * Safely writes data to a JSON file atomically using a temporary staging file.
 * Handles Windows file locking gracefully.
 * 
 * @param {string} filePath - Absolute path to target JSON file
 * @param {any} data - Serializable payload
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
 * Calculates Expected Calibration Error (ECE) across 10 decile buckets [0.0-0.1, ..., 0.9-1.0].
 * 
 * @param {Array<{ forecast: number, outcome: number }>} samples - Array of forecast (0-1) and outcome (0 or 1)
 * @param {number} [numBuckets=10]
 * @returns {number} ECE value in [0, 1]
 */
function computeECE(samples, numBuckets = 10) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;

  const validSamples = samples.filter(s => 
    typeof s.forecast === 'number' && !isNaN(s.forecast) &&
    (s.outcome === 0 || s.outcome === 1)
  );

  if (validSamples.length === 0) return 0;

  let totalWeightedError = 0;

  for (let i = 0; i < numBuckets; i++) {
    const low = i / numBuckets;
    const high = (i + 1) / numBuckets;

    const inBucket = validSamples.filter(s => {
      if (i === numBuckets - 1) {
        return s.forecast >= low && s.forecast <= high;
      }
      return s.forecast >= low && s.forecast < high;
    });

    const count = inBucket.length;
    if (count > 0) {
      const sumForecast = inBucket.reduce((acc, s) => acc + s.forecast, 0);
      const sumOutcome = inBucket.reduce((acc, s) => acc + s.outcome, 0);
      const avgForecast = sumForecast / count;
      const actualRate = sumOutcome / count;
      const calError = Math.abs(avgForecast - actualRate);

      totalWeightedError += (count / validSamples.length) * calError;
    }
  }

  return Number(totalWeightedError.toFixed(4));
}

/**
 * Computes mean Brier Score for an array of forecast-outcome pairs
 * 
 * @param {Array<{ forecast: number, outcome: number }>} samples 
 * @returns {number|null}
 */
function computeBrierScore(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const valid = samples.filter(s => typeof s.forecast === 'number' && !isNaN(s.forecast) && (s.outcome === 0 || s.outcome === 1));
  if (valid.length === 0) return null;

  const sumSq = valid.reduce((acc, s) => acc + Math.pow(s.forecast - s.outcome, 2), 0);
  return Number((sumSq / valid.length).toFixed(5));
}

/**
 * Computes mean Log Loss for an array of forecast-outcome pairs
 * 
 * @param {Array<{ forecast: number, outcome: number }>} samples 
 * @returns {number|null}
 */
function computeLogLoss(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const valid = samples.filter(s => typeof s.forecast === 'number' && !isNaN(s.forecast) && (s.outcome === 0 || s.outcome === 1));
  if (valid.length === 0) return null;

  const sumLoss = valid.reduce((acc, s) => {
    const p = Math.max(LOG_LOSS_EPSILON, Math.min(1 - LOG_LOSS_EPSILON, s.forecast));
    const y = s.outcome;
    return acc + (-(y * Math.log(p) + (1 - y) * Math.log(1 - p)));
  }, 0);

  return Number((sumLoss / valid.length).toFixed(5));
}

/**
 * MetaLearningEngine
 * 
 * Orchestrates continuous meta-learning, failure pattern diagnosis,
 * hypothesis formulation, and champion/challenger governance.
 */
class MetaLearningEngine {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.storagePath] - Custom absolute path to meta_learning.json
   */
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.resolve(__dirname, '../../../data/oracle/meta_learning.json');

    /**
     * Engine state container
     * @type {Object}
     */
    this.data = {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      currentChampion: { ...DEFAULT_INITIAL_CHAMPION },
      challengers: [],
      learningHistory: [],
      latestAnalysis: null
    };

    // Load persisted state
    this.load();
  }

  /**
   * Loads state from persistent storage file.
   * If file does not exist, initializes defaults and persists.
   */
  load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        if (raw.trim().length > 0) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            this.data = {
              version: parsed.version || '1.0.0',
              lastUpdated: parsed.lastUpdated || new Date().toISOString(),
              currentChampion: parsed.currentChampion || { ...DEFAULT_INITIAL_CHAMPION },
              challengers: Array.isArray(parsed.challengers) ? parsed.challengers : [],
              learningHistory: Array.isArray(parsed.learningHistory) ? parsed.learningHistory : [],
              latestAnalysis: parsed.latestAnalysis || null
            };
            logger.info(`[MetaLearningEngine] Loaded meta-learning state. Current Champion: ${this.data.currentChampion.modelId}, Active Challengers: ${this.data.challengers.length}`);
            return;
          }
        }
      }

      // Initialize fresh file
      this.data = {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        currentChampion: { ...DEFAULT_INITIAL_CHAMPION },
        challengers: [],
        learningHistory: [
          {
            eventId: `evt_${Date.now()}_init`,
            timestamp: new Date().toISOString(),
            eventType: 'ENGINE_INITIALIZED',
            details: { initialChampion: DEFAULT_INITIAL_CHAMPION.modelId }
          }
        ],
        latestAnalysis: null
      };
      this._persist();
      logger.info(`[MetaLearningEngine] Initialized fresh meta-learning state at ${this.storagePath}`);
    } catch (err) {
      logger.error(`[MetaLearningEngine] Error loading state: ${err.message}`, { error: err });
    }
  }

  /**
   * Persists in-memory state to disk atomically
   * @private
   */
  _persist() {
    try {
      this.data.lastUpdated = new Date().toISOString();
      atomicWriteJsonSync(this.storagePath, this.data);
    } catch (err) {
      logger.error(`[MetaLearningEngine] Failed to persist meta-learning state: ${err.message}`, { error: err });
      throw err;
    }
  }

  /**
   * Enforces strict governance invariants, throwing descriptive errors
   * if any unauthorized operational boundary is crossed.
   * 
   * @param {string} action 
   * @param {Object} [context={}] 
   * @private
   */
  _assertGovernanceInvariant(action, context = {}) {
    if (GOVERNANCE_INVARIANTS.MAY_NOT.includes(action)) {
      const err = new Error(`[Governance Violation] Forbidden action '${action}': MetaLearningEngine may NOT modify live execution, alter risk caps, activate live trading, or deploy without human authorization.`);
      logger.error(err.message, { context });
      throw err;
    }
  }

  /**
   * Records an audit event to the chronological learning history
   * 
   * @param {string} eventType 
   * @param {Object} details 
   * @private
   */
  _recordHistory(eventType, details = {}) {
    const entry = {
      eventId: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      eventType,
      details
    };
    this.data.learningHistory.push(entry);
    return entry;
  }

  /**
   * Analyzes forecasting performance across memory modules to identify systematic weaknesses.
   * 
   * Improvement Detection Rules:
   * 1. If ECE > 0.10 for any agent: suggest recalibration
   * 2. If brierSkill < 0 for any agent on any eventClass: suggest reducing that agent's weight
   * 3. If ensemble consistently worse than best individual: suggest different weighting scheme
   * 
   * @param {Object|Array} [episodicMemory] - Episodic memory instance, object with episodes, or array of episodes
   * @param {Object} [calibrationMemory] - Calibration memory instance or structured calibration metrics
   * @param {Object} [agentReputationEngine] - Agent reputation / weighting engine
   * @returns {Object} Comprehensive performance analysis and proposed improvement hypotheses
   */
  analyzePerformance(episodicMemory = null, calibrationMemory = null, agentReputationEngine = null) {
    logger.info('[MetaLearningEngine] Commencing systematic performance and failure pattern analysis...');

    // 1. Extract resolved episodes
    let episodes = [];
    if (Array.isArray(episodicMemory)) {
      episodes = episodicMemory;
    } else if (episodicMemory && typeof episodicMemory.getAllEpisodes === 'function') {
      episodes = episodicMemory.getAllEpisodes();
    } else if (episodicMemory && episodicMemory.episodes instanceof Map) {
      episodes = Array.from(episodicMemory.episodes.values());
    } else {
      // Attempt to load from default episodic memory storage if available
      try {
        const defaultEpisodicPath = path.resolve(__dirname, '../../../data/oracle/episodic_memory.json');
        if (fs.existsSync(defaultEpisodicPath)) {
          const raw = fs.readFileSync(defaultEpisodicPath, 'utf8');
          const parsed = JSON.parse(raw);
          episodes = Array.isArray(parsed) ? parsed : (parsed.episodes || []);
        }
      } catch (_) {}
    }

    const resolvedEpisodes = episodes.filter(ep => ep && (ep.outcome === 'YES' || ep.outcome === 'NO' || ep.outcome === 1 || ep.outcome === 0));

    // Data structures for aggregation
    const agentSamples = {};          // agent -> Array<{ forecast, outcome, eventClass, brier, logLoss }>
    const agentClassStats = {};       // agent -> eventClass -> { count, sumBrier, sumRefBrier }
    const ensembleSamples = [];       // Array<{ forecast, outcome, eventClass, brier, logLoss }>
    const pairedAgentEnsemble = {};    // agent -> { ensembleBrierSum, agentBrierSum, count }

    for (const ep of resolvedEpisodes) {
      const outcomeVal = (ep.outcome === 'YES' || ep.outcome === 1 || ep.outcome === true) ? 1 : 0;
      const eventClass = String(ep.eventClass || 'GENERAL').toUpperCase().trim();

      // Benchmark reference price (e.g. market price or climatology/uninformative 0.5)
      const refForecast = (typeof ep.marketPrice === 'number' && !isNaN(ep.marketPrice))
        ? Math.max(0, Math.min(1, ep.marketPrice))
        : 0.5;
      const refBrier = Math.pow(refForecast - outcomeVal, 2);

      // Ensemble forecast
      const ensForecast = (typeof ep.calibratedForecast === 'number' && !isNaN(ep.calibratedForecast))
        ? ep.calibratedForecast
        : (typeof ep.ensembleForecast === 'number' && !isNaN(ep.ensembleForecast) ? ep.ensembleForecast : null);

      if (ensForecast !== null) {
        const ensBrier = Math.pow(ensForecast - outcomeVal, 2);
        const clamped = Math.max(LOG_LOSS_EPSILON, Math.min(1 - LOG_LOSS_EPSILON, ensForecast));
        const ensLogLoss = -(outcomeVal * Math.log(clamped) + (1 - outcomeVal) * Math.log(1 - clamped));

        ensembleSamples.push({
          forecast: ensForecast,
          outcome: outcomeVal,
          eventClass,
          brier: ensBrier,
          logLoss: ensLogLoss
        });
      }

      // Individual agent forecasts
      const agentForecasts = ep.agentForecasts || {};
      for (const [agent, rawP] of Object.entries(agentForecasts)) {
        if (typeof rawP !== 'number' || isNaN(rawP)) continue;
        const p = Math.max(0, Math.min(1, rawP));
        const agentBrier = Math.pow(p - outcomeVal, 2);
        const clamped = Math.max(LOG_LOSS_EPSILON, Math.min(1 - LOG_LOSS_EPSILON, p));
        const agentLogLoss = -(outcomeVal * Math.log(clamped) + (1 - outcomeVal) * Math.log(1 - clamped));

        if (!agentSamples[agent]) agentSamples[agent] = [];
        agentSamples[agent].push({
          forecast: p,
          outcome: outcomeVal,
          eventClass,
          brier: agentBrier,
          logLoss: agentLogLoss
        });

        // EventClass stats
        if (!agentClassStats[agent]) agentClassStats[agent] = {};
        if (!agentClassStats[agent][eventClass]) {
          agentClassStats[agent][eventClass] = { count: 0, sumBrier: 0, sumRefBrier: 0 };
        }
        agentClassStats[agent][eventClass].count++;
        agentClassStats[agent][eventClass].sumBrier += agentBrier;
        agentClassStats[agent][eventClass].sumRefBrier += refBrier;

        // Paired comparison with ensemble on same episodes
        if (ensForecast !== null) {
          if (!pairedAgentEnsemble[agent]) {
            pairedAgentEnsemble[agent] = { ensembleBrierSum: 0, agentBrierSum: 0, count: 0 };
          }
          pairedAgentEnsemble[agent].count++;
          pairedAgentEnsemble[agent].agentBrierSum += agentBrier;
          pairedAgentEnsemble[agent].ensembleBrierSum += Math.pow(ensForecast - outcomeVal, 2);
        }
      }
    }

    // 2. Compute Agent Level Metrics
    const agentMetrics = {};
    const identifiedWeaknesses = [];
    const proposedHypotheses = [];

    for (const [agent, samples] of Object.entries(agentSamples)) {
      const brierScore = computeBrierScore(samples);
      const logLoss = computeLogLoss(samples);
      
      // Calculate ECE from samples or calibrationMemory
      let ece = computeECE(samples);
      if (calibrationMemory) {
        if (typeof calibrationMemory.getAgentECE === 'function') {
          const memEce = calibrationMemory.getAgentECE(agent);
          if (typeof memEce === 'number') ece = memEce;
        } else if (calibrationMemory.calibrationByAgent && calibrationMemory.calibrationByAgent[agent]?.expectedCalibrationError) {
          ece = calibrationMemory.calibrationByAgent[agent].expectedCalibrationError;
        }
      }

      // Event class performance & Brier Skill Scores
      const classBreakdown = {};
      for (const [eClass, stat] of Object.entries(agentClassStats[agent] || {})) {
        const avgAgentBrier = stat.count > 0 ? stat.sumBrier / stat.count : null;
        const avgRefBrier = stat.count > 0 ? stat.sumRefBrier / stat.count : 0.25;
        const bss = avgRefBrier > 0 && avgAgentBrier !== null ? 1.0 - (avgAgentBrier / avgRefBrier) : 0;

        classBreakdown[eClass] = {
          sampleSize: stat.count,
          avgBrierScore: avgAgentBrier !== null ? Number(avgAgentBrier.toFixed(4)) : null,
          avgRefBrier: Number(avgRefBrier.toFixed(4)),
          brierSkillScore: Number(bss.toFixed(4))
        };

        // RULE 2: If brierSkill < 0 for any agent on any eventClass -> suggest reducing that agent's weight
        if (bss < 0 && stat.count >= 1) {
          const weakness = {
            id: `W_${Date.now()}_${agent}_${eClass}`,
            type: 'NEGATIVE_BRIER_SKILL',
            agent,
            eventClass: eClass,
            metric: 'brierSkillScore',
            value: Number(bss.toFixed(4)),
            agentBrier: Number(avgAgentBrier.toFixed(4)),
            benchmarkBrier: Number(avgRefBrier.toFixed(4)),
            sampleSize: stat.count,
            description: `Agent '${agent}' exhibits negative Brier Skill Score (${bss.toFixed(4)}) on event class '${eClass}', underperforming baseline benchmark.`,
            suggestedAction: `Reduce voting weight for agent '${agent}' when forecasting '${eClass}' events.`
          };
          identifiedWeaknesses.push(weakness);

          proposedHypotheses.push({
            hypothesisId: `hyp_${Date.now()}_downweight_${agent}_${eClass}`,
            agent,
            eventClass: eClass,
            type: 'WEIGHT_REDUCTION',
            hypothesis: `Downweighting agent '${agent}' in the '${eClass}' domain by 50% will reduce aggregate ensemble Brier score.`,
            proposedChanges: [
              `Adjust dynamic consensus matrix: decrease ${agent} weight multiplier for ${eClass} from 1.00 to 0.40`,
              `Route higher confidence weight to alternative specialists in ${eClass}`
            ]
          });
        }
      }

      agentMetrics[agent] = {
        totalForecasts: samples.length,
        brierScore,
        logLoss,
        calibrationECE: ece,
        classBreakdown
      };

      // RULE 1: If ECE > 0.10 for any agent -> suggest recalibration
      if (ece > 0.10 && samples.length >= 1) {
        const weakness = {
          id: `W_${Date.now()}_${agent}_ECE`,
          type: 'HIGH_CALIBRATION_ERROR',
          agent,
          metric: 'calibrationECE',
          value: ece,
          threshold: 0.10,
          sampleSize: samples.length,
          description: `Agent '${agent}' has high Expected Calibration Error (${(ece * 100).toFixed(1)}% > 10.0%). Confidence intervals are uncalibrated.`,
          suggestedAction: `Recalibrate '${agent}' probability curve via Platt scaling or Isotonic mapping.`
        };
        identifiedWeaknesses.push(weakness);

        proposedHypotheses.push({
          hypothesisId: `hyp_${Date.now()}_recalibrate_${agent}`,
          agent,
          type: 'RECALIBRATION',
          hypothesis: `Applying isotonic regression / Platt recalibration mapping to agent '${agent}' will reduce ECE below 0.05 without sacrificing resolution.`,
          proposedChanges: [
            `Train 10-bin isotonic calibrator on agent '${agent}' historical outputs`,
            `Apply pre-ensemble sigmoid calibration layer to '${agent}' probabilities`
          ]
        });
      }
    }

    // 3. Compute Ensemble Level Metrics & Compare with Best Individual
    const ensembleBrier = computeBrierScore(ensembleSamples);
    const ensembleLogLoss = computeLogLoss(ensembleSamples);
    const ensembleECE = computeECE(ensembleSamples);

    const ensembleMetrics = {
      totalForecasts: ensembleSamples.length,
      brierScore: ensembleBrier,
      logLoss: ensembleLogLoss,
      calibrationECE: ensembleECE
    };

    // RULE 3: If ensemble consistently worse than best individual -> suggest different weighting scheme
    let bestIndividualAgent = null;
    let bestIndividualBrier = Infinity;

    for (const [agent, paired] of Object.entries(pairedAgentEnsemble)) {
      if (paired.count >= 2) {
        const avgAgentBrier = paired.agentBrierSum / paired.count;
        const avgEnsBrier = paired.ensembleBrierSum / paired.count;

        if (avgAgentBrier < bestIndividualBrier) {
          bestIndividualBrier = avgAgentBrier;
          bestIndividualAgent = agent;
        }

        if (avgEnsBrier > avgAgentBrier + 0.005) {
          // Ensemble is worse than this individual agent
          const weakness = {
            id: `W_${Date.now()}_ENSEMBLE_VS_${agent}`,
            type: 'SUBOPTIMAL_ENSEMBLE_WEIGHTING',
            agent,
            ensembleBrier: Number(avgEnsBrier.toFixed(4)),
            individualBrier: Number(avgAgentBrier.toFixed(4)),
            sampleSize: paired.count,
            description: `Ensemble Brier score (${avgEnsBrier.toFixed(4)}) is worse than individual agent '${agent}' (${avgAgentBrier.toFixed(4)}) on shared sample of ${paired.count} events.`,
            suggestedAction: `Switch from static/equal ensemble weighting to performance-weighted or Bayesian dynamic aggregation.`
          };
          identifiedWeaknesses.push(weakness);
        }
      }
    }

    if (bestIndividualAgent && bestIndividualBrier < (ensembleBrier ?? Infinity) - 0.005) {
      proposedHypotheses.push({
        hypothesisId: `hyp_${Date.now()}_ensemble_weighting_scheme`,
        type: 'ENSEMBLE_AGGREGATION_UPGRADE',
        hypothesis: `Dynamic Brier-skill-weighted aggregation will outperform static ensemble weighting and beat individual agent '${bestIndividualAgent}'.`,
        proposedChanges: [
          `Implement inverse-Brier dynamic score weighting in consensus engine`,
          `Apply entropy-regularized softmax weight allocation across active agents`
        ]
      });
    }

    const analysisReport = {
      timestamp: new Date().toISOString(),
      totalResolvedEpisodesAnalyzed: resolvedEpisodes.length,
      championModelId: this.data.currentChampion.modelId,
      agentMetrics,
      ensembleMetrics,
      identifiedWeaknesses,
      proposedHypotheses,
      activeChallengerCount: this.data.challengers.filter(c => c.validationStatus === 'PENDING' || c.validationStatus === 'VALIDATING').length,
      governanceNotice: 'All findings are purely diagnostic. No operational or risk changes have been made.'
    };

    this.data.latestAnalysis = analysisReport;
    this._persist();

    logger.info(`[MetaLearningEngine] Analysis complete: ${identifiedWeaknesses.length} weaknesses identified, ${proposedHypotheses.length} hypotheses proposed.`);
    return analysisReport;
  }

  /**
   * Generates a new Challenger model entry to test an improvement hypothesis offline.
   * 
   * @param {string} hypothesis - The scientific or empirical hypothesis being evaluated
   * @param {string[]|string} proposedChanges - Specific configuration or algorithmic changes proposed
   * @param {Object} [metadata={}] - Optional metadata (e.g. weights, parameters, model configuration)
   * @returns {Object} Created challenger record
   */
  generateChallenger(hypothesis, proposedChanges, metadata = {}) {
    if (!hypothesis || typeof hypothesis !== 'string' || hypothesis.trim().length === 0) {
      throw new Error('[MetaLearningEngine] generateChallenger requires a non-empty hypothesis string');
    }

    const changes = Array.isArray(proposedChanges)
      ? proposedChanges.map(String)
      : (proposedChanges ? [String(proposedChanges)] : []);

    if (changes.length === 0) {
      throw new Error('[MetaLearningEngine] generateChallenger requires at least one proposed change');
    }

    const challengerId = `challenger_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const createdAt = new Date().toISOString();

    const challenger = {
      challengerId,
      createdAt,
      hypothesis: hypothesis.trim(),
      proposedChanges: changes,
      validationStatus: 'PENDING',
      backtest: null,
      forwardObservation: null,
      humanApprovalRequired: true,
      humanApproved: false,
      metadata: metadata && typeof metadata === 'object' ? metadata : {}
    };

    this.data.challengers.push(challenger);
    this._recordHistory('CHALLENGER_CREATED', { challengerId, hypothesis, proposedChanges: changes });
    this._persist();

    logger.info(`[MetaLearningEngine] Generated new challenger: ${challengerId} | Hypothesis: "${hypothesis.substring(0, 60)}..."`);
    return challenger;
  }

  /**
   * Runs an offline backtest for a challenger model against historical episodes.
   * 
   * @param {string} challengerId - Unique challenger identifier
   * @param {Array<Object>|Object} historicalData - Array of episodes or EpisodicMemory instance
   * @param {Object} [options={}] - Optional custom simulation evaluation options
   * @param {Function} [options.simulator] - Custom (episode) => probability simulation function
   * @returns {Object} Backtest outcome summary
   */
  runBacktest(challengerId, historicalData, options = {}) {
    const challenger = this.getChallenger(challengerId);
    if (!challenger) {
      throw new Error(`[MetaLearningEngine] Challenger ${challengerId} not found for backtesting`);
    }

    challenger.validationStatus = 'VALIDATING';

    let episodes = [];
    if (Array.isArray(historicalData)) {
      episodes = historicalData;
    } else if (historicalData && typeof historicalData.getAllEpisodes === 'function') {
      episodes = historicalData.getAllEpisodes();
    } else if (historicalData && historicalData.episodes instanceof Map) {
      episodes = Array.from(historicalData.episodes.values());
    }

    const resolved = episodes.filter(ep => ep && (ep.outcome === 'YES' || ep.outcome === 'NO' || ep.outcome === 1 || ep.outcome === 0));

    const samples = [];
    const customSimulator = typeof options.simulator === 'function' ? options.simulator : null;

    for (const ep of resolved) {
      const y = (ep.outcome === 'YES' || ep.outcome === 1 || ep.outcome === true) ? 1 : 0;
      let p = null;

      if (customSimulator) {
        try {
          const simResult = customSimulator(ep);
          if (typeof simResult === 'number' && !isNaN(simResult)) {
            p = Math.max(0, Math.min(1, simResult));
          }
        } catch (simErr) {
          logger.warn(`[MetaLearningEngine] Backtest custom simulator failed on episode ${ep.episodeId}: ${simErr.message}`);
        }
      }

      if (p === null) {
        // Fallback simulation: calibrated -> ensemble -> average of agents
        if (typeof ep.calibratedForecast === 'number') {
          p = ep.calibratedForecast;
        } else if (typeof ep.ensembleForecast === 'number') {
          p = ep.ensembleForecast;
        } else if (ep.agentForecasts && Object.keys(ep.agentForecasts).length > 0) {
          const vals = Object.values(ep.agentForecasts);
          p = vals.reduce((a, b) => a + b, 0) / vals.length;
        } else {
          p = 0.5;
        }
      }

      samples.push({ forecast: p, outcome: y });
    }

    const sampleSize = samples.length;
    const brierScore = computeBrierScore(samples) ?? 0.25;
    const logLoss = computeLogLoss(samples) ?? 0.6931;

    const backtestResult = {
      brierScore: Number(brierScore.toFixed(5)),
      logLoss: Number(logLoss.toFixed(5)),
      sampleSize,
      completedAt: new Date().toISOString()
    };

    challenger.backtest = backtestResult;

    // Evaluate backtest pass/fail relative to champion
    const championBrier = this.data.currentChampion.brierScore ?? 0.25;
    if (sampleSize > 0 && brierScore <= championBrier * 1.05) {
      challenger.validationStatus = 'PASSED';
    } else if (sampleSize > 0 && brierScore > championBrier * 1.15) {
      challenger.validationStatus = 'FAILED';
    } else {
      challenger.validationStatus = 'VALIDATING';
    }

    this._recordHistory('BACKTEST_COMPLETED', {
      challengerId,
      backtest: backtestResult,
      validationStatus: challenger.validationStatus
    });
    this._persist();

    logger.info(`[MetaLearningEngine] Backtest complete for ${challengerId}: Brier=${backtestResult.brierScore}, LogLoss=${backtestResult.logLoss}, N=${sampleSize}, Status=${challenger.validationStatus}`);
    return backtestResult;
  }

  /**
   * Begins parallel forward shadow observation for a challenger model.
   * 
   * @param {string} challengerId 
   * @returns {Object} Updated challenger record
   */
  startForwardObservation(challengerId) {
    const challenger = this.getChallenger(challengerId);
    if (!challenger) {
      throw new Error(`[MetaLearningEngine] Challenger ${challengerId} not found`);
    }

    if (challenger.validationStatus === 'REJECTED') {
      throw new Error(`[MetaLearningEngine] Cannot start forward observation on rejected challenger ${challengerId}`);
    }

    challenger.forwardObservation = {
      brierScore: null,
      logLoss: null,
      sampleSize: 0,
      startedAt: new Date().toISOString(),
      observations: []
    };
    challenger.validationStatus = 'VALIDATING';

    this._recordHistory('FORWARD_OBSERVATION_STARTED', { challengerId, startedAt: challenger.forwardObservation.startedAt });
    this._persist();

    logger.info(`[MetaLearningEngine] Forward shadow observation started for challenger ${challengerId}`);
    return challenger;
  }

  /**
   * Records a forward shadow forecast and its verified outcome for a challenger.
   * 
   * @param {string} challengerId 
   * @param {number} forecast - Predicted probability in [0, 1]
   * @param {string|number|boolean} outcome - Realized binary outcome ('YES'/'NO', 1/0, true/false)
   * @param {Object} [metadata={}] - Optional context (eventId, question, timestamp)
   * @returns {Object} Updated forwardObservation metrics
   */
  recordChallengerForecast(challengerId, forecast, outcome, metadata = {}) {
    const challenger = this.getChallenger(challengerId);
    if (!challenger) {
      throw new Error(`[MetaLearningEngine] Challenger ${challengerId} not found`);
    }

    if (typeof forecast !== 'number' || isNaN(forecast)) {
      throw new Error(`[MetaLearningEngine] Invalid forecast probability: ${forecast}`);
    }

    const clampedForecast = Math.max(0, Math.min(1, forecast));
    let y = 0;
    if (outcome === 'YES' || outcome === 1 || outcome === true || String(outcome).toUpperCase() === 'YES') {
      y = 1;
    } else if (outcome === 'NO' || outcome === 0 || outcome === false || String(outcome).toUpperCase() === 'NO') {
      y = 0;
    } else {
      throw new Error(`[MetaLearningEngine] Invalid outcome value: ${outcome}. Expected 'YES'|'NO'|1|0|true|false`);
    }

    if (!challenger.forwardObservation) {
      this.startForwardObservation(challengerId);
    }

    const obs = {
      timestamp: new Date().toISOString(),
      forecast: Number(clampedForecast.toFixed(4)),
      outcome: y,
      eventId: metadata.eventId || null,
      question: metadata.question || null
    };

    if (!Array.isArray(challenger.forwardObservation.observations)) {
      challenger.forwardObservation.observations = [];
    }

    challenger.forwardObservation.observations.push(obs);
    const count = challenger.forwardObservation.observations.length;
    challenger.forwardObservation.sampleSize = count;

    // Compute rolling Brier Score and Log Loss
    const brier = computeBrierScore(challenger.forwardObservation.observations);
    const logLoss = computeLogLoss(challenger.forwardObservation.observations);

    challenger.forwardObservation.brierScore = brier;
    challenger.forwardObservation.logLoss = logLoss;

    this._persist();

    logger.info(`[MetaLearningEngine] Recorded forecast for ${challengerId}: p=${obs.forecast}, outcome=${y} | Rolling Brier=${brier}, N=${count}`);
    return {
      challengerId,
      brierScore: brier,
      logLoss,
      sampleSize: count,
      startedAt: challenger.forwardObservation.startedAt
    };
  }

  /**
   * Evaluates a challenger against the current champion across all scoring metrics.
   * 
   * @param {string} challengerId 
   * @returns {Object} Comprehensive evaluation report and recommendation
   */
  evaluateChallenger(challengerId) {
    const challenger = this.getChallenger(challengerId);
    if (!challenger) {
      throw new Error(`[MetaLearningEngine] Challenger ${challengerId} not found`);
    }

    const champ = this.data.currentChampion;
    const backtest = challenger.backtest;
    const forward = challenger.forwardObservation;

    // Determine primary metrics for challenger: prefer forward observation if sample >= 5, else backtest
    let challengerBrier = null;
    let challengerLogLoss = null;
    let primarySource = 'NONE';
    let sampleSize = 0;

    if (forward && typeof forward.brierScore === 'number' && forward.sampleSize >= 5) {
      challengerBrier = forward.brierScore;
      challengerLogLoss = forward.logLoss;
      primarySource = 'FORWARD_OBSERVATION';
      sampleSize = forward.sampleSize;
    } else if (backtest && typeof backtest.brierScore === 'number') {
      challengerBrier = backtest.brierScore;
      challengerLogLoss = backtest.logLoss;
      primarySource = 'BACKTEST';
      sampleSize = backtest.sampleSize;
    } else if (forward && typeof forward.brierScore === 'number') {
      challengerBrier = forward.brierScore;
      challengerLogLoss = forward.logLoss;
      primarySource = 'FORWARD_OBSERVATION_PRELIMINARY';
      sampleSize = forward.sampleSize;
    }

    if (challengerBrier === null) {
      return {
        challengerId,
        evaluationStatus: 'INSUFFICIENT_DATA',
        verdict: 'INSUFFICIENT_DATA',
        recommendation: 'RUN_BACKTEST_OR_FORWARD_OBSERVATION',
        message: 'No backtest or forward observation scores available for evaluation.',
        currentChampion: champ,
        challenger
      };
    }

    const champBrier = champ.brierScore ?? 0.25;
    const champLogLoss = champ.logLoss ?? 0.6931;

    const brierDifference = Number((challengerBrier - champBrier).toFixed(5)); // Negative = challenger is better
    const logLossDifference = Number((challengerLogLoss - champLogLoss).toFixed(5));
    const brierImprovementPct = Number((((champBrier - challengerBrier) / champBrier) * 100).toFixed(2));

    let verdict = 'COMPARABLE';
    let recommendation = 'CONTINUE_FORWARD_OBSERVATION';

    if (sampleSize < 5) {
      verdict = 'INSUFFICIENT_DATA';
      recommendation = 'GATHER_MORE_OBSERVATIONS';
    } else if (brierDifference <= -0.010) {
      verdict = 'SUPERIOR';
      recommendation = 'READY_FOR_PROMOTION_REQUEST';
    } else if (brierDifference >= 0.020) {
      verdict = 'INFERIOR';
      recommendation = 'REVISE_OR_REJECT';
    } else {
      verdict = 'COMPARABLE';
      recommendation = 'CONTINUE_FORWARD_OBSERVATION';
    }

    const evaluation = {
      challengerId,
      hypothesis: challenger.hypothesis,
      primarySource,
      sampleSize,
      comparison: {
        champion: {
          modelId: champ.modelId,
          brierScore: champBrier,
          logLoss: champLogLoss,
          totalForecasts: champ.totalForecasts
        },
        challenger: {
          brierScore: challengerBrier,
          logLoss: challengerLogLoss,
          sampleSize
        },
        brierDifference,          // Negative means challenger is better
        logLossDifference,        // Negative means challenger is better
        brierImprovementPct       // Positive means challenger is better
      },
      verdict,
      recommendation,
      evaluatedAt: new Date().toISOString()
    };

    logger.info(`[MetaLearningEngine] Evaluation for ${challengerId}: Verdict=${verdict}, BrierDiff=${brierDifference}, Imp=${brierImprovementPct}%`);
    return evaluation;
  }

  /**
   * Flags a challenger model for human promotion approval.
   * Sets humanApprovalRequired = true, humanApproved = false.
   * 
   * @param {string} challengerId 
   * @returns {Object} Promotion request record
   */
  requestPromotion(challengerId) {
    const challenger = this.getChallenger(challengerId);
    if (!challenger) {
      throw new Error(`[MetaLearningEngine] Challenger ${challengerId} not found`);
    }

    if (challenger.validationStatus === 'REJECTED' || challenger.validationStatus === 'FAILED') {
      throw new Error(`[MetaLearningEngine] Cannot request promotion for challenger with status '${challenger.validationStatus}'`);
    }

    challenger.humanApprovalRequired = true;
    challenger.humanApproved = false;
    challenger.validationStatus = 'PASSED';
    challenger.promotionRequestedAt = new Date().toISOString();

    this._recordHistory('PROMOTION_REQUESTED', {
      challengerId,
      hypothesis: challenger.hypothesis,
      requestedAt: challenger.promotionRequestedAt
    });
    this._persist();

    logger.info(`[MetaLearningEngine] Promotion requested for ${challengerId}. Strict governance requires explicit human approval.`);
    return {
      success: true,
      challengerId,
      humanApprovalRequired: true,
      humanApproved: false,
      validationStatus: challenger.validationStatus,
      message: 'Promotion requested. Governance rule: requires explicit human approval before champion promotion.'
    };
  }

  /**
   * Human authorization method to approve a challenger for promotion.
   * 
   * @param {string} challengerId 
   * @param {string} [approver='HUMAN_OPERATOR'] 
   * @returns {Object} Updated challenger record
   */
  approveChallenger(challengerId, approver = 'HUMAN_OPERATOR') {
    const challenger = this.getChallenger(challengerId);
    if (!challenger) {
      throw new Error(`[MetaLearningEngine] Challenger ${challengerId} not found`);
    }

    challenger.humanApproved = true;
    challenger.approvedBy = String(approver);
    challenger.approvedAt = new Date().toISOString();

    this._recordHistory('CHALLENGER_HUMAN_APPROVED', {
      challengerId,
      approvedBy: challenger.approvedBy,
      approvedAt: challenger.approvedAt
    });
    this._persist();

    logger.info(`[MetaLearningEngine] Challenger ${challengerId} granted human approval by ${approver}`);
    return challenger;
  }

  /**
   * Promotes a challenger model to Champion ONLY IF human approval has been granted.
   * 
   * STRICT GOVERNANCE INVARIANT:
   * Throws an error if humanApproved !== true.
   * 
   * @param {string} challengerId 
   * @returns {Object} Promotion receipt and updated champion record
   */
  promoteChallenger(challengerId) {
    const challenger = this.getChallenger(challengerId);
    if (!challenger) {
      throw new Error(`[MetaLearningEngine] Challenger ${challengerId} not found`);
    }

    // STRICT GOVERNANCE CHECK: Human approval is mandatory
    if (challenger.humanApproved !== true) {
      this._assertGovernanceInvariant('CHANGE_PRODUCTION_MODEL_WITHOUT_HUMAN_APPROVAL', { challengerId });
      throw new Error(`[Governance Violation] Cannot promote challenger ${challengerId}: humanApproved is false. MetaLearningEngine is strictly prohibited from autonomously modifying production models or activating live changes without human approval.`);
    }

    if (challenger.validationStatus === 'REJECTED') {
      throw new Error(`[MetaLearningEngine] Cannot promote rejected challenger ${challengerId}`);
    }

    const previousChampion = {
      ...this.data.currentChampion,
      demotedAt: new Date().toISOString()
    };

    // Calculate updated champion metrics from challenger
    const newBrier = challenger.forwardObservation?.brierScore ?? challenger.backtest?.brierScore ?? this.data.currentChampion.brierScore;
    const newLogLoss = challenger.forwardObservation?.logLoss ?? challenger.backtest?.logLoss ?? this.data.currentChampion.logLoss;
    const newForecasts = (challenger.forwardObservation?.sampleSize || 0) + (challenger.backtest?.sampleSize || 0);

    this.data.currentChampion = {
      modelId: challenger.challengerId,
      promotedAt: new Date().toISOString(),
      brierScore: Number(Number(newBrier).toFixed(4)),
      logLoss: Number(Number(newLogLoss).toFixed(4)),
      calibrationECE: challenger.metadata?.calibrationECE ?? this.data.currentChampion.calibrationECE ?? 0.04,
      totalForecasts: newForecasts > 0 ? newForecasts : (this.data.currentChampion.totalForecasts + 1)
    };

    challenger.validationStatus = 'PROMOTED';
    challenger.promotedAt = this.data.currentChampion.promotedAt;

    this._recordHistory('CHALLENGER_PROMOTED', {
      challengerId,
      previousChampion,
      newChampion: this.data.currentChampion,
      approvedBy: challenger.approvedBy
    });
    this._persist();

    logger.info(`[MetaLearningEngine] Challenger ${challengerId} successfully promoted to current Champion after human authorization.`);
    return {
      success: true,
      currentChampion: this.data.currentChampion,
      previousChampion
    };
  }

  /**
   * Rejects a challenger model.
   * 
   * @param {string} challengerId 
   * @param {string} [reason='Operator rejected'] 
   * @returns {Object} Updated challenger record
   */
  rejectChallenger(challengerId, reason = 'Operator rejected') {
    const challenger = this.getChallenger(challengerId);
    if (!challenger) {
      throw new Error(`[MetaLearningEngine] Challenger ${challengerId} not found`);
    }

    challenger.validationStatus = 'REJECTED';
    challenger.rejectedAt = new Date().toISOString();
    challenger.rejectionReason = String(reason);

    this._recordHistory('CHALLENGER_REJECTED', {
      challengerId,
      reason,
      rejectedAt: challenger.rejectedAt
    });
    this._persist();

    logger.info(`[MetaLearningEngine] Challenger ${challengerId} rejected. Reason: ${reason}`);
    return challenger;
  }

  /**
   * Returns a comprehensive summary of identified weaknesses and active challenger models.
   * 
   * @returns {Object} Improvement report
   */
  getImprovementReport() {
    const activeChallengers = this.data.challengers.filter(c =>
      c.validationStatus !== 'PROMOTED' && c.validationStatus !== 'REJECTED'
    );

    const pastPromoted = this.data.challengers.filter(c => c.validationStatus === 'PROMOTED');
    const pastRejected = this.data.challengers.filter(c => c.validationStatus === 'REJECTED');

    return {
      timestamp: new Date().toISOString(),
      currentChampion: this.data.currentChampion,
      activeChallengersCount: activeChallengers.length,
      totalChallengersCount: this.data.challengers.length,
      activeChallengers,
      summaryStats: {
        promotedCount: pastPromoted.length,
        rejectedCount: pastRejected.length,
        pendingValidationCount: activeChallengers.length
      },
      latestAnalysisSummary: this.data.latestAnalysis ? {
        analyzedAt: this.data.latestAnalysis.timestamp,
        weaknessesFound: this.data.latestAnalysis.identifiedWeaknesses?.length || 0,
        hypothesesProposed: this.data.latestAnalysis.proposedHypotheses?.length || 0,
        weaknesses: this.data.latestAnalysis.identifiedWeaknesses || [],
        proposedHypotheses: this.data.latestAnalysis.proposedHypotheses || []
      } : null,
      governanceInvariants: {
        status: 'ENFORCED',
        humanApprovalMandatory: true,
        autonomousLiveTradingProhibited: true,
        statement: 'ORACLE MetaLearningEngine is strictly advisory and offline-experimental. No production live models, execution risk caps, or historical records have been modified.'
      }
    };
  }

  /**
   * Returns all recorded past challenger lifecycle events.
   * 
   * @returns {Array<Object>} Chronological list of learning history events
   */
  getLearningHistory() {
    return [...this.data.learningHistory];
  }

  /**
   * Retrieves a specific challenger by identifier.
   * 
   * @param {string} challengerId 
   * @returns {Object|null}
   */
  getChallenger(challengerId) {
    return this.data.challengers.find(c => c.challengerId === challengerId) || null;
  }

  /**
   * Returns all challenger records.
   * 
   * @returns {Array<Object>}
   */
  getAllChallengers() {
    return [...this.data.challengers];
  }

  /**
   * Returns the current champion model metadata.
   * 
   * @returns {Object}
   */
  getCurrentChampion() {
    return { ...this.data.currentChampion };
  }

  /**
   * Resets internal state to defaults (primarily for testing and staging verification).
   */
  reset() {
    this.data = {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      currentChampion: { ...DEFAULT_INITIAL_CHAMPION },
      challengers: [],
      learningHistory: [
        {
          eventId: `evt_${Date.now()}_reset`,
          timestamp: new Date().toISOString(),
          eventType: 'ENGINE_RESET',
          details: {}
        }
      ],
      latestAnalysis: null
    };
    this._persist();
    logger.info('[MetaLearningEngine] State reset to initial champion baseline.');
  }
}

// Instantiate singleton instance
const metaLearningEngine = new MetaLearningEngine();

module.exports = {
  MetaLearningEngine,
  metaLearningEngine,
  GOVERNANCE_INVARIANTS
};
