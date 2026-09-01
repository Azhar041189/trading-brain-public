const volumeProfileEngine = require('./volumeProfileEngine');
const vwapEngine = require('./vwapEngine');
const marketStructureEngine = require('./marketStructureEngine');
const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('ChartContextFeatureExtractor');

/**
 * ChartContextFeatureExtractor - Extracts mathematically normalized quantitative features
 * from the institutional chart stack (VWAP, Volume Profile, Market Structure, ATR/RVOL).
 * 
 * Invariant: Produces bounded, normalized numerical and categorical feature vectors
 * suitable for hypothesis formation, regime voting, and backtest ablation studies.
 */
class ChartContextFeatureExtractor {
  /**
   * Extract comprehensive chart context features from OHLCV candles
   * @param {string} symbol - Ticker symbol
   * @param {Array} candles - Array of OHLCV candles
   * @param {string} market - Market identifier ('CRYPTO' | 'IN' | 'US' | 'FOREX')
   * @returns {Object} Normalized feature vector
   */
  extractFeatures(symbol, candles, market = 'CRYPTO') {
    if (!Array.isArray(candles) || candles.length < 20) {
      return {
        symbol,
        valid: false,
        features: {},
        reason: 'Insufficient candle history'
      };
    }

    const lastCandle = candles[candles.length - 1];
    const currentPrice = lastCandle.close;

    // 1. Extract Volume Profile Features (POC, VAH, VAL, Location)
    const profile = volumeProfileEngine.computeProfile(candles, 40);
    const locationAnalysis = volumeProfileEngine.evaluatePriceLocation(currentPrice, profile);

    // 2. Extract Session & Multi-Anchor VWAP Features
    const vwapData = vwapEngine.computeAnchoredVWAP(candles, 'SESSION_OPEN', market);
    const vwapMetrics = vwapData.metrics;

    // 3. Extract Market Structure Features (Pivots, BOS, CHoCH)
    const structure = marketStructureEngine.analyzeStructure(candles);
    const lastEvent = structure.events[structure.events.length - 1] || null;

    // 4. Extract RVOL & ATR Normalization
    let sumVol = 0;
    const lookback = Math.min(20, candles.length);
    for (let i = candles.length - lookback; i < candles.length; i++) {
      sumVol += (candles[i].volume || 0);
    }
    const avgVol = lookback > 0 ? (sumVol / lookback) : 1;
    const rvol = avgVol > 0 ? (lastCandle.volume / avgVol) : 1.0;

    // Normalized True Range (ATR 14)
    let sumTR = 0;
    const atrLookback = Math.min(14, candles.length - 1);
    for (let i = candles.length - atrLookback; i < candles.length; i++) {
      const c = candles[i];
      const prevC = candles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevC.close), Math.abs(c.low - prevC.close));
      sumTR += tr;
    }
    const atr = atrLookback > 0 ? (sumTR / atrLookback) : (lastCandle.high - lastCandle.low);
    const atrNormalizedPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 1.0;

    return {
      symbol,
      valid: true,
      timestamp: lastCandle.timestamp || new Date().toISOString(),
      currentPrice,
      features: {
        // VWAP Features
        vwap: vwapData.currentVWAP,
        distanceToVWAP_pct: vwapMetrics.distancePct,
        distanceToVWAP_sigma: vwapMetrics.sigmaDistance,
        isAboveVWAP: currentPrice >= vwapData.currentVWAP,
        vwapUpper1: vwapData.bands.upper1,
        vwapLower1: vwapData.bands.lower1,
        vwapUpper2: vwapData.bands.upper2,
        vwapLower2: vwapData.bands.lower2,
        vwapBias: vwapMetrics.bias,

        // Volume Profile Features
        poc: profile.poc,
        vah: profile.vah,
        val: profile.val,
        valueAreaLocation: locationAnalysis.location, // 'ABOVE_VALUE_AREA' | 'BELOW_VALUE_AREA' | 'INSIDE_VALUE_AREA'
        distanceToPOC_pct: locationAnalysis.distanceToPOCPct || 0,
        valueAreaBias: locationAnalysis.bias,

        // Market Structure Features
        marketStructureTrend: structure.trend, // 'BULLISH_STRUCTURE' | 'BEARISH_STRUCTURE' | 'SIDEWAYS_RANGE'
        lastConfirmedSwingHigh: structure.lastConfirmedSwingHigh?.price || null,
        lastConfirmedSwingLow: structure.lastConfirmedSwingLow?.price || null,
        lastStructureEvent: lastEvent ? {
          type: lastEvent.type,
          direction: lastEvent.direction,
          level: lastEvent.level,
          barsAgo: (candles.length - 1) - (lastEvent.barIndex || 0)
        } : null,

        // Volatility & Participation Features
        rvol: parseFloat(rvol.toFixed(2)),
        isVolumeSurging: rvol >= 1.5,
        atr14: parseFloat(atr.toFixed(4)),
        atrNormalizedPct: parseFloat(atrNormalizedPct.toFixed(2))
      }
    };
  }
}

module.exports = new ChartContextFeatureExtractor();
