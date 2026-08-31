const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('SmartMoneyEngine');

/**
 * SmartMoneyEngine (SMC & Order Block Alpha)
 * Institutional Order Flow Mechanics:
 * 1. Order Block (OB) Detection (Demand / Supply zones)
 * 2. Fair Value Gap (FVG) Scanner (3-candle price imbalances)
 * 3. Break of Structure (BOS) & Change of Character (CHoCH)
 * 4. Retail Liquidity Sweeps (Stop Hunts & Equal Highs/Lows)
 */
class SmartMoneyEngine {
  constructor() {
    this.fvgThresholdPct = 0.002; // 0.2% minimum imbalance gap
    this.obLookback = 30;
  }

  analyzeSMC(symbol, candles = []) {
    if (!candles || candles.length < 15) {
      return {
        symbol,
        trendStructure: 'NEUTRAL',
        orderBlocks: [],
        fairValueGaps: [],
        liquiditySweeps: [],
        smcScore: 0,
        direction: 'NEUTRAL'
      };
    }

    const orderBlocks = this.detectOrderBlocks(candles);
    const fairValueGaps = this.scanFairValueGaps(candles);
    const marketStructure = this.detectMarketStructure(candles);
    const liquiditySweeps = this.detectLiquiditySweeps(candles);

    let biasScore = 0;
    if (marketStructure.trend === 'BULLISH') biasScore += 0.35;
    else if (marketStructure.trend === 'BEARISH') biasScore -= 0.35;

    const currentPrice = candles[candles.length - 1].close;
    const activeDemandOB = orderBlocks.find(ob => ob.type === 'BULLISH_DEMAND' && currentPrice >= ob.low && currentPrice <= ob.high * 1.005);
    const activeSupplyOB = orderBlocks.find(ob => ob.type === 'BEARISH_SUPPLY' && currentPrice <= ob.high && currentPrice >= ob.low * 0.995);

    if (activeDemandOB) biasScore += 0.40;
    if (activeSupplyOB) biasScore -= 0.40;

    const latestFVG = fairValueGaps[fairValueGaps.length - 1];
    if (latestFVG && !latestFVG.mitigated) {
      if (latestFVG.type === 'BULLISH_FVG' && currentPrice >= latestFVG.low) biasScore += 0.25;
      if (latestFVG.type === 'BEARISH_FVG' && currentPrice <= latestFVG.high) biasScore -= 0.25;
    }

    let direction = 'NEUTRAL';
    let confidence = 0.50;
    if (biasScore >= 0.40) {
      direction = 'LONG';
      confidence = Math.min(0.92, 0.70 + Math.abs(biasScore) * 0.25);
    } else if (biasScore <= -0.40) {
      direction = 'SHORT';
      confidence = Math.min(0.92, 0.70 + Math.abs(biasScore) * 0.25);
    }

    return {
      symbol,
      trendStructure: marketStructure.trend,
      structureEvent: marketStructure.lastEvent,
      orderBlocks: orderBlocks.slice(-3),
      fairValueGaps: fairValueGaps.slice(-3),
      liquiditySweeps: liquiditySweeps.slice(-2),
      activeDemandOB: !!activeDemandOB,
      activeSupplyOB: !!activeSupplyOB,
      biasScore: parseFloat(biasScore.toFixed(2)),
      direction,
      confidence: parseFloat(confidence.toFixed(2)),
      timestamp: new Date().toISOString()
    };
  }

