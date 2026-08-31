const BaseBrokerAdapter = require('../../../core/contracts/BaseBrokerAdapter');
const { PaperPredictionClobSimulator } = require('../../../prediction_markets/simulation/paperPredictionClobSimulator');
const { PredictionComplianceGate } = require('../../../prediction_markets/compliance/complianceGate');

class PolymarketAdapter extends BaseBrokerAdapter {
  constructor() {
    super('Polymarket_CLOB_Sandbox');
    this.complianceGate = new PredictionComplianceGate();
    this.simulator = new PaperPredictionClobSimulator({
      bankrollUSD: 10000,
      venueLatencyMs: 15,
      cancelLatencyMs: 25
    });
  }

  hasValidCredentials() {
    // Zero-signing invariant: only paper sandbox authorized
    return true;
  }

  async initialize() {
    this.complianceGate.validateStartupEnvironment();
    return true;
  }

  async getFunds() {
    return {
      totalCapital: this.simulator.state.bankrollUSD,
      availableCash: this.simulator.state.bankrollUSD - this.simulator.state.activeExposureUSD,
      availableMargin: this.simulator.state.bankrollUSD,
      currency: 'pUSD'
    };
  }

  async getPositions() {
    return Array.from(this.simulator.state.positions.values());
  }

  async placeOrder(order) {
    // Strictly routed to paper simulator
    const simOrder = {
      orderId: `pm_order_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      marketId: order.symbol || order.marketId || 'FED_DEC_RATE_CUT_2026',
      side: order.side || 'BUY',
      outcome: order.outcome || 'YES',
      type: order.type || 'LIMIT',
      price: parseFloat(order.price) || 0.50,
      shares: parseFloat(order.quantity) || 100,
      time: Date.now()
    };

    const result = this.simulator.simulateTakerOrder(simOrder);
    return {
      success: result.status === 'FILLED' || result.status === 'PARTIALLY_FILLED',
      orderId: simOrder.orderId,
      status: result.status,
      filledQuantity: result.filledShares,
      averagePrice: result.avgPrice,
      feeUSD: result.feeUSD,
      omsErrorDescription: result.rejectionReason || 'Polymarket sandbox execution'
    };
  }

  async cancelOrder(orderId) {
    return { success: true, orderId };
  }

  async modifyOrder(orderId, modifications) {
    return { success: true, orderId, ...modifications };
  }

  async getOrderStatus(orderId) {
    return { orderStatus: 'FILLED' };
  }
}

module.exports = new PolymarketAdapter();
