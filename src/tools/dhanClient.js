const axios = require('axios');
const config = require('../config');
const { createAgentLogger } = require('../core/logger');

const logger = createAgentLogger('DhanClient');

class DhanClient {
  constructor() {
    this.client = axios.create({
      baseURL: config.dhan.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'access-token': config.dhan.accessToken,
        'client-id': config.dhan.clientId
      }
    });

    this.client.interceptors.response.use(
      response => response,
      error => {
        logger.error('Dhan API Error', { 
          status: error.response?.status, 
          data: error.response?.data,
          url: error.config?.url 
        });
        return Promise.reject(error);
      }
    );
  }

  // ============ READ OPERATIONS ============

  async getFundLimits() {
    const res = await this.client.get('/fundlimit');
    return res.data;
  }

  async getHoldings() {
    const res = await this.client.get('/holdings');
    return res.data;
  }

  async getPositions() {
    const res = await this.client.get('/positions');
    return res.data;
  }

  async getOrders() {
    const res = await this.client.get('/orders');
    return res.data;
  }

  async getOrderById(orderId) {
    const res = await this.client.get(`/orders/${orderId}`);
    return res.data;
  }

  async getProfile() {
    const res = await this.client.get('/user/profile');
    return res.data;
  }

  async getIPWhitelist() {
    const res = await this.client.get('/ip');
    return res.data;
  }

  // ============ MARKET DATA ============

  async getQuote(securityId, exchangeSegment) {
    const res = await this.client.get('/marketfeed/quote', {
      params: { securityId, exchangeSegment }
    });
    return res.data;
  }

  async getLTP(securityId, exchangeSegment) {
    const res = await this.client.get('/marketfeed/ltp', {
      params: { securityId, exchangeSegment }
    });
    return res.data;
  }

  async getOptionChain(underlyingSecurityId, exchangeSegment) {
    const res = await this.client.get('/optionchain', {
      params: { underlyingSecurityId, exchangeSegment }
    });
    return res.data;
  }

  async fetchSecurityList(type = 'compact') {
    const res = await this.client.get('/securities', {
      params: { type },
      responseType: 'stream'
    });
    return res.data;
  }

  // ============ ORDER OPERATIONS ============

  async placeOrder(order) {
    const payload = {
      dhanClientId: config.dhan.clientId,
      correlationId: order.correlationId || `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      ...order
    };

    const res = await this.client.post('/orders', payload);
    return res.data;
  }

  async modifyOrder(orderId, modifications) {
    const res = await this.client.put(`/orders/${orderId}`, modifications);
    return res.data;
  }

  async cancelOrder(orderId) {
    const res = await this.client.delete(`/orders/${orderId}`);
    return res.data;
  }

  // ============ HELPER METHODS ============

  buildEquityOrder({ symbol, securityId, side, quantity, price, orderType = 'LIMIT', productType = 'CNC', triggerPrice = 0 }) {
    const secId = securityId ? securityId.toString() : (symbol || 'GOLDBEES');
    return {
      securityId: secId,
      symbol: symbol || secId,
      exchangeSegment: 'NSE_EQ',
      transactionType: side.toUpperCase(),
      quantity,
      orderType,
      productType,
      price: typeof price === 'number' ? price.toFixed(2) : price,
      triggerPrice: typeof triggerPrice === 'number' ? triggerPrice.toFixed(2) : triggerPrice,
      disclosedQuantity: 0,
      afterMarketOrder: false,
      validity: 'DAY'
    };
  }

  buildFNOOrder({ securityId, exchangeSegment, side, quantity, price, orderType = 'LIMIT', productType = 'INTRADAY', triggerPrice = 0 }) {
    return {
      securityId: securityId.toString(),
      exchangeSegment,
      transactionType: side.toUpperCase(),
      quantity,
      orderType,
      productType,
      price: price.toFixed(2),
      triggerPrice: triggerPrice.toFixed(2),
      disclosedQuantity: 0,
      afterMarketOrder: false,
      validity: 'DAY'
    };
  }

  // ============ FOREVER GTT & CORPORATE ACTION SENTINEL ============

  /**
   * Dhan Forever GTT Expiry Sentinel:
   * Inspects active GTT trigger validity and renews orders approaching 365-day expiry
   */
  async checkAndRenewExpiringGTTs(activeGTTOrders = []) {
    const now = Date.now();
    const renewed = [];
    for (const gtt of activeGTTOrders) {
      const createdDate = new Date(gtt.createdAt || Date.now()).getTime();
      const ageDays = (now - createdDate) / (1000 * 3600 * 24);
      
      // If GTT is > 300 days old (approaching 365-day Dhan expiry), automatically cancel & recreate
      if (ageDays >= 300) {
        logger.warn(`🔄 [Dhan GTT Sentinel] GTT order ${gtt.orderId} for ${gtt.symbol} is ${ageDays.toFixed(0)} days old. Auto-renewing trigger.`);
        try {
          await this.cancelOrder(gtt.orderId);
          const newOrder = await this.placeOrder(gtt.originalOrderParams);
          renewed.push({ oldId: gtt.orderId, newId: newOrder.orderId, symbol: gtt.symbol });
        } catch (err) {
          logger.error(`❌ [Dhan GTT Sentinel] Failed to renew GTT for ${gtt.symbol}: ${err.message}`);
        }
      }
    }
    return renewed;
  }

  /**
   * Corporate Action Price Adjustment (Stock Splits, Bonuses, Capital Reductions)
   * Adjusts target and stop-loss price levels when ratio changes
   */
  adjustForCorporateAction(position, splitRatio = 1) {
    if (splitRatio === 1 || !position) return position;
    
    const adjustedEntry = position.entryPrice / splitRatio;
    const adjustedStopLoss = (position.stopLoss || position.entryPrice * 0.95) / splitRatio;
    const adjustedTakeProfit = (position.takeProfit || position.entryPrice * 1.05) / splitRatio;
    const adjustedQty = position.quantity * splitRatio;

    logger.info(`📢 [Corporate Action Sentinel] Adjusted ${position.symbol} for ${splitRatio}:1 Split. New SL: ₹${adjustedStopLoss.toFixed(2)} | TP: ₹${adjustedTakeProfit.toFixed(2)} | Qty: ${adjustedQty}`);

    return {
      ...position,
      entryPrice: parseFloat(adjustedEntry.toFixed(2)),
      stopLoss: parseFloat(adjustedStopLoss.toFixed(2)),
      takeProfit: parseFloat(adjustedTakeProfit.toFixed(2)),
      quantity: adjustedQty
    };
  }

  // ============ PAPER TRADING SIMULATION ============

  async simulateOrder(order) {
    // For paper trading - simulate order execution
    logger.info('Paper trading: Simulating order', order);
    
    // Get current price for simulation
    let currentPrice = order.price;
    
    return {
      orderId: `paper_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      orderStatus: 'COMPLETE',
      averagePrice: currentPrice,
      filledQuantity: order.quantity,
      pendingQuantity: 0,
      omsErrorDescription: 'Paper trade simulated'
    };
  }
}

module.exports = new DhanClient();