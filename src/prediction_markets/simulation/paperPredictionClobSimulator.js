/**
 * 🕹️ Hardened Pessimistic Paper CLOB Simulator & News Kill Switch (Phase P3 Adversarial)
 * 
 * Enforces:
 *   - Zero-Signing Sandbox: Invariant startup refusal on any private key.
 *   - Explicit Fill Provenance: EXACT_MATCH_OBSERVED, QUEUE_ESTIMATED, DEPTH_ESTIMATED, NO_FILL.
 *   - News Kill-Switch Race Condition: Cancellation latency vs adverse trade arrivals.
 *   - Contract Semantic Hash Invalidation: Automatic purge of resting quotes on rule clarification.
 *   - Dynamic Fee Mutation Detection at fill time.
 *   - Independent NO-Side & Non-Binary Resolution Accounting (INVALID, DISPUTED, CANCELLED).
 */

const fs = require('fs');
const path = require('path');
const { complianceGate } = require('../compliance/complianceGate');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('PaperPredictionClobSimulator');
const TRADES_FILE = path.join(__dirname, '../../../data/polymarket_paper_trades.json');

class PaperPredictionClobSimulator {
  constructor(config = {}) {
    // Enforce Zero-Signing Sandbox Invariant
    complianceGate.verifyEnvironment();

    this.defaultCancelLatencyMs = config.defaultCancelLatencyMs || 100;
    this.restingOrders = new Map(); // orderId -> OrderRecord
    this.filledTrades = this._loadTrades();
    this.cancelledOrders = [];
    this.newsKillSwitchActive = false;
  }

  _loadTrades() {
    try {
      if (fs.existsSync(TRADES_FILE)) {
        const raw = fs.readFileSync(TRADES_FILE, 'utf8');
        return JSON.parse(raw) || [];
      }
    } catch (e) {}
    return [];
  }

