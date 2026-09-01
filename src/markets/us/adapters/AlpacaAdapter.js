const BaseBrokerAdapter = require('../../../core/contracts/BaseBrokerAdapter');
const axios = require('axios');

class AlpacaAdapter extends BaseBrokerAdapter {
  constructor() {
    super('Alpaca');
    this.keyId = process.env.ALPACA_API_KEY || '';
    this.secretKey = process.env.ALPACA_SECRET_KEY || '';
    this.paper = process.env.ALPACA_PAPER !== 'false';
    this.baseUrl = this.paper 
      ? 'https://paper-api.alpaca.markets/v2' 
      : 'https://api.alpaca.markets/v2';
    
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey,
        'Content-Type': 'application/json'
      }
    });
  }

  hasValidCredentials() {
    return Boolean(this.keyId && this.secretKey && !this.keyId.includes('your_'));
  }

  async initialize() {
    return true;
  }

  async getFunds() {
    if (!this.hasValidCredentials()) {
      return {
        totalCapital: 100000,
        availableCash: 100000,
        availableMargin: 200000 // 2x standard US margin
      };
    }

    try {
      const res = await this.client.get('/account');
      const data = res.data;
      return {
        totalCapital: parseFloat(data.portfolio_value || data.equity || 100000),
        availableCash: parseFloat(data.cash || 100000),
        availableMargin: parseFloat(data.buying_power || 200000)
      };
    } catch (err) {
      return {
        totalCapital: 100000,
        availableCash: 100000,
        availableMargin: 200000
      };
    }
  }

  async getPositions() {
    if (!this.hasValidCredentials()) {
      return [];
    }

    try {
      const res = await this.client.get('/positions');
      return res.data.map(p => ({
        symbol: p.symbol,
        side: parseFloat(p.qty) >= 0 ? 'LONG' : 'SHORT',
        quantity: Math.abs(parseFloat(p.qty)),
        avgPrice: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        unrealizedPnL: parseFloat(p.unrealized_pl)
      }));
    } catch (err) {
      return [];
    }
  }

  async placeOrder(order) {
    if (!this.hasValidCredentials()) {
      // In-memory / simulation mode for Alpaca Paper
      const fillPrice = parseFloat(order.price) || 100;
      const orderId = `alpaca_paper_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      return {
        success: true,
        orderId,
        status: 'filled',
        filledQuantity: order.quantity,
        averagePrice: fillPrice,
        omsErrorDescription: 'Simulated Alpaca paper execution'
      };
    }

    try {
      const res = await this.client.post('/orders', {
        symbol: order.symbol,
        qty: order.quantity.toString(),
        side: order.transactionType?.toLowerCase() || (order.direction === 'LONG' ? 'buy' : 'sell'),
        type: order.orderType?.toLowerCase() || 'limit',
        limit_price: order.price?.toString(),
        time_in_force: 'day'
      });
      return {
        success: true,
        orderId: res.data.id,
        status: res.data.status,
        filledQuantity: parseFloat(res.data.filled_qty || 0),
        averagePrice: parseFloat(res.data.filled_avg_price || order.price)
      };
    } catch (err) {
      return {
        success: false,
        error: err.response?.data?.message || err.message
      };
    }
  }

  async cancelOrder(orderId) {
    if (!this.hasValidCredentials()) return { success: true };
    try {
      await this.client.delete(`/orders/${orderId}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async modifyOrder(orderId, modifications) {
    if (!this.hasValidCredentials()) return { success: true };
    try {
      const res = await this.client.patch(`/orders/${orderId}`, modifications);
      return { success: true, ...res.data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async getOrderStatus(orderId) {
    if (!this.hasValidCredentials()) return { orderStatus: 'COMPLETE' };
    try {
      const res = await this.client.get(`/orders/${orderId}`);
      return res.data;
    } catch (err) {
      return { error: err.message };
    }
  }
}

module.exports = new AlpacaAdapter();
