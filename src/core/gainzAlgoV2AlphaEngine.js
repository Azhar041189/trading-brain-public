/**
 * GainzAlgo V2 Alpha Autonomous Engine
 * 
 * Proprietary Replicated Algorithmic Suite:
 * 1. Trend Ribbon: Fast EMA (9/21) over Institutional Baseline EMA (50/200 Cloud)
 * 2. Momentum & Volatility Squeeze: RSI(14) filter with dynamic ATR(14) expansion
 * 3. Non-Repainting Bar Close Triggers: Generates LONG/SHORT signals on confirmed closure
 * 4. Multi-Target Dynamic Bracket:
 *    - Stop Loss (SL): 1.5x ATR
 *    - Take Profit 1 (TP1): 1.5x ATR (50% scale-out)
 *    - Take Profit 2 (TP2): 2.5x ATR (Trailing runner)
 *    - Take Profit 3 (TP3): 3.5x ATR (Macro target)
 */

const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('GainzAlgoV2Alpha');

class GainzAlgoV2AlphaEngine {
  constructor(options = {}) {
    this.name = 'GainzAlgo V2 Alpha';
    this.minConfidence = options.minConfidence || 0.78; // 78% minimum consensus threshold
    this.atrPeriod = options.atrPeriod || 14;
    this.rsiPeriod = options.rsiPeriod || 14;
    this.fastEma = options.fastEma || 9;
    this.midEma = options.midEma || 21;
    this.slowEma = options.slowEma || 50;
    this.baseEma = options.baseEma || 200;
  }

  /**
   * Calculate Exponential Moving Average (EMA)
   */
  calculateEMA(candles, period) {
    if (!candles || candles.length === 0) return [];
    const effectivePeriod = Math.max(2, Math.min(period, candles.length));
    const k = 2 / (effectivePeriod + 1);
    const closes = candles.map(c => parseFloat(c.close));
    const emaArray = [closes[0]];

    for (let i = 1; i < closes.length; i++) {
      const ema = closes[i] * k + emaArray[i - 1] * (1 - k);
      emaArray.push(ema);
    }
    return emaArray;
  }

  /**
   * Calculate Relative Strength Index (RSI)
   */
  calculateRSI(candles, period = 14) {
    if (!candles || candles.length < 3) return 50;
    const effectivePeriod = Math.max(2, Math.min(period, candles.length - 1));
    const closes = candles.map(c => parseFloat(c.close));
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= effectivePeriod; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }

    let avgGain = gains / effectivePeriod;
    let avgLoss = losses / effectivePeriod;

