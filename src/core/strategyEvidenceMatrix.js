const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('StrategyEvidenceMatrix');

/**
 * Strategy Evidence & Health Matrix
 * Produces an exhaustive 8-pillar Evidence Score (0–100) combining:
 * 1. In-Sample Sharpe / Profit Factor (15%)
 * 2. Out-of-Sample Efficiency (20%)
 * 3. Walk-Forward Stability (15%)
 * 4. Regime Alignment Fit (15%)
 * 5. Drawdown & MAE Tolerance (15%)
 * 6. Friction & Slippage Resilience (10%)
 * 7. Sample Size / Statistical Significance (10%)
 */
class StrategyEvidenceMatrix {
  constructor() {
    this.evidenceLedger = new Map();
  }

  /**
   * Compute comprehensive evidence score for a strategy or validated hypothesis
   */
  evaluateEvidence(strategyId, validationReport, regime = 'TRENDING_BULL') {
    if (!validationReport || !validationReport.metrics) {
      throw new Error('Validation report metrics required for evidence evaluation');
    }

    const { inSample, outOfSample, walkForwardEfficiency, monteCarlo } = validationReport.metrics;

    // Safe PF normalization (handles null/infinite PF when losses are 0)
    const safeISPF = inSample.profitFactor !== null ? inSample.profitFactor : 2.0;
    const safeOOSPF = outOfSample.profitFactor !== null ? outOfSample.profitFactor : 2.0;

    // Pillar 1: In-Sample Performance (0-100)
    const p1 = Math.min(100, Math.max(0, (inSample.sharpe / 2.5) * 50 + (safeISPF / 2.0) * 50));

    // Pillar 2: Out-of-Sample Consistency (0-100)
    const p2 = Math.min(100, Math.max(0, (outOfSample.winRate / 65.0) * 50 + (safeOOSPF / 1.8) * 50));

    // Pillar 3: Walk-Forward Stability (0-100)
    let p3 = Math.min(100, Math.max(0, walkForwardEfficiency));
    // Penalize if WFE is low (<40%) despite high reported PF (divergence penalty)
    if (walkForwardEfficiency < 40 && safeOOSPF > 2.0) {
      p3 = Math.max(20, p3 * 0.7);
    }

    // Pillar 4: Regime Alignment Fit (0-100)
    const targetRegime = validationReport.strategyType === 'MOMENTUM_BREAKOUT' ? 'TRENDING_BULL' : 'SIDEWAYS_RANGE';
    const p4 = (regime === targetRegime) ? 95 : 55;

    // Pillar 5: Drawdown & MAE Resilience (0-100)
    const p5 = Math.min(100, Math.max(0, 100 - Math.abs(monteCarlo.simulated95thPercentileDD) * 4));

    // Pillar 6: Friction Resilience (0-100)
    const p6 = safeOOSPF > 1.25 ? 90 : 60;

    // Pillar 7: Sample Size Statistical Significance & Loss Sample Penalty (0-100)
    const totalTrades = inSample.trades + outOfSample.trades;
    let p7 = Math.min(100, Math.max(20, (totalTrades / 50) * 100));
    // If total losses across OOS is 0, penalize statistical confidence (insufficient loss sample)
    if (outOfSample.losses === 0) {
      p7 = Math.min(p7, 50); // Cap statistical significance at 50 when zero adverse trades observed
    }

    // Weighted Composite Evidence Score
    const compositeScore = Math.round(
      p1 * 0.15 +
      p2 * 0.20 +
      p3 * 0.15 +
      p4 * 0.15 +
      p5 * 0.15 +
      p6 * 0.10 +
      p7 * 0.10
    );

    // Determine Lifecycle Stage
    // Enforces strict safety boundary: Quant validation can ONLY promote to PAPER_PROBATION.
    // LIVE_ACTIVE strictly requires live/paper execution tracking and explicit operator activation.
    let lifecycleStage = 'RESEARCH';
    let allocationRecommendation = 'MAINTAIN';

    if (validationReport.passed && validationReport.sampleStatus === 'SUFFICIENT') {
      lifecycleStage = 'PAPER_PROBATION';
      allocationRecommendation = compositeScore >= 80 ? 'MAINTAIN' : 'REDUCE_50_PCT';
    } else if (validationReport.recommendation === 'INSUFFICIENT_SAMPLE') {
      lifecycleStage = 'RESEARCH';
      allocationRecommendation = 'RETIRE';
    } else if (compositeScore >= 55 && !validationReport.isOverfit) {
      lifecycleStage = 'WALK_FORWARD_APPROVED';
      allocationRecommendation = 'REDUCE_50_PCT';
    } else {
      lifecycleStage = 'REJECTED_OVERFIT';
      allocationRecommendation = 'RETIRE';
    }

    const evidenceCard = {
      strategyId,
      compositeScore,
      lifecycleStage,
      allocationRecommendation,
      pillars: {
        inSamplePerformance: Math.round(p1),
        outOfSampleConsistency: Math.round(p2),
        walkForwardStability: Math.round(p3),
        regimeAlignment: Math.round(p4),
        drawdownResilience: Math.round(p5),
        frictionResilience: Math.round(p6),
        statisticalSignificance: Math.round(p7)
      },
      evaluatedAt: new Date().toISOString()
    };

    this.evidenceLedger.set(strategyId, evidenceCard);
    logger.info(`🏛️ [Evidence Matrix] Evaluated ${strategyId} | Score: ${compositeScore}/100 | Lifecycle: ${lifecycleStage}`);
    return evidenceCard;
  }

  getEvidence(strategyId) {
    return this.evidenceLedger.get(strategyId);
  }
}

module.exports = new StrategyEvidenceMatrix();
