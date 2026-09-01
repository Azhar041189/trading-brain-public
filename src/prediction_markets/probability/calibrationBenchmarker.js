/**
 * 📊 Prediction Market Calibration & Statistical Benchmark Engine (Phase P2)
 * 
 * Evaluates proper scoring rules (Brier Score, Log Loss) where lower is strictly better.
 * Computes Brier Skill Score (BSS) vs Polymarket Implied Market Price.
 * Runs paired event-clustered bootstrap confidence intervals to prove genuine statistical skill.
 */

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('CalibrationBenchmarker');

class CalibrationBenchmarker {
  constructor() {
    this.forecastObservations = []; // Array of { eventId, pModel, pMarket, resolvedOutcome (1 or 0), metadata }
  }

  /**
   * Add a resolved forecast observation
   * @param {Object} obs - { eventId, pModel, pMarket, outcome: 1|0, timestamp }
   */
  addResolvedObservation(obs) {
    if (!obs || obs.outcome === undefined || obs.pModel === undefined || obs.pMarket === undefined) {
      throw new Error('Invalid observation: eventId, pModel, pMarket, and outcome (1 or 0) are required.');
    }

    const clean = {
      eventId: obs.eventId || `evt_${Date.now()}`,
      pModel: Math.max(0.001, Math.min(0.999, obs.pModel)),
      pMarket: Math.max(0.001, Math.min(0.999, obs.pMarket)),
      outcome: obs.outcome === 1 || obs.outcome === true ? 1 : 0,
      timestamp: obs.timestamp || new Date().toISOString()
    };

    this.forecastObservations.push(clean);
    return clean;
  }

  /**
   * Calculate Brier Score (lower is strictly better, 0 = perfect)
   * @param {Array<Object>} observations 
   * @param {'pModel'|'pMarket'} targetKey 
   */
  calculateBrierScore(observations = this.forecastObservations, targetKey = 'pModel') {
    if (!observations || observations.length === 0) return null;

    const sumSq = observations.reduce((acc, obs) => {
      const p = obs[targetKey];
      const y = obs.outcome;
      return acc + Math.pow(p - y, 2);
    }, 0);

    return parseFloat((sumSq / observations.length).toFixed(5));
  }

  /**
   * Calculate Log Loss (lower is strictly better)
   * @param {Array<Object>} observations 
   * @param {'pModel'|'pMarket'} targetKey 
   */
  calculateLogLoss(observations = this.forecastObservations, targetKey = 'pModel') {
    if (!observations || observations.length === 0) return null;

    const sumLoss = observations.reduce((acc, obs) => {
      const p = obs[targetKey];
      const y = obs.outcome;
      const loss = -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      return acc + loss;
    }, 0);

    return parseFloat((sumLoss / observations.length).toFixed(5));
  }

  /**
   * Calculate Brier Skill Score vs Market Benchmark (BSS = 1 - BS_model / BS_market)
   * Positive BSS (> 0) means model is strictly superior to the market.
   */
  calculateBrierSkillScore(observations = this.forecastObservations) {
    const bsModel = this.calculateBrierScore(observations, 'pModel');
    const bsMarket = this.calculateBrierScore(observations, 'pMarket');

    if (bsModel === null || bsMarket === null || bsMarket === 0) return 0;

    const bss = 1.0 - (bsModel / bsMarket);
    return parseFloat(bss.toFixed(5));
  }

  /**
   * Compute full-range 10-bin calibration table (0-9%, 10-19%, ..., 90-100%)
   */
  calculateReliabilityBins(observations = this.forecastObservations) {
    const binRanges = [
      { name: '00-09%', min: 0.00, max: 0.099 },
      { name: '10-19%', min: 0.10, max: 0.199 },
      { name: '20-29%', min: 0.20, max: 0.299 },
      { name: '30-39%', min: 0.30, max: 0.399 },
      { name: '40-49%', min: 0.40, max: 0.499 },
      { name: '50-59%', min: 0.50, max: 0.599 },
      { name: '60-69%', min: 0.60, max: 0.699 },
      { name: '70-79%', min: 0.70, max: 0.799 },
      { name: '80-89%', min: 0.80, max: 0.899 },
      { name: '90-100%', min: 0.90, max: 1.000 }
    ];

    return binRanges.map(bin => {
      const matching = observations.filter(o => o.pModel >= bin.min && o.pModel <= bin.max);
      const count = matching.length;
      const avgPredicted = count > 0 ? matching.reduce((s, o) => s + o.pModel, 0) / count : (bin.min + bin.max) / 2;
      const actualResolutions = count > 0 ? matching.filter(o => o.outcome === 1).length : 0;
      const empiricalFrequency = count > 0 ? actualResolutions / count : 0;
      const calibrationDelta = count > 0 ? Math.abs(empiricalFrequency - avgPredicted) : 0;

      return {
        bin: bin.name,
        count,
        avgPredicted: parseFloat(avgPredicted.toFixed(4)),
        empiricalFrequency: parseFloat(empiricalFrequency.toFixed(4)),
        calibrationDelta: parseFloat(calibrationDelta.toFixed(4))
      };
    });
  }

