/**
 * 🎯 Directional Executable Expected Value Engine (Phase P2)
 * 
 * Computes depth-weighted execution pricing, dynamic fee curves (with 5-decimal rounding),
 * and dual Point EV & Robust EV ([pLow, pHigh]) on the executable side of the order book.
 */

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('DirectionalEvEngine');

class DirectionalEvEngine {
  constructor(config = {}) {
    this.defaultExecutionFriction = config.defaultExecutionFriction || 0.001; // $0.001 per share safety buffer
  }

  /**
   * Calculate depth-weighted average fill price from order book
   * @param {Array<Object>} bookSide - Array of { price, size } sorted by best execution price
   * @param {number} requestedShares - Number of shares desired
   * @returns {Object} { executable: boolean, averagePrice: number, filledShares: number, slippageFromBest: number }
   */
  calculateDepthWeightedFillPrice(bookSide = [], requestedShares = 100) {
    if (!bookSide || bookSide.length === 0 || requestedShares <= 0) {
      return { executable: false, averagePrice: 0, filledShares: 0, slippageFromBest: 0 };
    }

    const bestPrice = bookSide[0].price;
    let remainingShares = requestedShares;
    let totalCost = 0;
    let filledShares = 0;

    for (const level of bookSide) {
      const fillAmount = Math.min(remainingShares, level.size);
      totalCost += fillAmount * level.price;
      filledShares += fillAmount;
      remainingShares -= fillAmount;

      if (remainingShares <= 0) break;
    }

    if (filledShares === 0) {
      return { executable: false, averagePrice: 0, filledShares: 0, slippageFromBest: 0 };
    }

    const averagePrice = parseFloat((totalCost / filledShares).toFixed(5));
    const slippageFromBest = parseFloat(Math.abs(averagePrice - bestPrice).toFixed(5));

    return {
      executable: filledShares >= requestedShares,
      averagePrice,
      filledShares,
      requestedShares,
      slippageFromBest
    };
  }

  /**
   * Calculate Polymarket dynamic fee with official 5-decimal rounding
   * Formula: Fee = round5(C * feeRate * (p * (1 - p)))
   * @param {number} price - Share price (0.00 to 1.00)
   * @param {number} shareCount - Number of shares
   * @param {Object} feeSchedule - { feeRate, feesEnabled, exponent }
   * @returns {Object} { totalFeeUSD, feePerShare }
   */
  calculateDynamicFee(price, shareCount = 1, feeSchedule = {}) {
    if (!feeSchedule.feesEnabled || !feeSchedule.feeRate || feeSchedule.feeRate === 0) {
      return { totalFeeUSD: 0.00, feePerShare: 0.00 };
    }

    const feeRate = feeSchedule.feeRate;
    const p = Math.max(0.01, Math.min(0.99, price));
    
    // Official formula: Fee = C * feeRate * (p * (1 - p))
    const rawFeePerShare = feeRate * (p * (1 - p));
    const feePerShare = parseFloat(rawFeePerShare.toFixed(5));
    const totalFeeUSD = parseFloat((feePerShare * shareCount).toFixed(5));

    return { totalFeeUSD, feePerShare };
  }

  /**
   * Evaluate Directional Expected Value for YES and NO opportunities
   * @param {Object} params - { side: 'YES'|'NO', pFair, pLow, pHigh, orderBookSide, requestedShares, feeSchedule }
   * @returns {Object} Complete Directional EV Assessment
   */
  evaluateDirectionalEv(params) {
    const {
      side = 'YES',
      pFair = 0.50,
      pLow = 0.45,
      pHigh = 0.55,
      orderBookSide = [],
      requestedShares = 100,
      feeSchedule = {}
    } = params;

    // 1. Calculate depth-weighted fill price (incorporates book depth / slippage)
    const fillResult = this.calculateDepthWeightedFillPrice(orderBookSide, requestedShares);
    if (!fillResult.executable) {
      return {
        executable: false,
        side,
        status: 'INSUFFICIENT_DEPTH',
        pointEvUSD: 0,
        robustEvUSD: 0
      };
    }

    const avgPrice = fillResult.averagePrice;

    // 2. Calculate dynamic fee per share with 5-decimal rounding
    const feeResult = this.calculateDynamicFee(avgPrice, requestedShares, feeSchedule);
    const feePerShare = feeResult.feePerShare;

    // 3. All-In Acquisition Cost Per Share (No slippage double counting)
    const allInCostPerShare = parseFloat((avgPrice + feePerShare + this.defaultExecutionFriction).toFixed(5));
    const totalAllInCostUSD = parseFloat((allInCostPerShare * requestedShares).toFixed(4));

    // 4. Calculate Directional Point EV and Robust EV
    let pointEvPerShare = 0;
    let robustEvPerShare = 0;
    let maxLossPerShare = allInCostPerShare;

    if (side === 'YES') {
      pointEvPerShare = parseFloat((pFair - allInCostPerShare).toFixed(5));
      robustEvPerShare = parseFloat((pLow - allInCostPerShare).toFixed(5));
    } else { // NO
      pointEvPerShare = parseFloat(((1.0 - pFair) - allInCostPerShare).toFixed(5));
      robustEvPerShare = parseFloat(((1.0 - pHigh) - allInCostPerShare).toFixed(5));
    }

    const pointEvUSD = parseFloat((pointEvPerShare * requestedShares).toFixed(4));
    const robustEvUSD = parseFloat((robustEvPerShare * requestedShares).toFixed(4));
    const maxLossUSD = totalAllInCostUSD;
    const expectedReturnOnRisk = maxLossPerShare > 0 ? parseFloat((robustEvPerShare / maxLossPerShare).toFixed(4)) : 0;

    const isRobustOpportunity = pointEvPerShare > 0 && robustEvPerShare > 0;
    const status = isRobustOpportunity ? 'POSITIVE_ROBUST_EDGE' : pointEvPerShare > 0 ? 'MARGINAL_CENTER_EDGE_ONLY' : 'NEGATIVE_EDGE';

    return {
      executable: true,
      side,
      status,
      isRobustOpportunity,
      pricing: {
        avgFillPrice: avgPrice,
        feePerShare,
        totalFeeUSD: feeResult.totalFeeUSD,
        allInCostPerShare,
        totalAllInCostUSD
      },
      probabilities: {
        pFair,
        pLow,
        pHigh
      },
      metrics: {
        pointEvPerShare,
        robustEvPerShare,
        pointEvUSD,
        robustEvUSD,
        maxLossUSD,
        expectedReturnOnRisk
      },
      evaluatedAt: new Date().toISOString()
    };
  }
}

const directionalEvEngine = new DirectionalEvEngine();
module.exports = { DirectionalEvEngine, directionalEvEngine };
