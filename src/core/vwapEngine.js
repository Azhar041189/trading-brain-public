const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('VWAPEngine');

/**
 * VWAPEngine - Computes Session VWAP, Multi-Anchor VWAP, and True Volume-Weighted Standard Deviation Bands.
 * 
 * Mathematical Formulation:
 * 1. VWAP = sum(TypicalPrice * Volume) / sum(Volume)
 * 2. Volume-Weighted Variance = sum(Volume * (TypicalPrice - VWAP)^2) / sum(Volume)
 * 3. Sigma = sqrt(Volume-Weighted Variance)
 * 4. Bands: Upper/Lower = VWAP ± (k * Sigma)
 * 
 * Session Reset Policies:
 * - IN (NSE): Resets daily at 09:15 IST (03:45 UTC)
 * - US (NYSE/NASDAQ): Resets daily at 09:30 ET (13:30 / 14:30 UTC depending on DST)
 * - CRYPTO: Resets daily at 00:00 UTC
 * - FOREX: Resets daily at 17:00 ET (21:00 / 22:00 UTC)
 */
class VWAPEngine {
  /**
   * Compute Session VWAP and Volume-Weighted Standard Deviation Bands
   * @param {Array} candles - OHLCV candles
   * @param {Object} options - { anchorIndex, market: 'CRYPTO'|'IN'|'US'|'FOREX' }
   * @returns {Object} { currentVWAP, currentSigma, bands, series, metrics }
   */
  computeVWAP(candles, options = {}) {
    if (!Array.isArray(candles) || candles.length === 0) {
      return {
        currentVWAP: 0,
        currentSigma: 0,
        bands: { upper1: 0, lower1: 0, upper2: 0, lower2: 0 },
        series: [],
        metrics: { distancePct: 0, sigmaDistance: 0, bias: 'NEUTRAL' }
      };
    }

    const anchorIdx = Math.max(0, Math.min(candles.length - 1, options.anchorIndex !== undefined ? options.anchorIndex : 0));
    const series = [];

    let cumVolume = 0;
    let cumTypicalVolume = 0;

    // First pass: compute running VWAP
    const runningVWAPs = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const typical = (c.high + c.low + c.close) / 3;
      const vol = Math.max(0, c.volume || 1);

      if (i < anchorIdx) {
        runningVWAPs.push(typical);
        continue;
      }

      cumVolume += vol;
      cumTypicalVolume += (typical * vol);
      const vwap = cumVolume > 0 ? (cumTypicalVolume / cumVolume) : typical;
      runningVWAPs.push(vwap);
    }

    // Second pass: compute running Volume-Weighted Variance around the anchored VWAP
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const typical = (c.high + c.low + c.close) / 3;
      const timeVal = c.time || (c.timestamp ? Math.floor(new Date(c.timestamp).getTime() / 1000) : i);

      if (i < anchorIdx) {
        series.push({
          time: timeVal,
          vwap: typical,
          upper1: typical,
          lower1: typical,
          upper2: typical,
          lower2: typical,
          sigma: 0
        });
        continue;
      }

      const curVWAP = runningVWAPs[i];
      
      // True volume-weighted variance from anchorIdx up to bar i
      let sumVol = 0;
      let sumVolDevSq = 0;
      for (let j = anchorIdx; j <= i; j++) {
        const cj = candles[j];
        const typj = (cj.high + cj.low + cj.close) / 3;
        const vj = Math.max(0, cj.volume || 1);
        sumVol += vj;
        sumVolDevSq += vj * Math.pow(typj - curVWAP, 2);
      }

      const variance = sumVol > 0 ? (sumVolDevSq / sumVol) : 0;
      const sigma = Math.sqrt(Math.max(0, variance));

