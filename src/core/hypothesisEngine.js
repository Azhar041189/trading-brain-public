const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('HypothesisEngine');

/**
 * Quantitative Hypothesis Engine
 * Converts qualitative research findings & market intelligence into formal, testable strategy candidate hypotheses.
 * SAFETY: Outputs structured JSON hypotheses ONLY. Never executes orders or talks to brokers.
 */
class HypothesisEngine {
  constructor() {
    this.hypotheses = new Map();
  }

  /**
   * Formulate a structured hypothesis from market intelligence and technical indicators
   */
  formulateHypothesis(intelReport, indicators = {}) {
    if (!intelReport || !intelReport.symbol) {
      throw new Error('Invalid intelligence report: missing symbol');
    }

    const { symbol, market, macro, sentiment, microstructure } = intelReport;
    const hypothesisId = `HYP_${symbol}_${Date.now()}`;

    // Determine candidate direction based on multi-factor confluence
    let direction = 'NEUTRAL';
    let rationale = [];
    let strategyType = 'MOMENTUM_BREAKOUT';

    const isBullishSentiment = sentiment && (sentiment.score > 0.60 || sentiment.classification.includes('BULLISH'));
    const isBearishSentiment = sentiment && (sentiment.score < 0.40 || sentiment.classification.includes('BEARISH'));
    const isAccumulation = microstructure && microstructure.whaleFlow === 'ACCUMULATION';
    const isDistribution = microstructure && microstructure.whaleFlow === 'DISTRIBUTION';

    if (intelReport.dataStatus === 'UNAVAILABLE') {
      direction = 'NEUTRAL';
      strategyType = 'NONE_INSUFFICIENT_DATA';
      rationale.push('Intelligence sources unavailable - failing closed to neutral');
    } else if (isBullishSentiment && isAccumulation) {
      direction = 'LONG';
      strategyType = 'MOMENTUM_BREAKOUT';
      rationale.push('Bullish sentiment alignment with dark pool whale accumulation flow');
    } else if (isBearishSentiment && isDistribution) {
      direction = 'SHORT';
      strategyType = 'INSTITUTIONAL_LIQUIDITY';
      rationale.push('Bearish sentiment alignment with institutional distribution flow');
    } else if (microstructure && microstructure.vpin !== null && microstructure.vpin < 0.20 && microstructure.whaleFlow === 'BALANCED') {
      direction = 'NEUTRAL';
      strategyType = 'DELTA_NEUTRAL';
      rationale.push('Low order-flow toxicity suitable for delta-neutral basis funding capture');
    } else {
      direction = 'NEUTRAL';
      strategyType = 'NO_CONFLUENCE';
      rationale.push('Inconclusive signals - preserving capital in neutral stance');
    }

    const hypothesis = {
      hypothesisId,
      symbol,
      market: market || 'CRYPTO',
      direction,
      strategyType,
      rationale: rationale.join('; '),
      entryTrigger: {
        indicator: indicators.indicator || 'EMA_CROSSOVER',
        fastPeriod: indicators.fastPeriod || 8,
        slowPeriod: indicators.slowPeriod || 24,
        volumeMultiplier: indicators.volumeMultiplier || 1.25
      },
      exitRules: {
        stopLossATR: 1.5,
        takeProfitATR: 3.0,
        trailingStop: true
      },
      invalidationCondition: '4-hour candle closes against the established directional bias or VPIN exceeds 0.70',
      targetRegime: strategyType === 'DELTA_NEUTRAL' 
        ? 'RANGE_NEUTRAL' 
        : (direction === 'LONG' ? 'TRENDING_BULL' : (direction === 'SHORT' ? 'TRENDING_BEAR' : 'NEUTRAL')),
      status: 'PROPOSED_FOR_VALIDATION',
      createdAt: new Date().toISOString()
    };

    this.hypotheses.set(hypothesisId, hypothesis);
    logger.info(`🧪 [Hypothesis Engine] Formulated candidate strategy hypothesis: ${hypothesisId}`, {
      symbol,
      direction,
      strategyType
    });

    return hypothesis;
  }

  getHypothesis(hypothesisId) {
    return this.hypotheses.get(hypothesisId);
  }

  getAllHypotheses() {
    return Array.from(this.hypotheses.values());
  }
}

module.exports = new HypothesisEngine();