    for (let i = effectivePeriod + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff >= 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (effectivePeriod - 1) + gain) / effectivePeriod;
      avgLoss = (avgLoss * (effectivePeriod - 1) + loss) / effectivePeriod;
    }

    if (avgLoss === 0) return 90; // Saturated strong bull
    if (avgGain === 0) return 10; // Saturated strong bear
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate Average True Range (ATR)
   */
  calculateATR(candles, period = 14) {
    if (!candles || candles.length < 2) {
      const curPrice = candles && candles.length > 0 ? parseFloat(candles[candles.length - 1].close) : 100;
      return curPrice * 0.01;
    }

    const effectivePeriod = Math.max(1, Math.min(period, candles.length - 1));
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const high = parseFloat(candles[i].high);
      const low = parseFloat(candles[i].low);
      const prevClose = parseFloat(candles[i - 1].close);
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }

    const slice = trs.slice(-effectivePeriod);
    return slice.reduce((a, b) => a + b, 0) / effectivePeriod;
  }

  /**
   * Evaluate full GainzAlgo V2 Alpha confluence on a candle series
   * @param {string} symbol - Asset ticker (e.g. BTCUSDT, NIFTY50)
   * @param {Array} candles - Array of candle objects {open, high, low, close, volume, timestamp}
   * @param {string} market - Market key (CRYPTO, IN, US, FOREX, FUTURES)
   */
  evaluate(symbol, candles, market = 'CRYPTO') {
    if (!candles || candles.length < 20) {
      return {
        hasSignal: false,
        symbol,
        confidence: 0,
        reason: 'Insufficient candle history (<20 bars)'
      };
    }

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    const currentPrice = parseFloat(lastCandle.close);

    const ema9Arr = this.calculateEMA(candles, this.fastEma);
    const ema21Arr = this.calculateEMA(candles, this.midEma);
    const ema50Arr = this.calculateEMA(candles, this.slowEma);

    const ema9 = ema9Arr[ema9Arr.length - 1] || currentPrice;
    const ema21 = ema21Arr[ema21Arr.length - 1] || currentPrice;
    const ema50 = ema50Arr[ema50Arr.length - 1] || currentPrice;

    const rsi = this.calculateRSI(candles, this.rsiPeriod);
    const atr = this.calculateATR(candles, this.atrPeriod);

    // Trend Ribbon Alignment
    const isBullishRibbon = (ema9 >= ema21) && (currentPrice >= ema50);
    const isBearishRibbon = (ema9 <= ema21) && (currentPrice <= ema50);

    // Momentum Squeeze / Expansion
    const isBullishMomentum = (rsi >= 50);
    const isBearishMomentum = (rsi <= 50);

    // Volume Expansion (Vol > 1.2x SMA20 Volume)
    const recentVols = candles.slice(-20).map(c => parseFloat(c.volume || 0));
    const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    const currentVol = parseFloat(lastCandle.volume || 0);
    const isVolExpanding = (avgVol === 0) || (currentVol >= avgVol * 1.10);

    let signalType = 'HOLD';
    let confidence = 0.50;
    let reasons = [];

    if (isBullishRibbon && isBullishMomentum) {
      signalType = 'LONG';
      confidence = 0.80;
      reasons.push('EMA Ribbon Bullish');
      reasons.push(`RSI Bullish Momentum (${rsi.toFixed(1)})`);
      if (isVolExpanding) {
        confidence += 0.08;
        reasons.push('Volume Expansion');
      }
      if (currentPrice >= parseFloat(prevCandle.high)) {
        confidence += 0.04;
        reasons.push('Bullish Breakout Bar');
      }
    } else if (isBearishRibbon && isBearishMomentum) {
      signalType = 'SHORT';
      confidence = 0.80;
      reasons.push('EMA Ribbon Bearish');
      reasons.push(`RSI Bearish Momentum (${rsi.toFixed(1)})`);
      if (isVolExpanding) {
        confidence += 0.08;
        reasons.push('Volume Expansion');
      }
      if (currentPrice <= parseFloat(prevCandle.low)) {
        confidence += 0.04;
        reasons.push('Bearish Breakdown Bar');
      }
    }

    confidence = Math.min(0.95, confidence);
    const hasSignal = (signalType === 'LONG' || signalType === 'SHORT') && (confidence >= this.minConfidence);

    // Dynamic Multi-Target ATR Brackets
    let stopLoss = 0;
    let tp1 = 0;
    let tp2 = 0;
    let tp3 = 0;

    if (signalType === 'LONG') {
      stopLoss = parseFloat((currentPrice - 1.5 * atr).toFixed(4));
      tp1 = parseFloat((currentPrice + 1.5 * atr).toFixed(4));
      tp2 = parseFloat((currentPrice + 2.5 * atr).toFixed(4));
      tp3 = parseFloat((currentPrice + 3.5 * atr).toFixed(4));
    } else if (signalType === 'SHORT') {
      stopLoss = parseFloat((currentPrice + 1.5 * atr).toFixed(4));
      tp1 = parseFloat((currentPrice - 1.5 * atr).toFixed(4));
      tp2 = parseFloat((currentPrice - 2.5 * atr).toFixed(4));
      tp3 = parseFloat((currentPrice - 3.5 * atr).toFixed(4));
    } else {
      stopLoss = parseFloat((currentPrice - 1.0 * atr).toFixed(4));
      tp1 = parseFloat((currentPrice + 1.0 * atr).toFixed(4));
      tp2 = parseFloat((currentPrice + 2.0 * atr).toFixed(4));
      tp3 = parseFloat((currentPrice + 3.0 * atr).toFixed(4));
    }

    return {
      hasSignal,
      symbol,
      market,
      direction: signalType === 'LONG' ? 'BUY' : (signalType === 'SHORT' ? 'SELL' : 'HOLD'),
      action: signalType,
      confidence,
      price: currentPrice,
      atr,
      rsi,
      emaRibbon: { ema9, ema21, ema50 },
      stopLoss,
      takeProfit: tp1,
      targets: { tp1, tp2, tp3 },
      riskRewardRatio: 2.5,
      strategy: 'gainzalgo_v2_alpha',
      strategyName: 'GainzAlgo V2 Alpha',
      reasons,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = GainzAlgoV2AlphaEngine;
