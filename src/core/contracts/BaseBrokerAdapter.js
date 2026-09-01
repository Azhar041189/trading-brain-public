/**
 * BaseBrokerAdapter - Abstract Interface for Broker Integrations
 */
class BaseBrokerAdapter {
  constructor(name) {
    this.name = name || 'BaseBroker';
  }

  async initialize() {
    throw new Error('initialize() must be implemented');
  }

  async getFunds() {
    throw new Error('getFunds() must be implemented');
  }

  async getPositions() {
    throw new Error('getPositions() must be implemented');
  }

  async placeOrder(order) {
    throw new Error('placeOrder() must be implemented');
  }

  async cancelOrder(orderId) {
    throw new Error('cancelOrder() must be implemented');
  }

  async modifyOrder(orderId, modifications) {
    throw new Error('modifyOrder() must be implemented');
  }

  async getOrderStatus(orderId) {
    throw new Error('getOrderStatus() must be implemented');
  }
}

module.exports = BaseBrokerAdapter;
