const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('VolumeProfileEngine');

/**
 * VolumeProfileEngine - Computes horizontal volume distribution across price levels.
 * 
 * Precision Governance:
 * - CANDLE_APPROX_PROFILE: Estimated distribution using OHLCV candle interpolation (Confidence: LOW/MEDIUM)
 * - TICK_PROFILE: Exact executed volume at discrete price ticks (Confidence: HIGH)
 * 
 * Deterministic Value Area (VA) Algorithm:
 * 1. Identify Point of Control (POC) bin with max volume.
 * 2. Start cumulative volume = POC volume.
 * 3. Stepwise expand outward comparing upper vs lower neighboring bins.
 * 4. Add whichever neighbor has greater volume; on tie, deterministic upper-first rule applies.
 * 5. Terminate when cumulative volume >= 70% of total volume.
 * 6. Lowest selected bin = VAL; Highest selected bin = VAH.
 */
class VolumeProfileEngine {
  constructor(options = {}) {
    this.defaultNumBins = options.numBins || 50;
    this.valueAreaPct = options.valueAreaPct || 0.70; // Institutional standard 70%
  }

  /**
   * Compute deterministic Volume Profile for a set of OHLCV candles (Candle Approx Mode)
   * @param {Array} candles - Array of { open, high, low, close, volume, timestamp }
   * @param {number} numBins - Number of horizontal price slices (default: 50)
   * @param {string} sourceMode - 'CANDLE_APPROX_PROFILE' | 'TICK_PROFILE'
   * @returns {Object} Volume Profile summary with POC, VAH, VAL, bins, and precision metadata
   */
  computeProfile(candles, numBins = this.defaultNumBins, sourceMode = 'CANDLE_APPROX_PROFILE') {
    if (!Array.isArray(candles) || candles.length === 0) {
      return {
        poc: 0,
        vah: 0,
        val: 0,
        totalVolume: 0,
        valueAreaVolume: 0,
        bins: [],
        hvn: [],
        lvn: [],
        precisionMetadata: {
          mode: sourceMode,
          confidence: sourceMode === 'TICK_PROFILE' ? 'DIRECT_MEASURED' : 'ESTIMATED_PROXY',
          sampleCount: 0,
          deterministicTieBreaker: 'UPPER_NEIGHBOR_FIRST'
        }
      };
    }

    // 1. Determine session price boundaries
    let sessionHigh = -Infinity;
    let sessionLow = Infinity;
    let totalVolume = 0;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (c.high > sessionHigh) sessionHigh = c.high;
      if (c.low < sessionLow) sessionLow = c.low;
      totalVolume += (c.volume || 0);
    }

    // Guard against zero/negative range or zero volume
    if (sessionHigh <= sessionLow || totalVolume <= 0 || !isFinite(sessionHigh) || !isFinite(sessionLow)) {
      const mid = sessionHigh > 0 && isFinite(sessionHigh) ? sessionHigh : (candles[candles.length - 1]?.close || 100);
      return {
        poc: mid,
        vah: mid,
        val: mid,
        sessionHigh: mid,
        sessionLow: mid,
        totalVolume: totalVolume > 0 ? totalVolume : 0,
        valueAreaVolume: totalVolume > 0 ? totalVolume : 0,
        valueAreaCoveragePct: 100,
        bins: [],
        hvn: [],
        lvn: [],
        precisionMetadata: {
          mode: sourceMode,
          confidence: 'ZERO_RANGE_FALLBACK',
          sampleCount: candles.length,
          deterministicTieBreaker: 'UPPER_NEIGHBOR_FIRST'
        }
      };
    }

    const priceRange = sessionHigh - sessionLow;
    const binSize = priceRange / numBins;

    // 2. Initialize price bins
    const bins = [];
    for (let i = 0; i < numBins; i++) {
      const priceLower = sessionLow + (i * binSize);
      const priceUpper = priceLower + binSize;
      const priceMid = (priceLower + priceUpper) / 2;
      bins.push({
        index: i,
        priceLower,
        priceUpper,
        priceMid,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
        percentage: 0,
        isValueArea: false
      });
    }

    // 3. Distribute candle volume across intersected price bins
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const high = Math.min(c.high, sessionHigh);
      const low = Math.max(c.low, sessionLow);
      const vol = c.volume || 0;
      if (vol <= 0) continue;

      // Aggression proxy (close vs open)
      const isUp = c.close >= c.open;
      const buyFraction = isUp ? 0.65 : 0.35;
      const buyVol = vol * buyFraction;
      const sellVol = vol * (1 - buyFraction);

      const startBinIdx = Math.max(0, Math.min(numBins - 1, Math.floor((low - sessionLow) / binSize)));
      const endBinIdx = Math.max(0, Math.min(numBins - 1, Math.floor((high - sessionLow) / binSize)));

