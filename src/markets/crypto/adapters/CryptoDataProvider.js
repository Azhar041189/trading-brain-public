const BaseDataProvider = require('../../../core/contracts/BaseDataProvider');
const axios = require('axios');

class CryptoDataProvider extends BaseDataProvider {
  constructor() {
    super('CryptoDataProvider (Binance / CoinGecko)');
  }

  async fetchCandles(symbol, interval = '5m', limitOrRange = 100) {
    try {
      const cleanSymbol = symbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      // Map standard timeframe intervals to Binance klines
      const intervalMap = {
        '1m': '1m',
        '5m': '5m',
        '15m': '15m',
        '1h': '1h',
        '4h': '4h',
        '1d': '1d'
      };
      const binanceInterval = intervalMap[interval] || '5m';

      // Convert range string (e.g. '1d', '5d', '1mo', '1y') or numeric limit into Binance kline limit
      let klineLimit = 100;
      if (typeof limitOrRange === 'number') {
        klineLimit = limitOrRange;
      } else if (typeof limitOrRange === 'string') {
        if (binanceInterval === '1d') {
          klineLimit = limitOrRange === '1y' ? 365 : 100;
        } else if (binanceInterval === '1h') {
          klineLimit = limitOrRange === '1mo' ? 300 : 100;
        } else if (binanceInterval === '15m') {
          klineLimit = limitOrRange === '5d' ? 480 : 100;
        } else if (binanceInterval === '5m') {
          klineLimit = limitOrRange === '1d' ? 288 : 100;
        } else if (binanceInterval === '1m') {
          klineLimit = limitOrRange === '1d' ? 500 : 100;
        }
      }

      // 1. Direct Binance Global API
      const response = await axios.get('https://api.binance.com/api/v3/klines', {
        params: { symbol: cleanSymbol, interval: binanceInterval, limit: Math.min(1000, Math.max(30, klineLimit)) },
        timeout: 6000
      });

      if (Array.isArray(response.data) && response.data.length > 0) {
        return response.data.map(k => ({
          timestamp: new Date(k[0]).toISOString(),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5])
        }));
      }
      throw new Error('Empty Binance klines');
    } catch (err) {
      // 2. Fallback to Binance US endpoint
      try {
        const cleanSymbol = symbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        const binanceInterval = interval === '1d' ? '1d' : interval === '1h' ? '1h' : interval === '15m' ? '15m' : interval === '1m' ? '1m' : '5m';
        const resUs = await axios.get('https://api.binance.us/api/v3/klines', {
          params: { symbol: cleanSymbol, interval: binanceInterval, limit: 150 },
          timeout: 6000
        });
        if (Array.isArray(resUs.data) && resUs.data.length > 0) {
          return resUs.data.map(k => ({
            timestamp: new Date(k[0]).toISOString(),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5])
          }));
        }
      } catch (eUs) {}

      // 3. Fallback to Yahoo Finance for crypto (e.g. BTC-USD)
      return this.fetchYahooFallback(symbol, interval, limitOrRange);
    }
  }

  async fetchYahooFallback(symbol, interval, range = '1d') {
    try {
      const formatted = symbol.endsWith('USDT') 
        ? symbol.replace('USDT', '-USD') 
        : symbol;
      const yahooRange = (typeof range === 'string' && ['1d', '5d', '1mo', '1y', 'max'].includes(range)) ? range : (interval === '1d' ? '1y' : interval === '1h' ? '1mo' : '1d');
      const res = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${formatted}?interval=${interval}&range=${yahooRange}`,
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
    const candles = await this.fetchCandles(symbol, '5m', 2);
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

module.exports = new CryptoDataProvider();
