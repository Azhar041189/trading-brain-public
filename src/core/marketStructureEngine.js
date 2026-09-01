const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('MarketStructureEngine');

/**
 * MarketStructureEngine - Non-Repainting Algorithmic Market Structure Analysis.
 * 
 * Non-Repainting Confirmation Semantics:
 * - A fractal pivot at bar N requires K subsequent confirmation bars (e.g. K=3 bars).
 * - A pivot at `pivotIndex: N` is ONLY confirmed at `confirmedAtIndex: N + K`.
 * - Backtesters, hypothesis engines, and execution guards MUST NOT process pivots before `confirmedAtIndex`.
 * 
 * Structure Invariants:
 * - BOS (Break of Structure): Candle BODY close strictly outside confirmed swing pivot.
 * - Touch Rejection: Price touches pivot without closing outside.
 * - Liquidity Sweep / Trap: Wick pierces pivot, but candle closes back inside.
 * - CHoCH (Change of Character): First structural break against established trend regime.
 */
class MarketStructureEngine {
  constructor(options = {}) {
    this.swingStrength = options.swingStrength || 3; // K=3 bars left and K=3 bars right (7-bar fractal)
  }

  /**
   * Analyze market structure across OHLCV candles with rigorous confirmation timestamps
   * @param {Array} candles - OHLCV candles
   * @returns {Object} { trend, pivots, events, confirmedEventsOnly }
   */
  analyzeStructure(candles) {
    const k = this.swingStrength;
    if (!Array.isArray(candles) || candles.length < (k * 2 + 1)) {
      return {
        trend: 'SIDEWAYS_RANGE',
        pivots: [],
        events: [],
        lastConfirmedSwingHigh: null,
        lastConfirmedSwingLow: null,
        summary: 'Insufficient bars for fractal confirmation'
      };
    }

    const n = candles.length;
    const pivots = [];

    // 1. Detect Swing Highs and Swing Lows with strict confirmation latency
    for (let i = k; i < n - k; i++) {
      const curHigh = candles[i].high;
      const curLow = candles[i].low;

      let isSwingHigh = true;
      let isSwingLow = true;

      for (let j = 1; j <= k; j++) {
        if (candles[i - j].high >= curHigh || candles[i + j].high > curHigh) {
          isSwingHigh = false;
        }
        if (candles[i - j].low <= curLow || candles[i + j].low < curLow) {
          isSwingLow = false;
        }
      }

      const timeVal = candles[i].time || (candles[i].timestamp ? Math.floor(new Date(candles[i].timestamp).getTime() / 1000) : i);
      const confirmedTimeVal = candles[i + k].time || (candles[i + k].timestamp ? Math.floor(new Date(candles[i + k].timestamp).getTime() / 1000) : (i + k));

      if (isSwingHigh) {
        pivots.push({
          pivotIndex: i,
          confirmedAtIndex: i + k,
          confirmationDelayBars: k,
          time: timeVal,
          confirmedAtTime: confirmedTimeVal,
          type: 'SWING_HIGH',
          price: parseFloat(curHigh.toFixed(4)),
          nonRepaintingConfirmed: true
        });
      }
      if (isSwingLow) {
        pivots.push({
          pivotIndex: i,
          confirmedAtIndex: i + k,
          confirmationDelayBars: k,
          time: timeVal,
          confirmedAtTime: confirmedTimeVal,
          type: 'SWING_LOW',
          price: parseFloat(curLow.toFixed(4)),
          nonRepaintingConfirmed: true
        });
      }
    }

    // Sort pivots by confirmation order
    pivots.sort((a, b) => a.pivotIndex - b.pivotIndex);

    // 2. Classify Higher Highs (HH), Higher Lows (HL), Lower Lows (LL), Lower Highs (LH)
    let lastSH = null;
    let lastSL = null;

    pivots.forEach(p => {
      if (p.type === 'SWING_HIGH') {
        if (lastSH) {
          p.classification = p.price > lastSH.price ? 'HH' : 'LH';
        } else {
          p.classification = 'SH_INITIAL';
        }
        lastSH = p;
      } else if (p.type === 'SWING_LOW') {
        if (lastSL) {
          p.classification = p.price > lastSL.price ? 'HL' : 'LL';
        } else {
          p.classification = 'SL_INITIAL';
        }
        lastSL = p;
      }
    });

    // 3. Chronological Non-Repainting Event Evaluation
    let activeHighLevel = null;
    let activeLowLevel = null;
    let currentRegimeTrend = 'SIDEWAYS';
    const events = [];

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const timeVal = c.time || (c.timestamp ? Math.floor(new Date(c.timestamp).getTime() / 1000) : i);

      // Only consider pivots that were ALREADY confirmed at or before bar i
      const confirmedPivots = pivots.filter(p => p.confirmedAtIndex <= i);
      const confirmedSH = confirmedPivots.filter(p => p.type === 'SWING_HIGH').slice(-1)[0];
      const confirmedSL = confirmedPivots.filter(p => p.type === 'SWING_LOW').slice(-1)[0];

      if (confirmedSH && (!activeHighLevel || confirmedSH.price !== activeHighLevel)) {
        activeHighLevel = confirmedSH.price;
      }
      if (confirmedSL && (!activeLowLevel || confirmedSL.price !== activeLowLevel)) {
        activeLowLevel = confirmedSL.price;
      }

      // Check Bullish Break of Structure (BOS / CHoCH) - Body CLOSE strictly outside
      if (activeHighLevel && c.close > activeHighLevel) {
        const isCounterTrend = currentRegimeTrend === 'BEARISH';
        const eventType = isCounterTrend ? 'CHOCH_BULLISH_REVERSAL' : 'BOS_BULLISH_CONTINUATION';
        
        events.push({
          barIndex: i,
          time: timeVal,
          type: eventType,
          level: activeHighLevel,
          brokenPrice: c.close,
          direction: 'BULLISH',
          label: isCounterTrend ? 'CHoCH (Bullish Reversal)' : 'BOS (Bullish Continuation)',
          breakType: 'BODY_CLOSE_CONFIRMED'
        });
        currentRegimeTrend = 'BULLISH';
        activeHighLevel = null; // Consumed
      }

      // Check Bearish Break of Structure (BOS / CHoCH) - Body CLOSE strictly outside
      if (activeLowLevel && c.close < activeLowLevel) {
        const isCounterTrend = currentRegimeTrend === 'BULLISH';
        const eventType = isCounterTrend ? 'CHOCH_BEARISH_REVERSAL' : 'BOS_BEARISH_CONTINUATION';

        events.push({
          barIndex: i,
          time: timeVal,
          type: eventType,
          level: activeLowLevel,
          brokenPrice: c.close,
          direction: 'BEARISH',
          label: isCounterTrend ? 'CHoCH (Bearish Reversal)' : 'BOS (Bearish Continuation)',
          breakType: 'BODY_CLOSE_CONFIRMED'
        });
        currentRegimeTrend = 'BEARISH';
        activeLowLevel = null; // Consumed
      }

      // Check Liquidity Sweeps (Wick breaks level, but body closes inside)
      if (confirmedSH && c.high > confirmedSH.price && c.close <= confirmedSH.price) {
        events.push({
          barIndex: i,
          time: timeVal,
          type: 'LIQUIDITY_SWEEP_HIGH',
          level: confirmedSH.price,
          piercedPrice: c.high,
          closePrice: c.close,
          direction: 'BEARISH_REJECTION',
          label: '💧 Sweep High (Bearish Rejection)',
          breakType: 'WICK_ONLY_SWEEP'
        });
      }
      if (confirmedSL && c.low < confirmedSL.price && c.close >= confirmedSL.price) {
        events.push({
          barIndex: i,
          time: timeVal,
          type: 'LIQUIDITY_SWEEP_LOW',
          level: confirmedSL.price,
          piercedPrice: c.low,
          closePrice: c.close,
          direction: 'BULLISH_REJECTION',
          label: '💧 Sweep Low (Bullish Rejection)',
          breakType: 'WICK_ONLY_SWEEP'
        });
      }
    }

