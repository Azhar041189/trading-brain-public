/**
 * @file hypothesisGenerator.js
 * @module intelligence/oracle/hypothesisGenerator
 * @description Hypothesis Generator for Trading Brain's ORACLE Intelligence Layer.
 * Generates challenger hypotheses based on error distributions, post-resolution
 * diagnostics, empirical calibration reports, and market regime shifts.
 * Ranks and prioritizes hypotheses by expected performance impact.
 * 
 * Governance Notice:
 * ORACLE modules observe, score, learn, and propose.
 * They may NOT modify live execution, risk caps, or historical records.
 */

'use strict';

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('HypothesisGenerator');

/**
 * Standard Hypothesis Priorities
 * @readonly
 * @enum {string}
 */
const HYPOTHESIS_PRIORITIES = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
});

/**
 * Standard Hypothesis Categories
 * @readonly
 * @enum {string}
 */
const HYPOTHESIS_CATEGORIES = Object.freeze({
  SOURCE_WEIGHTING: 'SOURCE_WEIGHTING',
  CALIBRATION: 'CALIBRATION',
  AGENT_WEIGHTING: 'AGENT_WEIGHTING',
  REGIME_ADAPTATION: 'REGIME_ADAPTATION',
  RISK_GATE: 'RISK_GATE',
  EVIDENCE_SAMPLING: 'EVIDENCE_SAMPLING',
  CAUSAL_PRIOR: 'CAUSAL_PRIOR'
});

/**
 * @typedef {Object} Hypothesis
 * @property {string} id - Unique identifier in the format 'hyp_<timestamp>_<short_description>'
 * @property {string} hypothesis - Human-readable statement of the proposed hypothesis
 * @property {string[]} proposedChanges - Specific actionable configuration changes
 * @property {'HIGH' | 'MEDIUM' | 'LOW'} priority - Expected impact ranking
 * @property {number} confidence - Estimated probability of improvement (0.0 to 1.0)
 * @property {string} category - Classification category (e.g. SOURCE_WEIGHTING, CALIBRATION)
 * @property {string} source - Origin of the hypothesis generation trigger
 * @property {string} [rationale] - Supporting analytical rationale
 * @property {Object} [metadata] - Underlying metrics, error counts, or regime parameters
 * @property {string} createdAt - ISO 8601 timestamp
 */

/**
 * HypothesisGenerator Class
 * Analyzes empirical error distributions, probability miscalibrations,
 * and regime performance degradation to propose challenger model hypotheses.
 */
class HypothesisGenerator {
  /**
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.staleSourceCutoffHours=6] - Threshold in hours for stale evidence
   * @param {number} [options.highFalseCatalystThreshold=0.25] - False catalyst rate triggering agent weight reduction
   * @param {number} [options.overconfidenceThreshold=0.15] - Overconfidence error frequency triggering calibration shrinkage
   * @param {number} [options.eceThreshold=0.05] - Expected Calibration Error threshold triggering recalibration
   * @param {number} [options.regimeDegradationThreshold=0.20] - Relative performance degradation triggering regime adaptation
   */
  constructor(options = {}) {
    this.staleSourceCutoffHours = options.staleSourceCutoffHours || 6;
    this.highFalseCatalystThreshold = options.highFalseCatalystThreshold || 0.25;
    this.overconfidenceThreshold = options.overconfidenceThreshold || 0.15;
    this.eceThreshold = options.eceThreshold || 0.05;
    this.regimeDegradationThreshold = options.regimeDegradationThreshold || 0.20;

    logger.info('[HypothesisGenerator] Initialized with config:', {
      staleSourceCutoffHours: this.staleSourceCutoffHours,
      highFalseCatalystThreshold: this.highFalseCatalystThreshold,
      eceThreshold: this.eceThreshold
    });
  }