      if (startBinIdx === endBinIdx) {
        bins[startBinIdx].volume += vol;
        bins[startBinIdx].buyVolume += buyVol;
        bins[startBinIdx].sellVolume += sellVol;
      } else {
        const binSpan = (endBinIdx - startBinIdx) + 1;
        const volPerBin = vol / binSpan;
        const buyPerBin = buyVol / binSpan;
        const sellPerBin = sellVol / binSpan;

        for (let b = startBinIdx; b <= endBinIdx; b++) {
          bins[b].volume += volPerBin;
          bins[b].buyVolume += buyPerBin;
          bins[b].sellVolume += sellPerBin;
        }
      }
    }

    // 4. Identify Point of Control (POC)
    let maxVol = -1;
    let pocBinIndex = 0;

    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      b.percentage = totalVolume > 0 ? (b.volume / totalVolume) * 100 : 0;
      if (b.volume > maxVol) {
        maxVol = b.volume;
        pocBinIndex = i;
      }
    }

    const poc = bins[pocBinIndex].priceMid;
    bins[pocBinIndex].isValueArea = true;

    // 5. Deterministic Stepwise Value Area Expansion (70% Volume)
    const targetValueAreaVolume = totalVolume * this.valueAreaPct;
    let accumulatedVAVolume = bins[pocBinIndex].volume;
    let upperIdx = pocBinIndex;
    let lowerIdx = pocBinIndex;

    while (accumulatedVAVolume < targetValueAreaVolume && (upperIdx < numBins - 1 || lowerIdx > 0)) {
      const nextUpperVol = (upperIdx < numBins - 1) ? bins[upperIdx + 1].volume : -1;
      const nextLowerVol = (lowerIdx > 0) ? bins[lowerIdx - 1].volume : -1;

      // Deterministic tie-breaking: If equal, expand UPPER first
      if (nextUpperVol >= nextLowerVol && nextUpperVol >= 0) {
        upperIdx++;
        bins[upperIdx].isValueArea = true;
        accumulatedVAVolume += bins[upperIdx].volume;
      } else if (nextLowerVol >= 0) {
        lowerIdx--;
        bins[lowerIdx].isValueArea = true;
        accumulatedVAVolume += bins[lowerIdx].volume;
      } else if (upperIdx < numBins - 1) {
        upperIdx++;
        bins[upperIdx].isValueArea = true;
        accumulatedVAVolume += bins[upperIdx].volume;
      } else {
        break;
      }
    }

    const vah = bins[upperIdx].priceUpper;
    const val = bins[lowerIdx].priceLower;

    // 6. Detect High Volume Nodes (HVN) & Low Volume Nodes (LVN)
    const avgBinVolume = totalVolume / numBins;
    const hvnThreshold = avgBinVolume * 1.35;
    const lvnThreshold = avgBinVolume * 0.55;

    const hvn = [];
    const lvn = [];

    for (let i = 1; i < numBins - 1; i++) {
      const cur = bins[i].volume;
      const prev = bins[i - 1].volume;
      const next = bins[i + 1].volume;

      if (cur > prev && cur > next && cur >= hvnThreshold) {
        hvn.push({
          price: parseFloat(bins[i].priceMid.toFixed(4)),
          volume: parseFloat(cur.toFixed(2)),
          binIndex: i,
          type: 'HVN_ACCEPTANCE'
        });
      }

      if (cur < prev && cur < next && cur <= lvnThreshold) {
        lvn.push({
          price: parseFloat(bins[i].priceMid.toFixed(4)),
          volume: parseFloat(cur.toFixed(2)),
          binIndex: i,
          type: 'LVN_REJECTION_BREAKTHROUGH'
        });
      }
    }

    return {
      poc: parseFloat(poc.toFixed(4)),
      vah: parseFloat(vah.toFixed(4)),
      val: parseFloat(val.toFixed(4)),
      sessionHigh: parseFloat(sessionHigh.toFixed(4)),
      sessionLow: parseFloat(sessionLow.toFixed(4)),
      totalVolume: parseFloat(totalVolume.toFixed(2)),
      valueAreaVolume: parseFloat(accumulatedVAVolume.toFixed(2)),
      valueAreaCoveragePct: parseFloat(((accumulatedVAVolume / totalVolume) * 100).toFixed(1)),
      bins: bins.map(b => ({
        priceLower: parseFloat(b.priceLower.toFixed(4)),
        priceUpper: parseFloat(b.priceUpper.toFixed(4)),
        priceMid: parseFloat(b.priceMid.toFixed(4)),
        volume: parseFloat(b.volume.toFixed(2)),
        buyVolume: parseFloat(b.buyVolume.toFixed(2)),
        sellVolume: parseFloat(b.sellVolume.toFixed(2)),
        percentage: parseFloat(b.percentage.toFixed(2)),
        isValueArea: b.isValueArea
      })),
      hvn,
      lvn,
      precisionMetadata: {
        mode: sourceMode,
        confidence: sourceMode === 'TICK_PROFILE' ? 'DIRECT_MEASURED' : 'ESTIMATED_PROXY',
        sampleCount: candles.length,
        deterministicTieBreaker: 'UPPER_NEIGHBOR_FIRST'
      }
    };
  }

  /**
   * Check where price sits relative to Volume Profile Value Area
   */
  evaluatePriceLocation(price, profile) {
    if (!profile || !profile.poc) return { location: 'UNKNOWN', bias: 'NEUTRAL' };

    if (price > profile.vah) {
      return {
        location: 'ABOVE_VALUE_AREA',
        bias: 'BULLISH_EXPANSION',
        distanceToPOCPct: ((price - profile.poc) / profile.poc) * 100,
        distanceToVAHPct: ((price - profile.vah) / profile.vah) * 100
      };
    } else if (price < profile.val) {
      return {
        location: 'BELOW_VALUE_AREA',
        bias: 'BEARISH_EXPANSION',
        distanceToPOCPct: ((price - profile.poc) / profile.poc) * 100,
        distanceToVALPct: ((price - profile.val) / profile.val) * 100
      };
    } else {
      return {
        location: 'INSIDE_VALUE_AREA',
        bias: price >= profile.poc ? 'VALUE_AREA_UPPER_ROTATION' : 'VALUE_AREA_LOWER_ROTATION',
        distanceToPOCPct: ((price - profile.poc) / profile.poc) * 100
      };
    }
  }
}

module.exports = new VolumeProfileEngine();