  _saveTrades() {
    try {
      const dir = path.dirname(TRADES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(TRADES_FILE, JSON.stringify(this.filledTrades, null, 2));
    } catch (e) {}
  }

  /**
   * Submit a simulated Taker Market/Cross order against current order book
   */
  simulateTakerOrder(order) {
    if (!order || !order.bookSide || order.bookSide.length === 0 || !order.shares || order.shares <= 0) {
      return {
        orderId: `taker_${Date.now()}`,
        status: 'REJECTED',
        fillProvenance: 'NO_FILL',
        filledShares: 0,
        averageFillPrice: 0,
        reason: 'Empty book or invalid shares'
      };
    }

    // Check for Fee Schedule Mutation
    if (order.decisionFeeScheduleHash && order.currentFeeScheduleHash && order.decisionFeeScheduleHash !== order.currentFeeScheduleHash) {
      logger.warn(`🛑 [PaperSimulator] Fill rejected: Fee schedule mutated between decision and fill.`);
      return {
        orderId: `taker_${Date.now()}`,
        status: 'REJECTED_FEE_MUTATION',
        fillProvenance: 'NO_FILL',
        filledShares: 0,
        reason: 'Fee schedule mutated since decision generation'
      };
    }

    const orderId = `taker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const bookSide = order.bookSide; // Array of { price, size }
    let remainingShares = order.shares;
    let totalCost = 0;
    let filledShares = 0;
    const filledLevels = [];

    for (const level of bookSide) {
      const fillQty = Math.min(remainingShares, level.size);
      totalCost += fillQty * level.price;
      filledShares += fillQty;
      remainingShares -= fillQty;
      filledLevels.push({ price: level.price, size: fillQty });

      if (remainingShares <= 0) break;
    }

    if (filledShares === 0) {
      return {
        orderId,
        status: 'UNFILLED',
        fillProvenance: 'NO_FILL',
        filledShares: 0,
        averageFillPrice: 0
      };
    }

    const averageFillPrice = parseFloat((totalCost / filledShares).toFixed(5));
    const isFullFill = filledShares >= order.shares;
    
    // Fee calculation (Polymarket dynamic formula: C * r * p(1-p))
    const feeRate = (order.feeSchedule && order.feeSchedule.feesEnabled) ? (order.feeSchedule.feeRate || 0.07) : 0.00;
    const p = Math.max(0.01, Math.min(0.99, averageFillPrice));
    const feePerShare = parseFloat((feeRate * (p * (1 - p))).toFixed(5));
    const totalFeeUSD = parseFloat((feePerShare * filledShares).toFixed(5));

    // Independent NO-side / YES-side Max Loss and Exposure Accounting
    const outcome = order.outcome || 'YES';
    const maxLossPerShare = outcome === 'YES' ? averageFillPrice : parseFloat((1.00 - averageFillPrice).toFixed(5));
    const maxLossTotalUSD = parseFloat((maxLossPerShare * filledShares + totalFeeUSD).toFixed(5));

    const fillRecord = {
      orderId,
      marketId: order.marketId,
      question: order.question || `Market ${order.marketId}`,
      tokenId: order.tokenId,
      side: order.side || 'BUY',
      outcome,
      type: 'TAKER',
      status: isFullFill ? 'FILLED' : 'PARTIALLY_FILLED',
      fillProvenance: 'DEPTH_ESTIMATED',
      requestedShares: order.shares,
      filledShares,
      averageFillPrice,
      totalCostUSD: parseFloat((totalCost + totalFeeUSD).toFixed(5)),
      totalFeeUSD,
      maxLossTotalUSD,
      bookHash: order.bookHash || null,
      filledLevels,
      timestamp: new Date().toISOString()
    };

    this.filledTrades.push(fillRecord);
    this._saveTrades();
    logger.info(`⚡ [PaperSimulator] TAKER ${fillRecord.status}: ${filledShares}/${order.shares} ${outcome} shares @ avg $${averageFillPrice} (Fee: $${totalFeeUSD})`);

    return fillRecord;
  }

  /**
   * Submit a simulated Maker Limit Order (Posting liquidity)
   */
  submitMakerLimitOrder(order) {
    if (this.newsKillSwitchActive) {
      logger.warn('🛑 [PaperSimulator] Maker order rejected: News Kill Switch is currently active.');
      return { status: 'REJECTED_NEWS_KILL_SWITCH' };
    }

    const orderId = `maker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const outcome = order.outcome || 'YES';
    const price = order.price;
    const maxLossPerShare = outcome === 'YES' ? price : parseFloat((1.00 - price).toFixed(5));

    const record = {
      orderId,
      marketId: order.marketId,
      tokenId: order.tokenId,
      side: order.side || 'BUY',
      outcome,
      price,
      shares: order.shares,
      remainingShares: order.shares,
      subCluster: order.subCluster || 'GENERAL',
      status: 'RESTING',
      fillProvenance: 'QUEUE_ESTIMATED',
      queuePositionAhead: order.queuePositionAhead || order.shares * 2, // Conservative queue bias
      expectedRebateUSD: 0.00, // Conservative maker baseline
      maxLossTotalUSD: parseFloat((maxLossPerShare * order.shares).toFixed(5)),
      contractSemanticHash: order.contractSemanticHash || null,
      bookHash: order.bookHash || null,
      postedAt: new Date().toISOString()
    };

    this.restingOrders.set(orderId, record);
    logger.info(`📥 [PaperSimulator] MAKER POSTED: ${record.shares} ${outcome} shares @ $${record.price} (Order ${orderId})`);
    return record;
  }

  /**
   * Invalidate resting orders when a contract's semantic rules or clarifications mutate
   */
  invalidateOnContractClarification(marketId, newSemanticHash) {
    const purged = [];
    for (const [orderId, order] of this.restingOrders.entries()) {
      if (order.marketId === marketId && order.contractSemanticHash !== newSemanticHash) {
        order.status = 'CANCELLED_CONTRACT_MUTATION';
        order.cancelledAt = new Date().toISOString();
        this.cancelledOrders.push(order);
        this.restingOrders.delete(orderId);
        purged.push(orderId);
      }
    }
    logger.info(`🛡️ [PaperSimulator] Purged ${purged.length} quotes on contract rule mutation for market '${marketId}'`);
    return { success: true, purgedCount: purged.length, purgedOrderIds: purged };
  }

  /**
   * Trigger News Kill Switch with realistic cancellation latency race modeling
   * @param {string} targetCluster - 'ALL' or cluster name
   * @param {Object} options - { cancellationDelayMs: number, marketMovedAdversely: boolean }
   */
  triggerNewsKillSwitch(targetCluster = 'ALL', options = {}) {
    this.newsKillSwitchActive = true;
    const cancelDelayMs = options.cancellationDelayMs !== undefined ? options.cancellationDelayMs : this.defaultCancelLatencyMs;
    const marketMovedAdversely = options.marketMovedAdversely === true;

    logger.warn(`🚨 [PaperSimulator] NEWS KILL SWITCH ACTIVATED for '${targetCluster}' (Cancel Delay: ${cancelDelayMs}ms)!`);

    const cancelledOrderIds = [];
    const adverseFillOrderIds = [];

    for (const [orderId, order] of this.restingOrders.entries()) {
      if (targetCluster === 'ALL' || order.subCluster === targetCluster) {
        if (marketMovedAdversely && cancelDelayMs > 50) {
          // Cancellation lost the race to an informed sniper
          order.status = 'CANCEL_LOST_RACE_FILLED';
          order.fillProvenance = 'EXACT_MATCH_OBSERVED';
          order.filledAt = new Date().toISOString();
          this.filledTrades.push(order);
          this.restingOrders.delete(orderId);
          adverseFillOrderIds.push(orderId);
          logger.warn(`💥 [PaperSimulator] Order ${orderId} LOST CANCEL RACE and was adversely filled!`);
        } else {
          // Successfully purged
          order.status = 'CANCELLED_NEWS_KILL_SWITCH';
          order.cancelledAt = new Date().toISOString();
          this.cancelledOrders.push(order);
          this.restingOrders.delete(orderId);
          cancelledOrderIds.push(orderId);
        }
      }
    }

    const timer = setTimeout(() => {
      this.newsKillSwitchActive = false;
      logger.info('🟢 [PaperSimulator] News Kill Switch reset to standby.');
    }, 10000);
    if (timer.unref) timer.unref();

    return {
      success: true,
      targetCluster,
      cancelledCount: cancelledOrderIds.length,
      cancelledOrderIds,
      adverseFillsCount: adverseFillOrderIds.length,
      adverseFillOrderIds
    };
  }

  /**
   * Simulate resolution accounting for both binary & non-binary edge cases
   * @param {Object} position - { outcome: 'YES'|'NO', shares, averageFillPrice, totalCostUSD }
   * @param {string} resolutionType - 'RESOLVED_YES' | 'RESOLVED_NO' | 'RESOLVED_INVALID' | 'DISPUTED_UMA' | 'CANCELLED_VENUE'
   */
  calculateResolutionSettlement(position, resolutionType) {
    const shares = position.shares || position.filledShares || 0;
    const cost = position.totalCostUSD || 0;
    let payoutPerShare = 0.0;
    let status = 'SETTLED';

    switch (resolutionType) {
      case 'RESOLVED_YES':
        payoutPerShare = position.outcome === 'YES' ? 1.00 : 0.00;
        break;
      case 'RESOLVED_NO':
        payoutPerShare = position.outcome === 'NO' ? 1.00 : 0.00;
        break;
      case 'RESOLVED_INVALID':
        // Polymarket splits invalid outcomes 50/50 ($0.50 per share payout)
        payoutPerShare = 0.50;
        status = 'SETTLED_INVALID_SPLIT';
        break;
      case 'CANCELLED_VENUE':
        // Full refund of acquisition price
        payoutPerShare = position.averageFillPrice;
        status = 'SETTLED_VENUE_CANCELLED';
        break;
      case 'DISPUTED_UMA':
        // Capital frozen pending oracle arbitration
        return {
          status: 'FROZEN_DISPUTED_UMA',
          totalPayoutUSD: 0.0,
          netPnlUSD: 0.0,
          capitalLockedUSD: cost
        };
      default:
        payoutPerShare = 0.0;
    }

    const totalPayoutUSD = parseFloat((shares * payoutPerShare).toFixed(5));
    const netPnlUSD = parseFloat((totalPayoutUSD - cost).toFixed(5));

    return {
      status,
      resolutionType,
      shares,
      payoutPerShare,
      totalPayoutUSD,
      netPnlUSD,
      roiPct: cost > 0 ? parseFloat(((netPnlUSD / cost) * 100).toFixed(2)) : 0.0
    };
  }

  getRestingOrders() {
    return Array.from(this.restingOrders.values());
  }

  getFilledTrades() {
    return this.filledTrades;
  }
}

const paperPredictionClobSimulator = new PaperPredictionClobSimulator();
module.exports = { PaperPredictionClobSimulator, paperPredictionClobSimulator };
