/**
 * directionalVolumeDeltaRegimeEngine.js
 * 
 * Quantitative Directional Volume Delta & Heuristic Regime Classifier:
 * 1. Candle Directional Volume Delta (Approximation based on body/range distribution)
 * 2. Swing-Separated Absorption & Delta Divergence Detection (Fail-Closed on zero/missing volume)
 * 3. Market-Aware 3-State Volatility-Momentum Regime Classifier
 * 
 * Governance Invariant: Strictly fail-closed on missing/synthetic volume.
 */

const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('DirectionalVolumeEngine');

class DirectionalVolumeDeltaRegimeEngine {
  constructor() {
    this.name = 'DirectionalVolumeDeltaRegimeEngine';
    this.divergenceLookback = 14;
  }

  /**
   * Computes Candle Directional Volume Delta series
   * Strictly fail-closed if volume data is missing or invalid.
   */
  computeDirectionalDelta(candles) {
    if (!Array.isArray(candles) || candles.length < 5) {
      return { valid: false, reason: 'INSUFFICIENT_CANDLE_HISTORY', series: [] };
    }

    let runningDelta = 0;
    const series = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const vol = parseFloat(c.volume);
      
      // FAIL-CLOSED: Refuse to fabricate or invent synthetic volume
      if (isNaN(vol) || vol <= 0) {
        return { valid: false, reason: 'INVALID_OR_MISSING_VOLUME_DATA', series: [] };
      }

      const high = parseFloat(c.high);
      const low = parseFloat(c.low);
      const open = parseFloat(c.open);
      const close = parseFloat(c.close);
      const range = (high - low) || 0.00001;
      const body = (close - open);

      // Directional volume allocation based on intra-candle price excursion
      const buyFraction = Math.max(0.05, Math.min(0.95, 0.5 + (body / (2 * range))));
      const buyVol = vol * buyFraction;
      const sellVol = vol * (1 - buyFraction);
      const delta = buyVol - sellVol;

      runningDelta += delta;
      series.push({
        timestamp: c.timestamp || i,
        close,
        high,
        low,
        volume: vol,
        delta: parseFloat(delta.toFixed(4)),
        cumulativeDelta: parseFloat(runningDelta.toFixed(4))
      });
    }