  detectOrderBlocks(candles = []) {
    const obs = [];
    const n = candles.length;
    for (let i = 2; i < n - 1; i++) {
      const curr = candles[i];
      const next = candles[i + 1];

      if (curr.close < curr.open && next.close > next.open && next.close > curr.high) {
        const expansionPct = ((next.close - curr.low) / curr.low) * 100;
        if (expansionPct >= 0.3) {
          obs.push({
            type: 'BULLISH_DEMAND',
            time: curr.timestamp,
            high: curr.high,
            low: curr.low,
            open: curr.open,
            close: curr.close,
            mitigated: false
          });
        }
      }

      if (curr.close > curr.open && next.close < next.open && next.close < curr.low) {
        const expansionPct = ((curr.high - next.close) / curr.high) * 100;
        if (expansionPct >= 0.3) {
          obs.push({
            type: 'BEARISH_SUPPLY',
            time: curr.timestamp,
            high: curr.high,
            low: curr.low,
            open: curr.open,
            close: curr.close,
            mitigated: false
          });
        }
      }
    }
    return obs;
  }

  scanFairValueGaps(candles = []) {
    const fvgs = [];
    const n = candles.length;
    for (let i = 2; i < n; i++) {
      const c1 = candles[i - 2];
      const c2 = candles[i - 1];
      const c3 = candles[i];

      if (c3.low > c1.high) {
        const gapSize = c3.low - c1.high;
        const gapPct = gapSize / c1.high;
        if (gapPct >= this.fvgThresholdPct) {
          fvgs.push({
            type: 'BULLISH_FVG',
            time: c2.timestamp,
            high: c3.low,
            low: c1.high,
            size: gapSize,
            mitigated: candles.slice(i + 1).some(c => c.low <= c1.high)
          });
        }
      }

      if (c3.high < c1.low) {
        const gapSize = c1.low - c3.high;
        const gapPct = gapSize / c1.low;
        if (gapPct >= this.fvgThresholdPct) {
          fvgs.push({
            type: 'BEARISH_FVG',
            time: c2.timestamp,
            high: c1.low,
            low: c3.high,
            size: gapSize,
            mitigated: candles.slice(i + 1).some(c => c.high >= c1.low)
          });
        }
      }
    }
    return fvgs;
  }

  detectMarketStructure(candles = []) {
    const n = candles.length;
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const currentPrice = candles[n - 1].close;

    const recentSwingHigh = Math.max(...highs.slice(-15, -3));
    const recentSwingLow = Math.min(...lows.slice(-15, -3));

    let trend = 'NEUTRAL';
    let lastEvent = 'RANGE_CONSOLIDATION';

    if (currentPrice > recentSwingHigh) {
      trend = 'BULLISH';
      lastEvent = 'BOS_BULLISH_BREAKOUT';
    } else if (currentPrice < recentSwingLow) {
      trend = 'BEARISH';
      lastEvent = 'BOS_BEARISH_BREAKDOWN';
    }

    return { trend, lastEvent, swingHigh: recentSwingHigh, swingLow: recentSwingLow };
  }

  detectLiquiditySweeps(candles = []) {
    const sweeps = [];
    const n = candles.length;
    if (n < 10) return sweeps;

    const lookbackHighs = candles.slice(-12, -2).map(c => c.high);
    const lookbackLows = candles.slice(-12, -2).map(c => c.low);
    const swingHigh = Math.max(...lookbackHighs);
    const swingLow = Math.min(...lookbackLows);

    const latest = candles[n - 1];
    const upperWick = latest.high - Math.max(latest.open, latest.close);
    const lowerWick = Math.min(latest.open, latest.close) - latest.low;
    const body = Math.abs(latest.close - latest.open);

    if (latest.high > swingHigh && latest.close < swingHigh && upperWick > body * 1.2) {
      sweeps.push({
        type: 'BUY_SIDE_LIQUIDITY_SWEEP',
        bias: 'BEARISH_REVERSAL',
        level: swingHigh,
        time: latest.timestamp
      });
    }

    if (latest.low < swingLow && latest.close > swingLow && lowerWick > body * 1.2) {
      sweeps.push({
        type: 'SELL_SIDE_LIQUIDITY_SWEEP',
        bias: 'BULLISH_REVERSAL',
        level: swingLow,
        time: latest.timestamp
      });
    }

    return sweeps;
  }
}

module.exports = new SmartMoneyEngine();
