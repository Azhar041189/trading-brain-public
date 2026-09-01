const BaseDataProvider = require('../../../core/contracts/BaseDataProvider');
const axios = require('axios');

class ForexDataProvider extends BaseDataProvider {
  constructor() {
    super('ForexDataProvider (Yahoo FX / OANDA)');
  }

  async fetchCandles(symbol, interval = '5m', range = '1d') {
    try {
      const ticker = symbol.endsWith('=X') ? symbol : `${symbol}=X`;
      const res = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }
      );
      const result = res.data?.chart?.result?.[0];
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
    } catch (e) {
      return [];
    }
  }

  async fetchQuote(symbol) {
    const candles = await this.fetchCandles(symbol, '5m', '1d');
    if (candles.length === 0) return null;
    const last = candles[candles.length - 1];
    return { symbol, price: last.close, volume: last.volume };
  }
}

module.exports = new ForexDataProvider();