      series.push({
        time: timeVal,
        vwap: parseFloat(curVWAP.toFixed(4)),
        upper1: parseFloat((curVWAP + (1.0 * sigma)).toFixed(4)),
        lower1: parseFloat((curVWAP - (1.0 * sigma)).toFixed(4)),
        upper2: parseFloat((curVWAP + (2.0 * sigma)).toFixed(4)),
        lower2: parseFloat((curVWAP - (2.0 * sigma)).toFixed(4)),
        sigma: parseFloat(sigma.toFixed(4))
      });
    }

    const lastPoint = series[series.length - 1];
    const lastClose = candles[candles.length - 1].close;
    const distancePct = lastPoint.vwap > 0 ? ((lastClose - lastPoint.vwap) / lastPoint.vwap) * 100 : 0;
    const sigmaDist = lastPoint.sigma > 0 ? (lastClose - lastPoint.vwap) / lastPoint.sigma : 0;

    let bias = 'NEUTRAL_AT_FAIR_VALUE';
    if (sigmaDist > 2.0) bias = 'OVERBOUGHT_MEAN_REVERSION_RISK';
    else if (sigmaDist > 1.0) bias = 'BULLISH_EXPANSION';
    else if (sigmaDist < -2.0) bias = 'OVERSOLD_MEAN_REVERSION_BOUNCE';
    else if (sigmaDist < -1.0) bias = 'BEARISH_EXPANSION';

    return {
      currentVWAP: lastPoint.vwap,
      currentSigma: lastPoint.sigma,
      bands: {
        upper1: lastPoint.upper1,
        lower1: lastPoint.lower1,
        upper2: lastPoint.upper2,
        lower2: lastPoint.lower2
      },
      series,
      metrics: {
        lastPrice: lastClose,
        distancePct: parseFloat(distancePct.toFixed(2)),
        sigmaDistance: parseFloat(sigmaDist.toFixed(2)),
        bias,
        volumeWeighted: true
      }
    };
  }

  /**
   * Identify session boundary index based on market venue
   */
  findSessionAnchorIndex(candles, market = 'CRYPTO') {
    if (!Array.isArray(candles) || candles.length === 0) return 0;

    for (let i = candles.length - 1; i >= 0; i--) {
      const ts = candles[i].timestamp ? new Date(candles[i].timestamp) : (candles[i].time ? new Date(candles[i].time * 1000) : null);
      if (!ts || isNaN(ts.getTime())) continue;

      if (market === 'IN') {
        // Indian NSE session open at 09:15 IST (03:45 UTC)
        const istHours = (ts.getUTCHours() + 5 + Math.floor((ts.getUTCMinutes() + 30) / 60)) % 24;
        const istMinutes = (ts.getUTCMinutes() + 30) % 60;
        if (istHours === 9 && istMinutes <= 20) return i;
      } else if (market === 'US') {
        // US session open at 09:30 ET (13:30 or 14:30 UTC)
        const utcHours = ts.getUTCHours();
        const utcMinutes = ts.getUTCMinutes();
        if ((utcHours === 13 || utcHours === 14) && utcMinutes >= 30 && utcMinutes <= 35) return i;
      } else {
        // Crypto session open at 00:00 UTC
        if (ts.getUTCHours() === 0 && ts.getUTCMinutes() <= 15) return i;
      }
    }

    return 0; // Fallback to start of candle buffer
  }

  /**
   * Compute Anchored VWAP from specific anchor events
   */
  computeAnchoredVWAP(candles, anchorType = 'SESSION_OPEN', market = 'CRYPTO') {
    if (!Array.isArray(candles) || candles.length === 0) return this.computeVWAP([]);

    let anchorIndex = 0;

    if (anchorType === 'SWING_HIGH') {
      let maxHigh = -Infinity;
      candles.forEach((c, idx) => {
        if (c.high > maxHigh) {
          maxHigh = c.high;
          anchorIndex = idx;
        }
      });
    } else if (anchorType === 'SWING_LOW') {
      let minLow = Infinity;
      candles.forEach((c, idx) => {
        if (c.low < minLow) {
          minLow = c.low;
          anchorIndex = idx;
        }
      });
    } else if (anchorType === 'SESSION_OPEN') {
      anchorIndex = this.findSessionAnchorIndex(candles, market);
    }

    return this.computeVWAP(candles, { anchorIndex, market });
  }
}

module.exports = new VWAPEngine();
