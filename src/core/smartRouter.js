const marketRegistry = require('./marketRegistry');
const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('SmartRouter');

/**
 * SmartRouter - Intelligent Smart Order Router
 * Automatically determines optimal broker and venue based on asset class, liquidity, and active market.
 */
class SmartRouter {
  constructor() {
    this.routeRules = {
      'CRYPTO': 'CRYPTO',
      'BINANCE': 'CRYPTO',
      'US_EQ': 'US',
      'NASDAQ': 'US',
      'NYSE': 'US',
      'NSE_EQ': 'IN',
      'NSE_FNO': 'IN',
      'BSE': 'IN',
      'FOREX': 'FOREX',
      'FUTURES': 'FUTURES'
    };
  }

  resolveMarketForSignal(signal) {
    if (signal.market) return signal.market.toUpperCase();
    if (signal.segment && this.routeRules[signal.segment]) {
      return this.routeRules[signal.segment];
    }
    if (signal.exchangeSegment && this.routeRules[signal.exchangeSegment]) {
      return this.routeRules[signal.exchangeSegment];
    }
    
    // Heuristic based on symbol
    const sym = signal.symbol.toUpperCase();
    if (sym.endsWith('USDT') || sym.endsWith('BTC') || sym.endsWith('ETH')) return 'CRYPTO';
    if (sym.endsWith('=X')) return 'FOREX';
    if (sym.endsWith('=F')) return 'FUTURES';
    if (['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY', 'QQQ', 'AMZN', 'META'].includes(sym)) return 'US';
    
    return 'IN';
  }

  async routeOrder(order, signal = {}) {
    const targetMarketKey = this.resolveMarketForSignal(signal);
    const market = marketRegistry.getMarket(targetMarketKey);

    logger.info(`Routing order [${order.symbol}] to broker: ${market.broker.name} (${targetMarketKey})`);
    return await market.broker.placeOrder(order);
  }
}

module.exports = new SmartRouter();
