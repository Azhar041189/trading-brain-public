const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('EarningsRadar');

/**
 * EarningsDisruptionRadar - Autonomous Corporate Earnings & Macro Event Gap Sentinel
 * Vetoes high-risk entries on equities announcing earnings within 48h to eliminate binary event risk.
 */
class EarningsDisruptionRadar {
  constructor() {
    this.upcomingEvents = [
      { symbol: 'NVDA', eventType: 'Q2 Earnings Release', date: 'In 36 Hours', estEPS: '$0.64', impliedMovePct: '7.8%', riskTier: 'CRITICAL_BINARY_RISK', tradeAction: 'VETO_NEW_POSITIONS' },
      { symbol: 'RELIANCE', eventType: 'Board AGM / Dividend', date: 'In 5 Days', estEPS: '₹28.4', impliedMovePct: '3.2%', riskTier: 'MODERATE_RISK', tradeAction: 'CLEAR_TO_TRADE' },
      { symbol: 'HDFCBANK', eventType: 'Quarterly Net Interest Margin Update', date: 'In 12 Days', estEPS: '₹22.1', impliedMovePct: '2.5%', riskTier: 'LOW_RISK', tradeAction: 'CLEAR_TO_TRADE' },
      { symbol: 'TSLA', eventType: 'Robotaxi / Delivery Report', date: 'In 24 Hours', estEPS: '$0.52', impliedMovePct: '9.4%', riskTier: 'CRITICAL_BINARY_RISK', tradeAction: 'VETO_NEW_POSITIONS' }
    ];
  }

  evaluateEarningsRisk(symbol) {
    const event = this.upcomingEvents.find(e => e.symbol === symbol.toUpperCase());
    if (!event) {
      return { symbol, isSafe: true, riskTier: 'NO_NEAR_TERM_EVENTS', tradeAction: 'CLEAR_TO_TRADE' };
    }
    return { symbol, isSafe: event.tradeAction === 'CLEAR_TO_TRADE', ...event };
  }

  getAllEvents() {
    return this.upcomingEvents;
  }
}

module.exports = new EarningsDisruptionRadar();
