/**
 * BaseDataProvider - Abstract Interface for Market Feeds & Historical Candles
 */
class BaseDataProvider {
  constructor(name) {
    this.name = name || 'BaseDataProvider';
  }

  async fetchCandles(symbol, interval = '5m', range = '1d') {
    throw new Error('fetchCandles() must be implemented');
  }

  async fetchQuote(symbol) {
    throw new Error('fetchQuote() must be implemented');
  }

  async fetchOptionChain(symbol) {
    return null; // Optional override per market
  }
}

module.exports = BaseDataProvider;