  /**
   * Generates a unique hypothesis identifier in the format 'hyp_<timestamp>_<short_description>'
   * 
   * @param {string} shortDescription - Short descriptive label
   * @returns {string} Formatted hypothesis ID
   * @private
   */
  _generateHypothesisId(shortDescription) {
    const timestamp = Date.now();
    const cleanDesc = (shortDescription || 'hypothesis')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 45);
    return `hyp_${timestamp}_${cleanDesc}`;
  }

  /**
   * Proposes challenger model improvements based on observed error patterns and error distributions.
   * 
   * Handled error patterns:
   * 1. SOURCE_STALE is common -> Propose 'Reduce weight of sources older than 6 hours'
   * 2. OVERCONFIDENT_MODEL is common -> Propose 'Apply stronger calibration shrinkage'
   * 3. Specific agent has high falseCatalystRate -> Propose 'Reduce agent weight for that event class'
   * 4. Additional failure patterns (SOURCE_FALSE, CONTRACT_MISREAD, REGIME_SHIFT, etc.)
   * 
   * @param {Object|Array<Object>} errorPatterns - Error distribution summary or list of error occurrences
   * @returns {Hypothesis[]} Array of generated challenger hypotheses
   */
  generateFromErrors(errorPatterns) {
    if (!errorPatterns) {
      logger.warn('[HypothesisGenerator] generateFromErrors called with empty errorPatterns');
      return [];
    }

    const hypotheses = [];
    const normalized = this._normalizeErrorPatterns(errorPatterns);
    const { totalErrors, typeCounts, agentStats, eventClassStats } = normalized;

    if (totalErrors === 0 && Object.keys(typeCounts).length === 0 && Object.keys(agentStats).length === 0) {
      return [];
    }

    const errorCountOrTotal = totalErrors > 0 ? totalErrors : 1;

    // 1. SOURCE_STALE Check
    const staleCount = typeCounts['SOURCE_STALE'] || 0;
    const staleRatio = staleCount / errorCountOrTotal;
    if (staleCount >= 2 || staleRatio >= 0.10) {
      const isHighPriority = staleRatio >= 0.25 || staleCount >= 5;
      const confidence = Number(Math.min(0.95, 0.65 + (staleRatio * 0.3) + (staleCount * 0.02)).toFixed(3));

      hypotheses.push({
        id: this._generateHypothesisId('reduce_stale_source_weights'),
        hypothesis: 'Reduce weight of sources older than 6 hours',
        proposedChanges: [
          `Enforce a strict ${this.staleSourceCutoffHours}-hour freshness decay cutoff for evidence ingestion`,
          `Apply exponential decay factor w(t) = exp(-0.15 * delta_t_hours) to older research sources`,
          `Reduce voting weight of feeds older than ${this.staleSourceCutoffHours} hours by 50% in consensus engine`
        ],
        priority: isHighPriority ? HYPOTHESIS_PRIORITIES.HIGH : HYPOTHESIS_PRIORITIES.MEDIUM,
        confidence,
        category: HYPOTHESIS_CATEGORIES.SOURCE_WEIGHTING,
        source: 'ERROR_ANALYSIS',
        rationale: `SOURCE_STALE accounted for ${staleCount} errors (${(staleRatio * 100).toFixed(1)}% of error distribution). Stale information causes lagging market entries.`,
        metadata: {
          errorType: 'SOURCE_STALE',
          errorCount: staleCount,
          errorRatio: Number(staleRatio.toFixed(4)),
          totalErrors
        },
        createdAt: new Date().toISOString()
      });
    }

    // 2. OVERCONFIDENT_MODEL Check
    const overconfidentCount = typeCounts['OVERCONFIDENT_MODEL'] || 0;
    const overconfidentRatio = overconfidentCount / errorCountOrTotal;
    if (overconfidentCount >= 2 || overconfidentRatio >= this.overconfidenceThreshold) {
      const isHighPriority = overconfidentRatio >= 0.25 || overconfidentCount >= 5;
      const confidence = Number(Math.min(0.92, 0.70 + (overconfidentRatio * 0.25) + (overconfidentCount * 0.02)).toFixed(3));

      hypotheses.push({
        id: this._generateHypothesisId('apply_stronger_calibration_shrinkage'),
        hypothesis: 'Apply stronger calibration shrinkage',
        proposedChanges: [
          'Increase Bayesian shrinkage lambda parameter from baseline to lambda = 0.25 towards uniform/market prior',
          'Apply temperature scaling with T = 1.25 on forecast logits to dampen extreme probabilities (> 0.70)',
          'Clamp maximum unverified probability outputs to bounded range [0.05, 0.95]'
        ],
        priority: isHighPriority ? HYPOTHESIS_PRIORITIES.HIGH : HYPOTHESIS_PRIORITIES.MEDIUM,
        confidence,
        category: HYPOTHESIS_CATEGORIES.CALIBRATION,
        source: 'ERROR_ANALYSIS',
        rationale: `OVERCONFIDENT_MODEL occurred ${overconfidentCount} times (${(overconfidentRatio * 100).toFixed(1)}% of errors). Models assigned high conviction to incorrect outcomes.`,
        metadata: {
          errorType: 'OVERCONFIDENT_MODEL',
          errorCount: overconfidentCount,
          errorRatio: Number(overconfidentRatio.toFixed(4)),
          totalErrors
        },
        createdAt: new Date().toISOString()
      });
    }

    // 3. Specific Agent False Catalyst Rate Check
    for (const [agentName, stats] of Object.entries(agentStats)) {
      const falseCatalystRate = typeof stats.falseCatalystRate === 'number'
        ? stats.falseCatalystRate
        : (stats.totalCatalysts > 0 ? (stats.falseCatalysts || 0) / stats.totalCatalysts : 0);

      const targetEventClass = stats.eventClass || stats.targetEventClass || 'ALL_EVENT_CLASSES';

      if (falseCatalystRate >= this.highFalseCatalystThreshold || (stats.falseCatalysts && stats.falseCatalysts >= 3)) {
        const isHighPriority = falseCatalystRate >= 0.40 || (stats.falseCatalysts && stats.falseCatalysts >= 5);
        const confidence = Number(Math.min(0.90, 0.60 + (falseCatalystRate * 0.30)).toFixed(3));
        const hypothesisText = targetEventClass !== 'ALL_EVENT_CLASSES'
          ? `Reduce ${agentName} weight for ${targetEventClass} event class`
          : `Reduce ${agentName} weight for high false catalyst rate`;

        hypotheses.push({
          id: this._generateHypothesisId(`reduce_weight_${agentName}_${targetEventClass}`),
          hypothesis: hypothesisText,
          proposedChanges: [
            `Reduce consensus voting weight of agent "${agentName}" by ${(falseCatalystRate * 100).toFixed(0)}% for event class "${targetEventClass}"`,
            `Require independent corroboration from at least one other agent before accepting catalyst triggers from "${agentName}"`,
            `Increase minimum confidence threshold for "${agentName}" catalyst detection from 0.60 to 0.75`
          ],
          priority: isHighPriority ? HYPOTHESIS_PRIORITIES.HIGH : HYPOTHESIS_PRIORITIES.MEDIUM,
          confidence,
          category: HYPOTHESIS_CATEGORIES.AGENT_WEIGHTING,
          source: 'ERROR_ANALYSIS',
          rationale: `Agent "${agentName}" exhibited a high false catalyst rate of ${(falseCatalystRate * 100).toFixed(1)}% (sample: ${stats.totalCatalysts || stats.falseCatalysts || 'N/A'}) in "${targetEventClass}".`,
          metadata: {
            agentName,
            eventClass: targetEventClass,
            falseCatalystRate: Number(falseCatalystRate.toFixed(4)),
            falseCatalysts: stats.falseCatalysts || null,
            totalCatalysts: stats.totalCatalysts || null
          },
          createdAt: new Date().toISOString()
        });
      }
    }

    // 4. Check for UNDERCONFIDENT_MODEL
    const underconfidentCount = typeCounts['UNDERCONFIDENT_MODEL'] || 0;
    const underconfidentRatio = underconfidentCount / errorCountOrTotal;
    if (underconfidentCount >= 3 || underconfidentRatio >= 0.20) {
      hypotheses.push({
        id: this._generateHypothesisId('recalibrate_underconfidence_sharpening'),
        hypothesis: 'Sharpen consensus probability sigmoid to correct underconfidence',
        proposedChanges: [
          'Apply inverse temperature scaling (T = 0.85) when multi-agent directional alignment exceeds 80%',
          'Reduce baseline prior shrinkage on high-conviction recurring catalyst patterns',
          'Recalibrate probability lower-bounds to avoid conservative clustering around 0.50'
        ],
        priority: HYPOTHESIS_PRIORITIES.MEDIUM,
        confidence: 0.74,
        category: HYPOTHESIS_CATEGORIES.CALIBRATION,
        source: 'ERROR_ANALYSIS',
        rationale: `UNDERCONFIDENT_MODEL appeared ${underconfidentCount} times (${(underconfidentRatio * 100).toFixed(1)}%), indicating excessive conservatism and missed alpha edges.`,
        metadata: {
          errorType: 'UNDERCONFIDENT_MODEL',
          errorCount: underconfidentCount,
          errorRatio: Number(underconfidentRatio.toFixed(4))
        },
        createdAt: new Date().toISOString()
      });
    }

    // 5. Check for SOURCE_FALSE
    const falseSourceCount = typeCounts['SOURCE_FALSE'] || 0;
    if (falseSourceCount >= 2) {
      hypotheses.push({
        id: this._generateHypothesisId('enforce_multi_source_verification'),
        hypothesis: 'Enforce multi-source cross-verification and downweight single-source feeds',
        proposedChanges: [
          'Require minimum 2 independent verified sources before generating directional market signals',
          'Penalize source reliability score by 40% immediately upon false report attribution',
          'Quarantine unverified social or anonymous news scrapers from primary consensus ensemble'
        ],
        priority: HYPOTHESIS_PRIORITIES.HIGH,
        confidence: 0.86,
        category: HYPOTHESIS_CATEGORIES.SOURCE_WEIGHTING,
        source: 'ERROR_ANALYSIS',
        rationale: `SOURCE_FALSE detected ${falseSourceCount} times. Unverified evidence injected erroneous conviction into predictions.`,
        metadata: {
          errorType: 'SOURCE_FALSE',
          errorCount: falseSourceCount
        },
        createdAt: new Date().toISOString()
      });
    }

    // 6. Check for CONTRACT_MISREAD
    const contractMisreadCount = typeCounts['CONTRACT_MISREAD'] || 0;
    if (contractMisreadCount >= 2) {
      hypotheses.push({
        id: this._generateHypothesisId('enforce_contract_specification_parsing'),
        hypothesis: 'Implement structured contract specification and settlement checklist verification',
        proposedChanges: [
          'Add automated resolution rule keyword scanner for expiration timestamps and timezone ambiguities',
          'Reject contracts with ambiguous or subjective settlement terms from automated trading',
          'Cross-validate contract resolution criteria with historical market settlement precedents'
        ],
        priority: HYPOTHESIS_PRIORITIES.HIGH,
        confidence: 0.88,
        category: HYPOTHESIS_CATEGORIES.RISK_GATE,
        source: 'ERROR_ANALYSIS',
        rationale: `CONTRACT_MISREAD occurred ${contractMisreadCount} times. Settlement clauses were interpreted differently from oracle outcome.`,
        metadata: {
          errorType: 'CONTRACT_MISREAD',
          errorCount: contractMisreadCount
        },
        createdAt: new Date().toISOString()
      });
    }

    logger.info(`[HypothesisGenerator] Generated ${hypotheses.length} hypotheses from error patterns`);
    return hypotheses;
  }

  /**
   * Analyzes an empirical calibration report and generates correction hypotheses if systematic bias is found.
   * 
   * Detects:
   * - Systematic over-prediction bias (mean forecast > empirical win rate)
   * - Systematic under-prediction bias (mean forecast < empirical win rate)
   * - High Expected Calibration Error (ECE > threshold)
   * - Tail miscalibration in extreme probability buckets [0.8-1.0] or [0.0-0.2]
   * 
   * @param {Object} calibrationReport - Calibration report from CalibrationMemory or diagnostic evaluator
   * @returns {Hypothesis[]} Array of generated calibration hypotheses
   */
  generateFromCalibration(calibrationReport) {
    if (!calibrationReport) {
      logger.warn('[HypothesisGenerator] generateFromCalibration called with null report');
      return [];
    }

    const hypotheses = [];
    const {
      agentName = 'ENSEMBLE',
      ece = 0,
      mce = 0,
      totalPredictions = 0,
      overallWinRate = null,
      meanForecast = null,
      buckets = [],
      bias = null
    } = calibrationReport;

    if (totalPredictions < 10 && buckets.length === 0) {
      logger.info('[HypothesisGenerator] Calibration report sample size too small for statistical hypothesis generation');
      return [];
    }

    // Compute empirical bias if not provided
    let calculatedBias = bias;
    if (calculatedBias === null && overallWinRate !== null && meanForecast !== null) {
      calculatedBias = meanForecast - overallWinRate;
    } else if (calculatedBias === null && buckets.length > 0) {
      let sumForecast = 0;
      let sumObserved = 0;
      let totalSamples = 0;
      for (const b of buckets) {
        const count = b.count || b.totalPredictions || 0;
        if (count > 0) {
          sumForecast += (b.predicted || b.meanForecast || 0) * count;
          sumObserved += (b.observed || b.observedFrequency || 0) * count;
          totalSamples += count;
        }
      }
      if (totalSamples > 0) {
        calculatedBias = (sumForecast - sumObserved) / totalSamples;
      }
    }

    // 1. Check for High Expected Calibration Error (ECE)
    if (ece > this.eceThreshold) {
      const isSevere = ece > 0.10;
      const confidence = Number(Math.min(0.95, 0.65 + (ece * 2.0) + Math.min(0.15, totalPredictions * 0.001)).toFixed(3));

      hypotheses.push({
        id: this._generateHypothesisId(`recalibrate_ece_${agentName.toLowerCase()}`),
        hypothesis: `Apply temperature scaling and PAVA isotonic regression recalibration for ${agentName}`,
        proposedChanges: [
          `Fit online Isotonic Regression using Pool Adjacent Violators Algorithm (PAVA) across probability bins`,
          `Optimize post-hoc Temperature Scaling parameter (T) via negative log-likelihood minimization`,
          `Enforce piecewise linear probability re-mapping for "${agentName}" prior to consensus aggregation`
        ],
        priority: isSevere ? HYPOTHESIS_PRIORITIES.HIGH : HYPOTHESIS_PRIORITIES.MEDIUM,
        confidence,
        category: HYPOTHESIS_CATEGORIES.CALIBRATION,
        source: 'CALIBRATION_ANALYSIS',
        rationale: `Target "${agentName}" has an Expected Calibration Error of ${(ece * 100).toFixed(2)}% (threshold: ${(this.eceThreshold * 100).toFixed(2)}%, MCE: ${(mce * 100).toFixed(2)}%). Model probabilities deviate systematically from true outcomes.`,
        metadata: {
          agentName,
          ece: Number(ece.toFixed(4)),
          mce: Number(mce.toFixed(4)),
          totalPredictions
        },
        createdAt: new Date().toISOString()
      });
    }

    // 2. Check for Systematic Over-Prediction Bias
    if (typeof calculatedBias === 'number' && calculatedBias > 0.05) {
      const confidence = Number(Math.min(0.92, 0.70 + (calculatedBias * 1.5)).toFixed(3));
      hypotheses.push({
        id: this._generateHypothesisId(`correct_overestimation_bias_${agentName.toLowerCase()}`),
        hypothesis: `Apply negative intercept offset to correct systematic over-prediction bias in ${agentName}`,
        proposedChanges: [
          `Apply negative calibration logit offset beta_0 = -${(calculatedBias * 1.8).toFixed(3)} to raw forecasts`,
          `Increase Bayesian shrinkage towards lower prior win-rate`,
          `Require higher evidence confidence before permitting probability outputs above 0.65`
        ],
        priority: HYPOTHESIS_PRIORITIES.HIGH,
        confidence,
        category: HYPOTHESIS_CATEGORIES.CALIBRATION,
        source: 'CALIBRATION_ANALYSIS',
        rationale: `Systematic positive bias detected: ${agentName} forecasts average ${(calculatedBias * 100).toFixed(2)}% higher than empirical win rates.`,
        metadata: {
          agentName,
          bias: Number(calculatedBias.toFixed(4)),
          totalPredictions
        },
        createdAt: new Date().toISOString()
      });
    }

    // 3. Check for Systematic Under-Prediction Bias
    if (typeof calculatedBias === 'number' && calculatedBias < -0.05) {
      const absBias = Math.abs(calculatedBias);
      const confidence = Number(Math.min(0.90, 0.68 + (absBias * 1.5)).toFixed(3));
      hypotheses.push({
        id: this._generateHypothesisId(`correct_underestimation_bias_${agentName.toLowerCase()}`),
        hypothesis: `Apply positive intercept offset to correct systematic under-prediction bias in ${agentName}`,
        proposedChanges: [
          `Apply positive calibration logit offset beta_0 = +${(absBias * 1.8).toFixed(3)} to raw forecasts`,
          `Boost baseline probability estimation when multi-agent momentum is positive`,
          `Decrease excessive conservative shrinkage on high-evidence signals`
        ],
        priority: HYPOTHESIS_PRIORITIES.MEDIUM,
        confidence,
        category: HYPOTHESIS_CATEGORIES.CALIBRATION,
        source: 'CALIBRATION_ANALYSIS',
        rationale: `Systematic negative bias detected: ${agentName} forecasts average ${(absBias * 100).toFixed(2)}% lower than empirical win rates.`,
        metadata: {
          agentName,
          bias: Number(calculatedBias.toFixed(4)),
          totalPredictions
        },
        createdAt: new Date().toISOString()
      });
    }

    // 4. Check for Extreme Probability Bucket Miscalibration
    if (buckets && buckets.length > 0) {
      const highBucket = buckets[buckets.length - 1]; // e.g. 90-100% or 80-100%
      const highPredicted = highBucket?.predicted ?? highBucket?.meanForecast ?? 0;
      const highObserved = highBucket?.observed ?? highBucket?.observedFrequency ?? 0;
      const highCount = highBucket?.count ?? highBucket?.totalPredictions ?? 0;

      if (highCount >= 5 && highPredicted >= 0.80 && (highPredicted - highObserved) > 0.15) {
        hypotheses.push({
          id: this._generateHypothesisId(`dampen_extreme_bullish_tail_${agentName.toLowerCase()}`),
          hypothesis: `Apply asymmetric tail shrinkage on high-conviction (> 80%) forecasts for ${agentName}`,
          proposedChanges: [
            `Compress upper probability decile [0.80, 1.00] using non-linear sigmoid damping`,
            `Cap maximum uncalibrated confidence at 0.85 until 50+ out-of-sample wins are verified`,
            `Widen uncertainty interval bounds when prediction enters highest probability decile`
          ],
          priority: HYPOTHESIS_PRIORITIES.HIGH,
          confidence: 0.87,
          category: HYPOTHESIS_CATEGORIES.CALIBRATION,
          source: 'CALIBRATION_ANALYSIS',
          rationale: `In the highest bucket (${highBucket.rangeLabel || '80-100%'}), predicted probability was ${(highPredicted * 100).toFixed(1)}% but realized win rate was only ${(highObserved * 100).toFixed(1)}% (gap: ${((highPredicted - highObserved) * 100).toFixed(1)}%).`,
          metadata: {
            bucket: highBucket.rangeLabel || 'high_bucket',
            predicted: highPredicted,
            observed: highObserved,
            sampleCount: highCount
          },
          createdAt: new Date().toISOString()
        });
      }
    }

    logger.info(`[HypothesisGenerator] Generated ${hypotheses.length} calibration hypotheses for ${agentName}`);
    return hypotheses;
  }

  /**
   * Generates hypotheses when model performance degrades under a specific market regime.
   * 
   * @param {string} currentRegime - Current market regime (e.g., 'VOLATILE', 'RISK_OFF', 'BEAR', 'CRISIS')
   * @param {Object} historicalPerformance - Performance breakdown across regimes or baseline comparison
   * @returns {Hypothesis[]} Array of generated regime adaptation hypotheses
   */
  generateFromRegimeShift(currentRegime, historicalPerformance) {
    if (!currentRegime || !historicalPerformance) {
      logger.warn('[HypothesisGenerator] generateFromRegimeShift called with invalid inputs');
      return [];
    }

    const hypotheses = [];
    const regimeKey = currentRegime.toUpperCase();

    // Extract regime metrics and baseline
    let regimeMetrics = null;
    let baselineBrier = 0.15;
    let baselineAccuracy = 0.70;
    let baselineLogLoss = 0.40;

    if (historicalPerformance.byRegime && historicalPerformance.byRegime[regimeKey]) {
      regimeMetrics = historicalPerformance.byRegime[regimeKey];
    } else if (historicalPerformance[regimeKey]) {
      regimeMetrics = historicalPerformance[regimeKey];
    } else if (historicalPerformance.currentRegimeMetrics) {
      regimeMetrics = historicalPerformance.currentRegimeMetrics;
    }

    if (historicalPerformance.baseline) {
      baselineBrier = historicalPerformance.baseline.brierScore || baselineBrier;
      baselineAccuracy = historicalPerformance.baseline.accuracy || baselineAccuracy;
      baselineLogLoss = historicalPerformance.baseline.logLoss || baselineLogLoss;
    } else if (historicalPerformance.avgBrierScore) {
      baselineBrier = historicalPerformance.avgBrierScore;
      baselineAccuracy = historicalPerformance.directionalAccuracy || baselineAccuracy;
    }

    if (!regimeMetrics) {
      logger.info(`[HypothesisGenerator] No historical performance records found for regime "${regimeKey}"`);
      return [];
    }

    const regimeBrier = regimeMetrics.avgBrierScore ?? regimeMetrics.brierScore ?? null;
    const regimeAccuracy = regimeMetrics.accuracy ?? regimeMetrics.directionalAccuracy ?? null;
    const regimeLogLoss = regimeMetrics.avgLogLoss ?? regimeMetrics.logLoss ?? null;
    const sampleSize = regimeMetrics.resolvedCount ?? regimeMetrics.sampleSize ?? regimeMetrics.totalPredictions ?? 0;

    if (sampleSize < 3) {
      logger.info(`[HypothesisGenerator] Sample size (${sampleSize}) in regime "${regimeKey}" insufficient for robust hypothesis generation`);
      return [];
    }

    // Check for Brier Score degradation
    const brierDegraded = regimeBrier !== null && regimeBrier > (baselineBrier * (1 + this.regimeDegradationThreshold));
    const accuracyDegraded = regimeAccuracy !== null && regimeAccuracy < (baselineAccuracy * (1 - this.regimeDegradationThreshold));

    if (brierDegraded || accuracyDegraded) {
      const brierDeltaPercent = regimeBrier !== null ? ((regimeBrier - baselineBrier) / baselineBrier) * 100 : 0;
      const isSevere = brierDeltaPercent > 40 || (regimeAccuracy !== null && regimeAccuracy < 0.50);
      const confidence = Number(Math.min(0.92, 0.65 + (Math.min(50, sampleSize) * 0.005) + (Math.min(50, brierDeltaPercent) * 0.004)).toFixed(3));

      hypotheses.push({
        id: this._generateHypothesisId(`adapt_weights_for_regime_${regimeKey.toLowerCase()}`),
        hypothesis: `Adapt ensemble weighting and probability dampening for ${regimeKey} regime`,
        proposedChanges: [
          `Increase probability shrinkage towards uniform 0.50 prior by 35% when market regime is "${regimeKey}"`,
          `Dynamically upweight defensive and macro-volatility agents while reducing momentum agent allocations`,
          `Widen uncertainty confidence intervals by 25% under "${regimeKey}" conditions to prevent over-betting`,
          `Require higher catalyst confirmation thresholds before committing capital in "${regimeKey}"`
        ],
        priority: isSevere ? HYPOTHESIS_PRIORITIES.HIGH : HYPOTHESIS_PRIORITIES.MEDIUM,
        confidence,
        category: HYPOTHESIS_CATEGORIES.REGIME_ADAPTATION,
        source: 'REGIME_SHIFT_ANALYSIS',
        rationale: `Model performance in "${regimeKey}" degraded significantly: Brier score was ${regimeBrier?.toFixed(4)} vs baseline ${baselineBrier.toFixed(4)} (+${brierDeltaPercent.toFixed(1)}%), Accuracy: ${regimeAccuracy ? (regimeAccuracy * 100).toFixed(1) + '%' : 'N/A'} (sample: ${sampleSize}).`,
        metadata: {
          currentRegime: regimeKey,
          regimeBrier,
          baselineBrier,
          regimeAccuracy,
          baselineAccuracy,
          sampleSize,
          brierDeltaPercent: Number(brierDeltaPercent.toFixed(2))
        },
        createdAt: new Date().toISOString()
      });
    }

    // Check individual agent performance within regime if available
    if (regimeMetrics.agentPerformance) {
      for (const [agentName, agentStat] of Object.entries(regimeMetrics.agentPerformance)) {
        const agentBrier = agentStat.avgBrierScore ?? agentStat.brierScore;
        const agentSamples = agentStat.resolvedCount ?? agentStat.sampleSize ?? 0;
        if (agentSamples >= 3 && agentBrier !== null && agentBrier > (baselineBrier * 1.5)) {
          hypotheses.push({
            id: this._generateHypothesisId(`downweight_${agentName.toLowerCase()}_in_${regimeKey.toLowerCase()}`),
            hypothesis: `Downweight ${agentName} agent allocations under ${regimeKey} regime`,
            proposedChanges: [
              `Reduce ${agentName} consensus weight by 45% specifically during "${regimeKey}" regime`,
              `Apply stricter risk gating on signals generated by ${agentName} in "${regimeKey}"`
            ],
            priority: HYPOTHESIS_PRIORITIES.MEDIUM,
            confidence: 0.78,
            category: HYPOTHESIS_CATEGORIES.AGENT_WEIGHTING,
            source: 'REGIME_SHIFT_ANALYSIS',
            rationale: `Agent "${agentName}" performed poorly in "${regimeKey}" with Brier score ${agentBrier.toFixed(4)} across ${agentSamples} forecasts.`,
            metadata: {
              agentName,
              currentRegime: regimeKey,
              agentBrier,
              agentSamples
            },
            createdAt: new Date().toISOString()
          });
        }
      }
    }

    logger.info(`[HypothesisGenerator] Generated ${hypotheses.length} regime hypotheses for "${regimeKey}"`);
    return hypotheses;
  }

  /**
   * Sorts and prioritizes hypotheses by expected performance impact.
   * Ranking combines:
   * 1. Priority tier (HIGH = 3, MEDIUM = 2, LOW = 1)
   * 2. Confidence level (0.0 to 1.0)
   * 3. Underlying error frequency / sample support bonus
   * 
   * @param {Hypothesis[]} hypotheses - List of generated hypotheses
   * @returns {Hypothesis[]} Sorted hypotheses in descending order of expected impact
   */
  prioritize(hypotheses) {
    if (!Array.isArray(hypotheses) || hypotheses.length === 0) {
      return [];
    }

    const priorityWeights = {
      [HYPOTHESIS_PRIORITIES.HIGH]: 3.0,
      [HYPOTHESIS_PRIORITIES.MEDIUM]: 2.0,
      [HYPOTHESIS_PRIORITIES.LOW]: 1.0
    };

    const scored = hypotheses.map((hyp, index) => {
      const pWeight = priorityWeights[hyp.priority] || 1.0;
      const conf = typeof hyp.confidence === 'number' ? Math.max(0, Math.min(1, hyp.confidence)) : 0.5;

      // Frequency / sample size bonus from metadata
      let sampleBonus = 0;
      if (hyp.metadata) {
        const count = hyp.metadata.errorCount || hyp.metadata.sampleSize || hyp.metadata.totalPredictions || 0;
        sampleBonus = Math.min(0.5, count * 0.02);
      }

      // Expected Impact Score
      const impactScore = (pWeight * 0.6) + (conf * 0.4) + sampleBonus;

      return {
        ...hyp,
        impactScore: Number(impactScore.toFixed(4)),
        originalIndex: index
      };
    });

    // Sort descending by impactScore, then by confidence, preserving stable order
    scored.sort((a, b) => {
      if (b.impactScore !== a.impactScore) {
        return b.impactScore - a.impactScore;
      }
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return a.originalIndex - b.originalIndex;
    });

    // Remove internal sorting index helper
    return scored.map(({ originalIndex, ...cleanHyp }) => cleanHyp);
  }

  /**
   * Normalizes error pattern inputs into a consistent structured representation.
   * 
   * @param {Object|Array<Object>} input - Raw error patterns input
   * @returns {Object} Structured error pattern representation
   * @private
   */
  _normalizeErrorPatterns(input) {
    const result = {
      totalErrors: 0,
      typeCounts: {},
      agentStats: {},
      eventClassStats: {}
    };

    if (!input) return result;

    // Case 1: Array of error attributions or error records
    if (Array.isArray(input)) {
      result.totalErrors = input.length;
      for (const item of input) {
        const type = item.primaryError || item.errorType || item.type || (typeof item === 'string' ? item : null);
        if (type) {
          result.typeCounts[type] = (result.typeCounts[type] || 0) + 1;
        }

        const agent = item.agent || item.agentName || item.responsibleAgent;
        const eventClass = item.eventClass || item.targetEventClass || 'ALL_EVENT_CLASSES';

        if (agent) {
          if (!result.agentStats[agent]) {
            result.agentStats[agent] = {
              totalCatalysts: 0,
              falseCatalysts: 0,
              falseCatalystRate: 0,
              eventClass
            };
          }
          result.agentStats[agent].totalCatalysts += 1;
          if (type === 'SOURCE_FALSE' || item.isFalseCatalyst || item.falseCatalyst) {
            result.agentStats[agent].falseCatalysts += 1;
          }
          result.agentStats[agent].falseCatalystRate =
            result.agentStats[agent].falseCatalysts / result.agentStats[agent].totalCatalysts;
        }

        if (eventClass && eventClass !== 'ALL_EVENT_CLASSES') {
          result.eventClassStats[eventClass] = (result.eventClassStats[eventClass] || 0) + 1;
        }
      }
      return result;
    }

    // Case 2: Structured summary object from ErrorAttributionEngine or telemetry
    if (typeof input === 'object') {
      if (typeof input.totalErrors === 'number') {
        result.totalErrors = input.totalErrors;
      }

      // Check for byType or direct error counts
      const countsSource = input.byType || input.typeCounts || input.errorCounts || input;
      for (const [key, val] of Object.entries(countsSource)) {
        if (typeof val === 'number' && key !== 'totalErrors') {
          result.typeCounts[key] = val;
          if (!input.totalErrors) {
            result.totalErrors += val;
          }
        }
      }

      // Check for agent level false catalyst rates
      const agentSource = input.agentFalseCatalystRates || input.agentStats || input.agents || {};
      for (const [agentName, val] of Object.entries(agentSource)) {
        if (typeof val === 'number') {
          result.agentStats[agentName] = {
            falseCatalystRate: val,
            eventClass: 'ALL_EVENT_CLASSES'
          };
        } else if (typeof val === 'object' && val !== null) {
          result.agentStats[agentName] = {
            falseCatalystRate: val.falseCatalystRate || (val.totalCatalysts ? (val.falseCatalysts || 0) / val.totalCatalysts : 0),
            falseCatalysts: val.falseCatalysts || 0,
            totalCatalysts: val.totalCatalysts || 0,
            eventClass: val.eventClass || val.targetEventClass || 'ALL_EVENT_CLASSES'
          };
        }
      }

      return result;
    }

    return result;
  }
}

// Instantiate singleton instance
const hypothesisGenerator = new HypothesisGenerator();

module.exports = {
  HypothesisGenerator,
  hypothesisGenerator,
  HYPOTHESIS_PRIORITIES,
  HYPOTHESIS_CATEGORIES
};
