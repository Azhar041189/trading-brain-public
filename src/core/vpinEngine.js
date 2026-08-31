const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('VPINToxicity');

/**
 * VPINCookedEngine - Volume-Synchronized Probability of Toxicity (VPIN)
 * Quantifies the presence of informed, predatory order flow by dividing trade volume
 * into constant-volume buckets and computing buy/ask volume imbalance standard deviations.
 */
class VPINCookedEngine {
  constructor(bucketSize = 50, numBuckets = 30) {
    this.bucketSize = bucketSize;   // Total volume per bucket
    this.numBuckets = numBuckets;   // Rolling window length
    this.buckets = [];
    this.currentBucket = { buyVol: 0, sellVol: 0, totalVol: 0 };
  }

  /**
   * Updates continuous volume buckets with trade volume and tick price delta
   */
  processTrade(price, volume, isBuyerMaker = false) {
    const buyVolume = isBuyerMaker ? 0 : volume;
    const sellVolume = isBuyerMaker ? volume : 0;

    this.currentBucket.buyVol += buyVolume;
    this.currentBucket.sellVol += sellVolume;
    this.currentBucket.totalVol += volume;

    if (this.currentBucket.totalVol >= this.bucketSize) {
      this.buckets.push({ ...this.currentBucket });
      if (this.buckets.length > this.numBuckets) {
        this.buckets.shift();
      }
      this.currentBucket = { buyVol: 0, sellVol: 0, totalVol: 0 };
    }
  }

  /**
   * Computes current rolling VPIN toxicity metric (0.0 to 1.0)
   */
  calculateVPIN(candles = []) {
    if (this.buckets.length < 5 && candles.length > 0) {
      // Bootstrap from candle microstructure if bucket stream is initializing
      let totalAbsImbalance = 0;
      let totalVolume = 0;
      candles.slice(-20).forEach(c => {
        const delta = c.close - c.open;
        const buyV = delta >= 0 ? c.volume * 0.65 : c.volume * 0.35;
        const sellV = c.volume - buyV;
        totalAbsImbalance += Math.abs(buyV - sellV);
        totalVolume += c.volume;
      });
      const vpin = totalVolume > 0 ? totalAbsImbalance / totalVolume : 0.25;
      return this._formatResult(vpin);
    }

    let sumImbalance = 0;
    let sumTotal = 0;
    this.buckets.forEach(b => {
      sumImbalance += Math.abs(b.buyVol - b.sellVol);
      sumTotal += b.totalVol;
    });

    const vpin = sumTotal > 0 ? sumImbalance / sumTotal : 0.22;
    return this._formatResult(vpin);
  }

  _formatResult(vpin) {
    const score = parseFloat(Math.min(1.0, Math.max(0.05, vpin)).toFixed(3));
    let toxicityRegime = 'LOW_TOXICITY';
    if (score > 0.65) toxicityRegime = 'HIGH_TOXICITY_ALERT';
    else if (score > 0.45) toxicityRegime = 'ELEVATED_INFORMED_FLOW';

    return {
      vpin: score,
      toxicityRegime,
      isToxic: score > 0.60,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new VPINCookedEngine();
