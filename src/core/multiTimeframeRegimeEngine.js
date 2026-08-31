const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('MultiTFRegimeEngine');

/**
 * MultiTimeframeRegimeEngine - 5m + 15m + 1h Weighted Regime Voting Consensus
 * 
 * Weights:
 * - 5m: 30% (Micro-structure momentum & intraday exhaustion)
 * - 15m: 40% (Primary intraday trend & volume profile)
 * - 1h: 30% (Macro trend & institutional support/resistance)
 */
class MultiTimeframeRegimeEngine {
  constructor() {
    this.timeframeWeights = {
      '5m': 0.30,
      '15m': 0.40,
      '1h': 0.30
    };
  }

  /**
   * Evaluates individual timeframe regime from technical indicators
   */
  classifySingleTF(candles) {
    if (!candles || candles.length < 20) {
      return { regime: 'RANGING_CHOPPY', confidence: 0.60, slopePct: 0.00, rangePct: 0.85, trendSlope: 0, rsi: 50 };
    }

    const closes = candles.map(c => c.close);
    const n = closes.length;
    const current = closes[n - 1];
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    
    // Compute simple linear regression slope over last 15 candles
    const sample = closes.slice(-15);
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < sample.length; i++) {
      sumX += i;
      sumY += sample[i];
      sumXY += i * sample[i];
      sumXX += i * i;
    }
    const len = sample.length;
    const slope = (len * sumXY - sumX * sumY) / (len * sumXX - sumX * sumX);
    const slopePct = (slope / current) * 100;

    // Measure volatility bandwidth (High - Low)/Close
    const high20 = Math.max(...candles.slice(-20).map(c => c.high));
    const low20 = Math.min(...candles.slice(-20).map(c => c.low));
    const rangePct = ((high20 - low20) / current) * 100;

    let regime = 'RANGING_CHOPPY';
    let confidence = 0.70;

    if (slopePct > 0.12 && current > sma20) {
      regime = 'TRENDING_BULL';
      confidence = Math.min(0.95, 0.65 + slopePct * 1.5);
    } else if (slopePct < -0.12 && current < sma20) {
      regime = 'TRENDING_BEAR';
      confidence = Math.min(0.95, 0.65 + Math.abs(slopePct) * 1.5);
    } else if (rangePct > 2.5) {
      regime = 'HIGH_VOLATILITY_EXPANSION';
      confidence = 0.80;
    } else {
      regime = 'RANGING_CHOPPY';
      confidence = 0.75;
    }

    return { regime, confidence, slopePct: parseFloat(slopePct.toFixed(3)), rangePct: parseFloat(rangePct.toFixed(2)) };
  }

  /**
   * Computes multi-timeframe consensus regime
   */
  computeConsensus(tfCandles = {}) {
    const r5m = this.classifySingleTF(tfCandles['5m'] || []);
    const r15m = this.classifySingleTF(tfCandles['15m'] || tfCandles['5m'] || []);
    const r1h = this.classifySingleTF(tfCandles['1h'] || tfCandles['5m'] || []);

    const votes = {
      'TRENDING_BULL': 0,
      'TRENDING_BEAR': 0,
      'RANGING_CHOPPY': 0,
      'HIGH_VOLATILITY_EXPANSION': 0
    };

    votes[r5m.regime] += r5m.confidence * this.timeframeWeights['5m'];
    votes[r15m.regime] += r15m.confidence * this.timeframeWeights['15m'];
    votes[r1h.regime] += r1h.confidence * this.timeframeWeights['1h'];

    // Find highest weighted regime
    let consensusRegime = 'RANGING_CHOPPY';
    let highestScore = 0;
    for (const [regime, score] of Object.entries(votes)) {
      if (score > highestScore) {
        highestScore = score;
        consensusRegime = regime;
      }
    }

    const isConsensusStrong = highestScore >= 0.55;
    const recommendation = consensusRegime.includes('BULL') ? 'MOMENTUM_LONG' :
                           (consensusRegime.includes('BEAR') ? 'MOMENTUM_SHORT' : 'MEAN_REVERSION_RANGE_BOUND');

    const result = {
      consensusRegime,
      consensusConfidence: parseFloat(highestScore.toFixed(2)),
      isConsensusStrong,
      recommendation,
      timeframeBreakdown: {
        '5m': r5m,
        '15m': r15m,
        '1h': r1h
      },
      votingMatrix: votes,
      evaluatedAt: new Date().toISOString()
    };

    logger.info(`🏛️ [Multi-TF Regime Consensus] ${consensusRegime} (${(result.consensusConfidence * 100).toFixed(0)}% Conf) ➔ Action: ${recommendation}`);

    return result;
  }
}

module.exports = new MultiTimeframeRegimeEngine();
