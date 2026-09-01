const BaseBrokerAdapter = require('../../../core/contracts/BaseBrokerAdapter');

class OandaAdapter extends BaseBrokerAdapter {
  constructor() {
    super('OANDA / FX Broker');
  }

  async initialize() { return true; }
  async getFunds() {
    return { totalCapital: 100000, availableCash: 100000, availableMargin: 200000 };
  }
  async getPositions() { return []; }
  async placeOrder(order) {
    return {
      success: true,
      orderId: `fx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      status: 'FILLED',
      filledQuantity: order.quantity,
      averagePrice: order.price,
      omsErrorDescription: 'FX Paper trade executed'
    };
  }
  async cancelOrder(orderId) { return { success: true, orderId }; }
  async modifyOrder(orderId, mod) { return { success: true, orderId, ...mod }; }
  async getOrderStatus(orderId) { return { orderStatus: 'FILLED' }; }
}

module.exports = new OandaAdapter();
