/**
 * 🌊 Reward-Aware Prediction Market Maker Engine (Stage 2 Hardened)
 * 
 * Orchestrates liquidity provisioning on TWAP-settled prediction markets.
 * Explicitly separates:
 *   - coreMakerPnL = spreadCapture - adverseSelection - inventoryLoss - executionCosts
 *   - incentivePnL = makerRebates + liquidityRewards
 *   - totalPnL = coreMakerPnL + incentivePnL
 * 
 * Classifies strategy viability:
 *   - CORE_MARKET_MAKING_EDGE (coreMakerPnL > 0)
 *   - INCENTIVE_DEPENDENT (coreMakerPnL <= 0 && totalPnL > 0)
 *   - UNPROFITABLE (totalPnL <= 0)
 */

const { polymarketProvider } = require('../providers/polymarketProvider');
const { liquidityRewardsEngine } = require('../market_making/liquidityRewardsEngine');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('RewardAwarePredictionMakerEngine');

class RewardAwarePredictionMakerEngine {
  constructor(config = {}) {
    this.targetSpreadBps = config.targetSpreadBps || 200; // 2.0% spread
    this.quoteSizeShares = config.quoteSizeShares || 100;
    this.rewardProgramActive = config.rewardProgramActive !== undefined ? config.rewardProgramActive : true;
  }

  /**
   * Evaluate two-sided quotes with core vs incentive PnL decomposition
   */
  evaluateTwoSidedQuote(market, orderBook) {
    const bestBid = orderBook.bestBid || 0.48;
    const bestAsk = orderBook.bestAsk || 0.52;
    const mid = (bestBid + bestAsk) / 2;

    const halfSpread = (mid * (this.targetSpreadBps / 10000)) / 2;
    const myBid = parseFloat(Math.max(0.01, mid - halfSpread).toFixed(2));
    const myAsk = parseFloat(Math.min(0.99, mid + halfSpread).toFixed(2));

    // 1. Core Market Making Economics (Spread capture - Adverse Selection)
    const grossSpreadCapture = (myAsk - myBid) * this.quoteSizeShares;
    const estimatedAdverseSelection = grossSpreadCapture * 0.35; // 35% adverse selection haircut
    const executionCosts = 0.00; // Zero fees for makers
    const coreMakerPnL = parseFloat((grossSpreadCapture - estimatedAdverseSelection - executionCosts).toFixed(2));

    // 2. Incentive Economics (Temporary August / Liquidity Program Rewards)
    let incentivePnL = 0;
    if (this.rewardProgramActive) {
      const distanceScore = Math.max(0.1, 1.0 - (myAsk - myBid));
      incentivePnL = parseFloat(((this.quoteSizeShares * 0.5 * distanceScore / 10000) * 1500).toFixed(2));
    }

    const totalPnL = parseFloat((coreMakerPnL + incentivePnL).toFixed(2));

    // 3. Classification
    let viabilityClassification = 'UNPROFITABLE';
    if (coreMakerPnL > 0) {
      viabilityClassification = 'CORE_MARKET_MAKING_EDGE';
    } else if (totalPnL > 0) {
      viabilityClassification = 'INCENTIVE_DEPENDENT';
    }

    return {
      marketId: market.id,
      question: market.question || market.title,
      midPrice: parseFloat(mid.toFixed(3)),
      myBid,
      myAsk,
      quoteSizeShares: this.quoteSizeShares,
      coreMakerPnL,
      incentivePnL,
      totalPnL,
      viabilityClassification,
      isRewardProgramActive: this.rewardProgramActive,
      timestamp: new Date().toISOString()
    };
  }

  setRewardProgramStatus(isActive) {
    this.rewardProgramActive = isActive === true;
    logger.info(`🌊 [RewardAwareMaker] Temporary reward program status updated: ${this.rewardProgramActive ? 'ACTIVE' : 'EXPIRED_OR_INACTIVE'}`);
  }
}

const rewardAwarePredictionMakerEngine = new RewardAwarePredictionMakerEngine();
module.exports = { RewardAwarePredictionMakerEngine, rewardAwarePredictionMakerEngine };
