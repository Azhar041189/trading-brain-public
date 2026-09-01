const BaseBrokerAdapter = require('../../../core/contracts/BaseBrokerAdapter');
const dhanClient = require('../../../tools/dhanClient');
const config = require('../../../config');

class DhanAdapter extends BaseBrokerAdapter {
  constructor() {
    super('DhanHQ');
    this.client = dhanClient;
  }

  async initialize() {
    const dhanAuthService = require('../../../core/dhanAuthService');
    await dhanAuthService.verifySession();
    return true;
  }

  async getFunds() {
    try {
      const funds = await this.client.getFundLimits();
      const balance = parseFloat(funds.availabelBalance || funds.data?.availabelBalance || 0);
      return {
        totalCapital: balance || config.trading.initialCapital,
        availableCash: balance || config.trading.initialCapital,
        availableMargin: (balance || config.trading.initialCapital) * 0.8
      };
    } catch (err) {
      return {
        totalCapital: config.trading.initialCapital,
        availableCash: config.trading.initialCapital,
        availableMargin: config.trading.initialCapital * 0.8
      };
    }
  }

  async getPositions() {
    try {
      const res = await this.client.getPositions();
      return res.data || [];
    } catch (err) {
      return [];
    }
  }

  async placeOrder(order) {
    if (config.trading.paperTrading) {
      return this.client.simulateOrder(order);
    }
    return this.client.placeOrder(order);
  }

  async cancelOrder(orderId) {
    return this.client.cancelOrder(orderId);
  }

  async modifyOrder(orderId, modifications) {
    return this.client.modifyOrder(orderId, modifications);
  }

  async getOrderStatus(orderId) {
    return this.client.getOrderById(orderId);
  }
}

module.exports = new DhanAdapter();