  /**
   * Run paired event-clustered bootstrap for score improvement confidence interval
   * @param {Array<Object>} observations 
   * @param {number} iterations - Number of bootstrap resamples (default: 1000)
   */
  runPairedEventBootstrap(arg1 = this.forecastObservations, arg2 = 1000) {
    let observations = Array.isArray(arg1) ? arg1 : this.forecastObservations;
    let iterations = typeof arg1 === 'number' ? arg1 : (typeof arg2 === 'number' ? arg2 : 1000);

    if (!observations || observations.length < 2) {
      return {
        sufficientData: false,
        totalEventsClustered: 0,
        confidenceInterval95: { lower: 0, upper: 0 },
        meanDelta: 0,
        skillConfirmed: false,
        reason: 'Requires resolved events for bootstrap'
      };
    }

    // Cluster observations by eventId (prevent pseudo-replication bias)
    const eventMap = new Map();
    observations.forEach(o => {
      if (!eventMap.has(o.eventId)) eventMap.set(o.eventId, []);
      eventMap.get(o.eventId).push(o);
    });

    const uniqueEvents = Array.from(eventMap.keys());
    const eventCount = uniqueEvents.length;

    // Calculate empirical delta per event: Delta_i = BS_market,i - BS_model,i (Positive = Model is better)
    const eventDeltas = uniqueEvents.map(eventId => {
      const list = eventMap.get(eventId);
      const bsModel = list.reduce((s, o) => s + Math.pow(o.pModel - o.outcome, 2), 0) / list.length;
      const bsMarket = list.reduce((s, o) => s + Math.pow(o.pMarket - o.outcome, 2), 0) / list.length;
      return bsMarket - bsModel; // Positive = Model beat Market
    });

    const bootstrapMeans = [];
    for (let b = 0; b < iterations; b++) {
      let sampleSum = 0;
      for (let i = 0; i < eventCount; i++) {
        const randIdx = Math.floor(Math.random() * eventCount);
        sampleSum += eventDeltas[randIdx];
      }
      bootstrapMeans.push(sampleSum / eventCount);
    }

    bootstrapMeans.sort((a, b) => a - b);
    const lowIdx = Math.floor(iterations * 0.025);
    const highIdx = Math.floor(iterations * 0.975);

    const ciLow = parseFloat(bootstrapMeans[lowIdx].toFixed(5));
    const ciHigh = parseFloat(bootstrapMeans[highIdx].toFixed(5));
    const meanDelta = parseFloat((eventDeltas.reduce((s, d) => s + d, 0) / eventCount).toFixed(5));

    // Skill is confirmed if lower 95% CI bound is strictly > 0
    const skillConfirmed = ciLow > 0;

    return {
      sufficientData: true,
      uniqueEventsCount: eventCount,
      totalEventsClustered: eventCount,
      totalObservations: observations.length,
      meanDelta,
      ci95: [ciLow, ciHigh],
      confidenceInterval95: { lower: ciLow, upper: ciHigh },
      skillConfirmed,
      iterations
    };
  }

  /**
   * Run full statistical calibration benchmark report
   */
  generateComprehensiveReport() {
    const obs = this.forecastObservations;
    const bsModel = this.calculateBrierScore(obs, 'pModel');
    const bsMarket = this.calculateBrierScore(obs, 'pMarket');
    const bss = this.calculateBrierSkillScore(obs);
    const logLossModel = this.calculateLogLoss(obs, 'pModel');
    const logLossMarket = this.calculateLogLoss(obs, 'pMarket');
    const bootstrap = this.runPairedEventBootstrap(obs);
    const bins = this.calculateReliabilityBins(obs);

    const forecastGatePassed = (bsModel !== null && bsMarket !== null && bsModel < bsMarket && (bootstrap.skillConfirmed || obs.length < 30));

    return {
      totalObservations: obs.length,
      brierScore: {
        model: bsModel,
        market: bsMarket,
        skillScore: bss,
        improvementPct: parseFloat((bss * 100).toFixed(2))
      },
      logLoss: {
        model: logLossModel,
        market: logLossMarket,
        modelSuperior: logLossModel < logLossMarket
      },
      bootstrap,
      reliabilityBins: bins,
      forecastGatePassed,
      evaluatedAt: new Date().toISOString()
    };
  }
}

const calibrationBenchmarker = new CalibrationBenchmarker();
module.exports = { CalibrationBenchmarker, calibrationBenchmarker };
