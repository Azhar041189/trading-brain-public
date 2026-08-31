const BaseDataProvider = require('../../../core/contracts/BaseDataProvider');
const axios = require('axios');

class YahooUSProvider extends BaseDataProvider {
  constructor() {
    super('YahooUSProvider');
  }

  async fetchCandles(symbol, interval = '5m', range = '1d') {
    try {
      const ticker = symbol.toUpperCase();
      const response = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`,
        { 
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 10000 
        }
      );
      
      const result = response.data?.chart?.result?.[0];
      if (!result || !result.timestamp) return [];
      
      const timestamps = result.timestamp;
      const quotes = result.indicators.quote[0];
      
      return timestamps.map((ts, i) => ({
        timestamp: new Date(ts * 1000).toISOString(),
        open: quotes.open[i],
        high: quotes.high[i],
        low: quotes.low[i],
        close: quotes.close[i],
        volume: quotes.volume[i] || 0
      })).filter(c => c.close !== null && !isNaN(c.close));
    } catch (err) {
      return [];
    }
  }

  async fetchQuote(symbol) {
    const candles = await this.fetchCandles(symbol, '1d', '5d');
    if (candles.length === 0) return null;
    const last = candles[candles.length - 1];
    const prev = candles.length > 1 ? candles[candles.length - 2] : last;
    return {
      symbol,
      price: last.close,
      change: last.close - prev.close,
      changePct: prev.close ? (((last.close - prev.close) / prev.close) * 100).toFixed(2) : '0',
      volume: last.volume
    };
  }
}

module.exports = new YahooUSProvider();
