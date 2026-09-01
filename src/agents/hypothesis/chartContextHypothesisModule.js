const featureExtractor = require('../../core/chartContextFeatureExtractor');
const { createAgentLogger } = require('../../core/logger');
const logger = createAgentLogger('ChartContextHypothesisModule');

/**
 * ChartContextHypothesisModule - Converts quantitative chart features into evidence vectors
 * for multi-agent hypothesis debate (Hermes / Ares / Thoth).
 * 
 * Strict Invariant: The chart informs, it does not authorize.
 * Produces confidence weight modifiers [-0.25 to +0.25] and directional evidence tags.
 */
class ChartContextHypothesisModule {
  /**
   * Evaluate chart context evidence for a given candidate trade signal
   * @param {Object} signal - Candidate signal { symbol, direction: 'LONG'|'SHORT', price }
   * @param {Array} candles - OHLCV candles
   * @param {string} market - Market identifier
   * @param {Object} enabledFactors - { vwap: boolean, volumeProfile: boolean, marketStructure: boolean, rvol: boolean, directionalVolume: boolean }
   * @returns {Object} { evidenceWeight, confidenceModifier, confluences, detractors, reason }
   */
  evaluateEvidence(signal, candles, market = 'CRYPTO', enabledFactors = { vwap: true, volumeProfile: true, marketStructure: true, rvol: true, directionalVolume: false }) {
    const extracted = featureExtractor.extractFeatures(signal.symbol, candles, market);
    if (!extracted.valid) {
      return {
        evidenceScore: 0.5,
        confidenceModifier: 0.0,
        confluences: [],
        detractors: ['Insufficient feature data'],
        reason: 'Feature extraction failed'
      };
    }

    const f = extracted.features;
    const isLong = signal.direction === 'LONG';
    let score = 0.50; // Neutral starting score
    const confluences = [];
    const detractors = [];

    // 1. VWAP Fair Value Distance Factor
    if (enabledFactors.vwap) {
      if (isLong) {
        if (f.isAboveVWAP && f.distanceToVWAP_sigma >= 0 && f.distanceToVWAP_sigma <= 1.5) {
          score += 0.10;
          confluences.push(`Bullish above VWAP (+${f.distanceToVWAP_sigma.toFixed(1)}σ)`);
        } else if (f.distanceToVWAP_sigma > 2.0) {
          score -= 0.10;
          detractors.push(`Overextended above VWAP (+${f.distanceToVWAP_sigma.toFixed(1)}σ mean reversion risk)`);
        } else if (!f.isAboveVWAP) {
          score -= 0.05;
          detractors.push('Below session VWAP fair value');
        }
      } else {
        // Short Signal
        if (!f.isAboveVWAP && f.distanceToVWAP_sigma <= 0 && f.distanceToVWAP_sigma >= -1.5) {
          score += 0.10;
          confluences.push(`Bearish below VWAP (${f.distanceToVWAP_sigma.toFixed(1)}σ)`);
        } else if (f.distanceToVWAP_sigma < -2.0) {
          score -= 0.10;
          detractors.push(`Overextended below VWAP (${f.distanceToVWAP_sigma.toFixed(1)}σ bounce risk)`);
        } else if (f.isAboveVWAP) {
          score -= 0.05;
          detractors.push('Above session VWAP fair value');
        }
      }
    }

    // 2. Volume Profile Value Area Location Factor
    if (enabledFactors.volumeProfile) {
      if (isLong) {
        if (f.valueAreaLocation === 'ABOVE_VALUE_AREA') {
          score += 0.08;
          confluences.push('Value Area High (VAH) breakout expansion');
        } else if (f.valueAreaLocation === 'INSIDE_VALUE_AREA' && f.currentPrice > f.poc) {
          score += 0.04;
          confluences.push('Inside Value Area above POC magnet');
        } else if (f.valueAreaLocation === 'BELOW_VALUE_AREA') {
          score -= 0.06;
          detractors.push('Trapped below Value Area Low');
        }
      } else {
        // Short Signal
        if (f.valueAreaLocation === 'BELOW_VALUE_AREA') {
          score += 0.08;
          confluences.push('Value Area Low (VAL) breakdown expansion');
        } else if (f.valueAreaLocation === 'INSIDE_VALUE_AREA' && f.currentPrice < f.poc) {
          score += 0.04;
          confluences.push('Inside Value Area below POC');
        } else if (f.valueAreaLocation === 'ABOVE_VALUE_AREA') {
          score -= 0.06;
          detractors.push('Fighting above Value Area High');
        }
      }
    }

    // 3. Non-Repainting Market Structure Factor
    if (enabledFactors.marketStructure) {
      if (isLong) {
        if (f.marketStructureTrend === 'BULLISH_STRUCTURE') {
          score += 0.12;
          confluences.push('Confirmed Bullish Market Structure (Higher Highs / Higher Lows)');
        } else if (f.marketStructureTrend === 'BEARISH_STRUCTURE') {
          score -= 0.15;
          detractors.push('Counter-trend fighting confirmed Bearish Structure');
        }

        if (f.lastStructureEvent && f.lastStructureEvent.type.includes('BOS') && f.lastStructureEvent.direction === 'BULLISH' && f.lastStructureEvent.barsAgo <= 10) {
          score += 0.08;
          confluences.push(`Recent Bullish BOS body close (${f.lastStructureEvent.barsAgo} bars ago)`);
        }
      } else {
        // Short Signal
        if (f.marketStructureTrend === 'BEARISH_STRUCTURE') {
          score += 0.12;
          confluences.push('Confirmed Bearish Market Structure (Lower Lows / Lower Highs)');
        } else if (f.marketStructureTrend === 'BULLISH_STRUCTURE') {
          score -= 0.15;
          detractors.push('Counter-trend fighting confirmed Bullish Structure');
        }

        if (f.lastStructureEvent && f.lastStructureEvent.type.includes('BOS') && f.lastStructureEvent.direction === 'BEARISH' && f.lastStructureEvent.barsAgo <= 10) {
          score += 0.08;
          confluences.push(`Recent Bearish BOS body close (${f.lastStructureEvent.barsAgo} bars ago)`);
        }
      }
    }

    // 4. RVOL Participation Factor
    if (enabledFactors.rvol) {
      if (f.rvol >= 1.5) {
        score += 0.06;
        confluences.push(`High institutional volume expansion (RVOL ${f.rvol}x)`);
      } else if (f.rvol < 0.6) {
        score -= 0.05;
        detractors.push(`Low liquidity participation (RVOL ${f.rvol}x)`);
      }
    }

    // 5. Candle Directional Volume Delta & Regime Factor (Experimental Candidate Variant)
    if (enabledFactors && enabledFactors.directionalVolume) {
      try {
        const directionalVolumeEngine = require('../../core/directionalVolumeDeltaRegimeEngine');
        const ofEdge = directionalVolumeEngine.evaluateEdge(signal.symbol, candles, signal.direction, market);
        
        if (ofEdge && ofEdge.valid && ofEdge.absorption) {
          if (isLong && ofEdge.absorption.type === 'BULLISH_ABSORPTION') {
            score += 0.08;
            confluences.push(ofEdge.absorption.details);
          } else if (isLong && ofEdge.absorption.type === 'BEARISH_DISTRIBUTION') {
            score -= 0.10;
            detractors.push(ofEdge.absorption.details);
          } else if (!isLong && ofEdge.absorption.type === 'BEARISH_DISTRIBUTION') {
            score += 0.08;
            confluences.push(ofEdge.absorption.details);
          } else if (!isLong && ofEdge.absorption.type === 'BULLISH_ABSORPTION') {
            score -= 0.10;
            detractors.push(ofEdge.absorption.details);
          }
        } else if (ofEdge && !ofEdge.valid) {
          logger.warn(`Directional volume calculation bypassed for ${signal.symbol}: ${ofEdge.reason}`);
        }
      } catch (err) {
        logger.warn(`Directional volume evaluation failed for ${signal.symbol}: ${err.message}`);
      }
    }

    // Bound final score between 0.10 and 0.95
    const boundedScore = Math.max(0.10, Math.min(0.95, parseFloat(score.toFixed(3))));
    const confidenceModifier = parseFloat((boundedScore - 0.50).toFixed(3));

    return {
      evidenceScore: boundedScore,
      confidenceModifier,
      confluences,
      detractors,
      extractedFeatures: f,
      hypothesisApproval: boundedScore >= 0.55
    };
  }
}

module.exports = new ChartContextHypothesisModule();