    return { valid: true, series };
  }

  /**
   * Detects Absorption & Delta Divergence using confirmed swing separation
   * (Current bar is strictly compared against confirmed PRIOR swings, min 3 bars separation)
   */
  detectAbsorptionDivergence(deltaResult) {
    if (!deltaResult.valid || !deltaResult.series || deltaResult.series.length < this.divergenceLookback) {
      return { hasDivergence: false, type: 'NEUTRAL', score: 0.50, absorptionDetected: false, reason: deltaResult.reason || 'INSUFFICIENT_DATA' };
    }

    const series = deltaResult.series;
    const current = series[series.length - 1];

    // Look back at confirmed historical window excluding the last 2 forming bars
    const historicalWindow = series.slice(-this.divergenceLookback, -2);
    if (historicalWindow.length < 3) {
      return { hasDivergence: false, type: 'NEUTRAL', score: 0.50, absorptionDetected: false };
    }

    let minLowIdx = 0;
    let maxHighIdx = 0;
    for (let i = 0; i < historicalWindow.length; i++) {
      if (historicalWindow[i].low < historicalWindow[minLowIdx].low) minLowIdx = i;
      if (historicalWindow[i].high > historicalWindow[maxHighIdx].high) maxHighIdx = i;
    }

    const priorSwingLow = historicalWindow[minLowIdx];
    const priorSwingHigh = historicalWindow[maxHighIdx];

    // Bullish Absorption Divergence: Current Low <= Prior Low, but Cumulative Delta > Prior Delta
    const isBullishAbsorption = (current.low <= priorSwingLow.low) && (current.cumulativeDelta > priorSwingLow.cumulativeDelta);

    // Bearish Distribution Divergence: Current High >= Prior High, but Cumulative Delta < Prior Delta
    const isBearishDistribution = (current.high >= priorSwingHigh.high) && (current.cumulativeDelta < priorSwingHigh.cumulativeDelta);

    if (isBullishAbsorption) {
      return {
        hasDivergence: true,
        type: 'BULLISH_ABSORPTION',
        score: 0.85,
        absorptionDetected: true,
        details: 'Directional delta indicates passive accumulation at support (Higher delta low vs prior swing low)'
      };
    }

    if (isBearishDistribution) {
      return {
        hasDivergence: true,
        type: 'BEARISH_DISTRIBUTION',
        score: 0.15,
        absorptionDetected: true,
        details: 'Directional delta indicates passive distribution at resistance (Lower delta high vs prior swing high)'
      };
    }

    return {
      hasDivergence: false,
      type: 'CONGRUENT',
      score: 0.50,
      absorptionDetected: false,
      details: 'Directional delta moving in line with price trend'
    };
  }

  /**
   * Market-Aware 3-State Volatility & Momentum Regime Classifier
   * Uses exact session annualization constants per venue.
   */
  classifyRegime(candles, market = 'CRYPTO') {
    if (!candles || candles.length < 20) {
      return { regimeState: 0, regimeName: 'CONSOLIDATION_ACCUMULATION', confidence: 0.50 };
    }

    // Market-aware 15m session annualization factors
    const annualizationFactors = {
      CRYPTO: Math.sqrt(252 * 24 * 4),      // 24/7 continuous
      IN: Math.sqrt(252 * 6.25 * 4),        // 09:15 - 15:30 IST (6.25 hrs/day)
      US: Math.sqrt(252 * 6.5 * 4),         // 09:30 - 16:00 EST (6.5 hrs/day)
      FOREX: Math.sqrt(252 * 24 * 4),       // 24h market
      FUTURES: Math.sqrt(252 * 23 * 4)      // 23h session
    };

    const factor = annualizationFactors[market] || annualizationFactors.CRYPTO;

    const returns = [];
    for (let i = 1; i < candles.length; i++) {
      returns.push(Math.log(candles[i].close / candles[i - 1].close));
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const vol = Math.sqrt(variance) * factor;

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 10];
    const momentum = (lastCandle.close - prevCandle.close) / prevCandle.close;

    if (vol > 1.20 || Math.abs(returns[returns.length - 1]) > 0.04) {
      return {
        regimeState: 2,
        regimeName: 'HIGH_VOLATILITY_EXPANSION',
        volatility: parseFloat(vol.toFixed(2)),
        confidence: 0.88,
        description: 'Elevated market variance; tight risk bounds enforced'
      };
    } else if (Math.abs(momentum) > 0.015 && vol > 0.35) {
      return {
        regimeState: 1,
        regimeName: 'TREND_EXPANSION',
        volatility: parseFloat(vol.toFixed(2)),
        confidence: 0.84,
        description: 'Directional momentum expansion'
      };
    } else {
      return {
        regimeState: 0,
        regimeName: 'CONSOLIDATION_ACCUMULATION',
        volatility: parseFloat(vol.toFixed(2)),
        confidence: 0.76,
        description: 'Range-bound accumulation regime'
      };
    }
  }

  /**
   * Evaluates Directional Volume Edge with explicit fail-safe neutral bypass semantics
   * Note: This module provides informational context only and NEVER acts as an authorization trigger.
   */
  evaluateEdge(symbol, candles, proposedSide = 'LONG', market = 'CRYPTO') {
    const deltaResult = this.computeDirectionalDelta(candles);
    if (!deltaResult.valid) {
      return {
        symbol,
        valid: false,
        status: 'FAIL_SAFE_NEUTRAL_BYPASS',
        edgeScore: 0.50,
        authorizesTrade: false,
        contribution: 'NO_CONTRIBUTION',
        reason: deltaResult.reason,
        confluences: [],
        detractors: []
      };
    }

    const absorption = this.detectAbsorptionDivergence(deltaResult);
    const regime = this.classifyRegime(candles, market);

    let edgeScore = 0.50;
    const confluences = [];
    const detractors = [];

    if (proposedSide === 'LONG') {
      if (absorption.type === 'BULLISH_ABSORPTION') {
        edgeScore += 0.20;
        confluences.push(absorption.details);
      } else if (absorption.type === 'BEARISH_DISTRIBUTION') {
        edgeScore -= 0.25;
        detractors.push(absorption.details);
      }
    } else if (proposedSide === 'SHORT') {
      if (absorption.type === 'BEARISH_DISTRIBUTION') {
        edgeScore += 0.20;
        confluences.push(absorption.details);
      } else if (absorption.type === 'BULLISH_ABSORPTION') {
        edgeScore -= 0.25;
        detractors.push(absorption.details);
      }
    }

    if (regime.regimeState === 1) {
      edgeScore += 0.08;
      confluences.push('Market Regime: Trend Expansion');
    } else if (regime.regimeState === 2) {
      edgeScore -= 0.15;
      detractors.push('Market Regime: High Volatility Expansion');
    }

    return {
      symbol,
      valid: true,
      proposedSide,
      edgeScore: parseFloat(Math.max(0.01, Math.min(0.99, edgeScore)).toFixed(2)),
      isApproved: edgeScore >= 0.45,
      absorption,
      regime,
      confluences,
      detractors,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new DirectionalVolumeDeltaRegimeEngine();
