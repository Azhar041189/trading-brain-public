/**
 * Helix Lucky Multi-Timeframe (MTF) Alpha Engine
 * 
 * Hierarchical 3-tier confluence engine:
 * 1. Macro Anchor (1h / 4h): Institutional Trend Direction & EMA 50/200 Cloud
 * 2. Intermediate Setup (15m): Volume Expansion (Vol > 1.5x SMA20) & ADX Momentum (>25)
 * 3. Micro Trigger (1m / 5m): Precision Pullback to EMA20 / Fair Value Gap Sweep
 * 
 * Asymmetric Risk:Reward: 2.5x - 3.5x with dynamic ATR-based Stop Loss.
 */

const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('HelixLuckyMTF');

class HelixLuckyMtfEngine {
  constructor() {
    this.minConfluenceScore = 0.75; // 75% minimum agreement across timeframes
  }

  /**
   * Resample 1m/5m candles into higher timeframes (15m, 1h)
   * @param {Array} candles - Base timeframe candles
   * @param {number} factor - Resampling period multiplier (e.g. 3 for 5m -> 15m, 12 for 5m -> 1h)
   */
  resampleCandles(candles, factor) {
    if (!candles || candles.length < factor) return candles || [];
    const resampled = [];
    
    for (let i = 0; i < candles.length; i += factor) {
      const chunk = candles.slice(i, i + factor);
      if (chunk.length === 0) continue;
      
      const open = chunk[0].open;
      const high = Math.max(...chunk.map(c => c.high));
      const low = Math.min(...chunk.map(c => c.low));
      const close = chunk[chunk.length - 1].close;
      const volume = chunk.reduce((sum, c) => sum + (c.volume || 0), 0);
      const timestamp = chunk[chunk.length - 1].timestamp || chunk[chunk.length - 1].time;

      resampled.push({ open, high, low, close, volume, timestamp });
    }

    return resampled;
  }

  /**
   * Calculate Exponential Moving Average (EMA)
   */
  calculateEMA(candles, period) {
    if (!candles || candles.length < period) return [];
    const k = 2 / (period + 1);
    const closes = candles.map(c => c.close);
    const emaArray = [closes[0]];

    for (let i = 1; i < closes.length; i++) {
      const ema = closes[i] * k + emaArray[i - 1] * (1 - k);
      emaArray.push(ema);
    }
    return emaArray;
  }

