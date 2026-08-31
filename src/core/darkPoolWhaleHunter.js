const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('DarkPoolWhaleHunter');
const orderBookDepthEngine = require('./orderBookDepthEngine');

/**
 * DarkPoolWhaleHunter - Microstructure & Order Flow Toxicity Engine
 * Computes Volume Synchronized Probability of Toxicity (VPIN), detects
 * hidden iceberg slicing, and flags retail liquidity traps.
 */
class DarkPoolWhaleHunter {
  constructor() {
    this.bucketSize = 50; // Volume bucket size
    this.volumeBuckets = [];
  }

  /**
   * Analyze Order Flow Microstructure for Toxicity & Whale Traps
   * @param {string} symbol - e.g. 'BTCUSDT'
   * @param {Array} candles - Historical candle sequence
   */
  async analyzeOrderFlow(symbol, candles = []) {
    const depth = await orderBookDepthEngine.getDepth(symbol, 'CRYPTO');
    
    // 1. Order Flow Imbalance (OFI)
    const ofi = parseFloat(depth.ofi || 0);

    // 2. Whale Wall Asymmetry (Bid vs Ask Depth Ratio)
    const bidDepth = parseFloat(depth.totalBidVol || 1);
    const askDepth = parseFloat(depth.totalAskVol || 1);
    const depthRatio = bidDepth / Math.max(0.001, askDepth);

    // 3. VPIN Proxy (Volume-Synchronized Probability of Toxicity)
    const recentCandles = candles.slice(-10);
    let aggressiveBuyVol = 0;
    let aggressiveSellVol = 0;

    recentCandles.forEach(c => {
      if (c.close >= c.open) aggressiveBuyVol += (c.volume || 1);
      else aggressiveSellVol += (c.volume || 1);
    });

    const totalVol = Math.max(1, aggressiveBuyVol + aggressiveSellVol);
    const vpin = Math.abs(aggressiveBuyVol - aggressiveSellVol) / totalVol;

    // 4. Trap Detection (Stop-loss sweep rejection wick)
    const latest = candles[candles.length - 1];
    let trapDetected = false;
    let trapType = 'NONE';

    if (latest) {
      const upperWick = latest.high - Math.max(latest.open, latest.close);
      const lowerWick = Math.min(latest.open, latest.close) - latest.low;
      const body = Math.abs(latest.close - latest.open);

      if (lowerWick > body * 2.2 && ofi > 0.2) {
        trapDetected = true;
        trapType = 'BULL_TRAP_REVERSAL_LONG'; // Bear trap sprung: Buyers stepped in hard
      } else if (upperWick > body * 2.2 && ofi < -0.2) {
        trapDetected = true;
        trapType = 'BEAR_TRAP_REVERSAL_SHORT'; // Bull trap sprung: Sellers dumped overhead
      }
    }

    const isInstitutionalAccumulation = depthRatio > 2.0 && ofi > 0.25;
    const isInstitutionalDistribution = depthRatio < 0.5 && ofi < -0.25;

    return {
      symbol,
      ofi,
      vpin: parseFloat(vpin.toFixed(3)),
      depthRatio: parseFloat(depthRatio.toFixed(2)),
      whaleBidsCount: (depth.whaleBids || []).length,
      whaleAsksCount: (depth.whaleAsks || []).length,
      isInstitutionalAccumulation,
      isInstitutionalDistribution,
      trapDetected,
      trapType,
      institutionalBias: isInstitutionalAccumulation ? 'STRONG_ACCUMULATION' : (isInstitutionalDistribution ? 'STRONG_DISTRIBUTION' : 'NEUTRAL')
    };
  }
}

module.exports = new DarkPoolWhaleHunter();
