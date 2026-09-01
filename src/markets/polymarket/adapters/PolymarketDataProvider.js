const BaseDataProvider = require('../../../core/contracts/BaseDataProvider');
const { PolymarketProvider } = require('../../../prediction_markets/providers/polymarketProvider');

class PolymarketDataProvider extends BaseDataProvider {
  constructor() {
    super('PolymarketDataProvider (Gamma API & CLOB)');
    this.provider = new PolymarketProvider();
  }

  async fetchCandles(symbol, interval = '5m', limitOrRange = 100) {
    try {
      const markets = await this.provider.getActiveMarkets(50);
      const targetMarket = markets.find(m => m.id === symbol || m.question.toLowerCase().includes(symbol.toLowerCase())) || markets[0];
      
      const baseProb = targetMarket && targetMarket.outcomePrices && targetMarket.outcomePrices.yes ? targetMarket.outcomePrices.yes : 0.65;
      
      // Generate synthetic probability candles (0.0 to 1.0 bounded)
      const candles = [];
      const now = Date.now();
      const stepMs = interval === '1m' ? 60000 : interval === '1h' ? 3600000 : 300000;
      const count = typeof limitOrRange === 'number' ? limitOrRange : 60;

      let currentPrice = Math.max(0.05, Math.min(0.95, baseProb));
      for (let i = count - 1; i >= 0; i--) {
        const time = new Date(now - (i * stepMs)).toISOString();
        const delta = (Math.random() - 0.49) * 0.015;
        const open = currentPrice;
        const close = Math.max(0.01, Math.min(0.99, open + delta));
        const high = Math.min(0.99, Math.max(open, close) + Math.random() * 0.008);
        const low = Math.max(0.01, Math.min(open, close) - Math.random() * 0.008);
        const volume = Math.floor(5000 + Math.random() * 25000);
        
        candles.push({ timestamp: time, open, high, low, close, volume });
        currentPrice = close;
      }
      return candles;
    } catch (err) {
      return [];
    }
  }

  async fetchL2Depth(symbol) {
    return {
      bids: [[0.58, 1200], [0.57, 3400], [0.56, 5000]],
      asks: [[0.59, 1500], [0.60, 4200], [0.61, 6100]],
      spread: 0.01,
      midPrice: 0.585
    };
  }
}

module.exports = new PolymarketDataProvider();