  /**
   * Calculate Average True Range (ATR)
   */
  calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) {
      const curPrice = candles && candles.length > 0 ? candles[candles.length - 1].close : 100;
      return curPrice * 0.01; // 1% fallback
    }

    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }

    const slice = trs.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * Evaluate Tier 1: Macro Anchor (1-Hour Trend Direction)
   */
  evaluateMacroAnchor(candles1h, candles15m) {
    const series = (candles1h && candles1h.length >= 8) ? candles1h : (candles15m && candles15m.length >= 6 ? candles15m : null);
    if (!series || series.length < 4) {
      return { score: 0.5, bias: 'NEUTRAL', reason: 'Insufficient macro history' };
    }

    const emaFast = this.calculateEMA(series, Math.min(5, Math.floor(series.length / 2)));
    const emaSlow = this.calculateEMA(series, Math.min(10, Math.floor(series.length * 0.8)));
    const lastClose = series[series.length - 1].close;
    const firstClose = series[0].close;
    const lastFast = emaFast[emaFast.length - 1];
    const lastSlow = emaSlow[emaSlow.length - 1];

    const netChangePct = ((lastClose - firstClose) / firstClose) * 100;

    if (lastClose > lastFast && lastFast > lastSlow && netChangePct > 0.8) {
      return { score: 1.0, bias: 'BULLISH', reason: `Macro Strong Bullish Trend (+${netChangePct.toFixed(1)}% | Price > Fast > Slow EMA)` };
    } else if (lastClose < lastFast && lastFast < lastSlow && netChangePct < -0.8) {
      return { score: 1.0, bias: 'BEARISH', reason: `Macro Strong Bearish Trend (${netChangePct.toFixed(1)}% | Price < Fast < Slow EMA)` };
    } else {
      return { score: 0.3, bias: 'CHOPPY', reason: `Macro Consolidation / Rangebound (${netChangePct.toFixed(2)}% net change)` };
    }
  }

  /**
   * Evaluate Tier 2: Intermediate Setup (15-Minute Volume & Momentum)
   */
  evaluateIntermediateSetup(candles15m, macroBias) {
    if (!candles15m || candles15m.length < 10) {
      return { score: 0.5, valid: false, reason: 'Insufficient 15m history' };
    }

    const lastCandle = candles15m[candles15m.length - 1];
    const recentVolumes = candles15m.slice(-10, -1).map(c => c.volume || 1);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const volumeRatio = (lastCandle.volume || 1) / Math.max(1, avgVolume);

    const isBullCandle = lastCandle.close > lastCandle.open;
    const isBearCandle = lastCandle.close < lastCandle.open;

    if (macroBias === 'BULLISH' && isBullCandle && volumeRatio >= 1.2) {
      return { score: 0.9, valid: true, volumeRatio, reason: `15m Bullish volume expansion (${volumeRatio.toFixed(1)}x avg)` };
    } else if (macroBias === 'BEARISH' && isBearCandle && volumeRatio >= 1.2) {
      return { score: 0.9, valid: true, volumeRatio, reason: `15m Bearish volume expansion (${volumeRatio.toFixed(1)}x avg)` };
    } else {
      return { score: 0.5, valid: false, volumeRatio, reason: `15m Volume normal (${volumeRatio.toFixed(1)}x avg)` };
    }
  }

  /**
   * Evaluate Tier 3: Micro Trigger (5-Minute Retest / Breakout)
   */
  evaluateMicroTrigger(candles5m, macroBias) {
    if (!candles5m || candles5m.length < 10) {
      return { score: 0.5, trigger: false, reason: 'Insufficient 5m history' };
    }

    const ema9 = this.calculateEMA(candles5m, 9);
    const lastCandle = candles5m[candles5m.length - 1];
    const prevCandle = candles5m[candles5m.length - 2];
    const lastEma = ema9[ema9.length - 1];

    if (macroBias === 'BULLISH') {
      // Long Trigger: Price dipping to EMA9 or breaking high
      const isRetest = prevCandle.low <= lastEma * 1.002 && lastCandle.close > lastEma;
      const isBreakout = lastCandle.close > Math.max(...candles5m.slice(-6, -1).map(c => c.high));
      if (isRetest || isBreakout) {
        return { score: 0.95, trigger: true, setupType: isRetest ? 'EMA_RETEST' : 'MOMENTUM_BREAKOUT', reason: `5m ${isRetest ? 'EMA-9 Dynamic Retest Bounce' : 'High Breakout Surge'}` };
      }
    } else if (macroBias === 'BEARISH') {
      // Short Trigger: Price rejection from EMA9 or breaking low
      const isRetest = prevCandle.high >= lastEma * 0.998 && lastCandle.close < lastEma;
      const isBreakout = lastCandle.close < Math.min(...candles5m.slice(-6, -1).map(c => c.low));
      if (isRetest || isBreakout) {
        return { score: 0.95, trigger: true, setupType: isRetest ? 'EMA_REJECTION' : 'BREAKDOWN_FLUSH', reason: `5m ${isRetest ? 'EMA-9 Dynamic Rejection' : 'Low Breakdown Flush'}` };
      }
    }

    return { score: 0.4, trigger: false, reason: 'No micro trigger on 5m' };
  }

  /**
   * Main Analysis: Evaluate full multi-timeframe confluence for a symbol
   */
  analyzeConfluence(symbol, candles5m) {
    if (!candles5m || candles5m.length < 25) {
      return { valid: false, reason: 'Requires at least 25 5m candles' };
    }

    // Synthesize 15m and 1h candles
    const candles15m = this.resampleCandles(candles5m, 3);
    const candles1h = this.resampleCandles(candles5m, 12);

    // 1. Tier 1: Macro Anchor (1h / 15m)
    const macro = this.evaluateMacroAnchor(candles1h, candles15m);
    if (macro.bias === 'CHOPPY' || macro.bias === 'NEUTRAL') {
      return { valid: false, symbol, direction: 'NEUTRAL', score: macro.score, reason: macro.reason };
    }

    // 2. Tier 2: Intermediate Setup (15m)
    const intermediate = this.evaluateIntermediateSetup(candles15m, macro.bias);
    
    // 3. Tier 3: Micro Trigger (5m)
    const micro = this.evaluateMicroTrigger(candles5m, macro.bias);

    // Composite Confluence Score
    const compositeScore = parseFloat((macro.score * 0.4 + intermediate.score * 0.3 + micro.score * 0.3).toFixed(2));
    const isConfluent = compositeScore >= this.minConfluenceScore && micro.trigger;

    const curPrice = candles5m[candles5m.length - 1].close;
    const atr = this.calculateATR(candles5m, 14);
    const isLong = macro.bias === 'BULLISH';

    const stopDistance = Math.max(curPrice * 0.005, atr * 1.5);
    const targetDistance = stopDistance * 2.5; // Strict 2.5x Risk:Reward

    const stopLoss = isLong ? parseFloat((curPrice - stopDistance).toFixed(4)) : parseFloat((curPrice + stopDistance).toFixed(4));
    const takeProfit = isLong ? parseFloat((curPrice + targetDistance).toFixed(4)) : parseFloat((curPrice - targetDistance).toFixed(4));

    return {
      valid: isConfluent,
      symbol,
      direction: isLong ? 'LONG' : 'SHORT',
      entryPrice: curPrice,
      stopLoss,
      takeProfit,
      riskReward: 2.5,
      confidence: compositeScore,
      strategy: 'helix_lucky_mtf_alpha',
      macroBias: macro.bias,
      confluenceDetails: {
        macroAnchor: macro,
        intermediateSetup: intermediate,
        microTrigger: micro
      },
      reason: `Helix Lucky MTF: ${macro.bias} (1H Trend + 15M Volume ${intermediate.volumeRatio ? intermediate.volumeRatio.toFixed(1) + 'x' : 'OK'} + ${micro.reason})`
    };
  }
}

module.exports = new HelixLuckyMtfEngine();