    // Determine final structural regime
    const lastPivots = pivots.slice(-4);
    const hasHH = lastPivots.some(p => p.classification === 'HH');
    const hasHL = lastPivots.some(p => p.classification === 'HL');
    const hasLL = lastPivots.some(p => p.classification === 'LL');
    const hasLH = lastPivots.some(p => p.classification === 'LH');

    let trend = 'SIDEWAYS_RANGE';
    if (hasHH && hasHL) trend = 'BULLISH_STRUCTURE';
    else if (hasLL && hasLH) trend = 'BEARISH_STRUCTURE';
    else if (currentRegimeTrend !== 'SIDEWAYS') trend = `${currentRegimeTrend}_STRUCTURE`;

    const lastConfirmedSH = pivots.filter(p => p.type === 'SWING_HIGH').slice(-1)[0] || null;
    const lastConfirmedSL = pivots.filter(p => p.type === 'SWING_LOW').slice(-1)[0] || null;

    return {
      trend,
      pivots,
      events: events.slice(-30),
      lastConfirmedSwingHigh: lastConfirmedSH,
      lastConfirmedSwingLow: lastConfirmedSL,
      confirmationRules: {
        fractalHalfSpan: k,
        totalFractalSpan: k * 2 + 1,
        nonRepaintingGuaranteed: true,
        bosRequiresBodyClose: true
      }
    };
  }
}

module.exports = new MarketStructureEngine();
