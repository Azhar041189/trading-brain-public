const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('RegimeClassifier');

/**
 * RegimeClassifier - Classifies real-time market state into institutional regimes:
 * 1. TRENDING_BULL (Prioritize Momentum & Trend Following)
 * 2. TRENDING_BEAR (Prioritize Short Trend Following)
 * 3. RANGING_CHOPPY (Prioritize Bollinger Band / Stoch Mean Reversion)
 * 4. HIGH_VOLATILITY_PANIC (Reduce sizing by 50%, widen stops)
 */
class RegimeClassifier {
  constructor() {
    this.currentRegimes = new Map(); // symbol -> regime object
    this.marketRegimes = new Map([
      ['CRYPTO', { regime: 'RANGING_CHOPPY', volatilityPct: '1.20', recommendedStrategy: 'MEAN_REVERSION', riskMultiplier: 1.0 }],
      ['IN', { regime: 'RANGING_CHOPPY', volatilityPct: '0.85', recommendedStrategy: 'MEAN_REVERSION', riskMultiplier: 1.0 }],
      ['US', { regime: 'RANGING_CHOPPY', volatilityPct: '0.90', recommendedStrategy: 'MEAN_REVERSION', riskMultiplier: 1.0 }],
      ['FOREX', { regime: 'RANGING_CHOPPY', volatilityPct: '0.45', recommendedStrategy: 'MEAN_REVERSION', riskMultiplier: 1.0 }],
      ['FUTURES', { regime: 'RANGING_CHOPPY', volatilityPct: '1.10', recommendedStrategy: 'MEAN_REVERSION', riskMultiplier: 1.0 }]
    ]);
    this.benchmarkMap = {
      'CRYPTO': 'BTCUSDT',
      'IN': 'NIFTY',
      'US': 'SPY',
      'FOREX': 'EURUSD=X',
      'FUTURES': 'ES=F'
    };
  }

  /**
   * Classify market regime from candle history
   * @param {string} symbol - Ticker
   * @param {Array} candles - OHLCV array
   * @param {string} [marketKey] - Optional market identifier (e.g. IN, CRYPTO, US)
   */
  classify(symbol, candles = [], marketKey = null) {
    // If no new candles provided, return cached regime if available
    if ((!candles || candles.length < 20) && typeof symbol === 'string' && this.currentRegimes.has(symbol)) {
      return this.currentRegimes.get(symbol);
    }

    if (!candles || candles.length < 20) {
      const fallback = {
        symbol: typeof symbol === 'string' ? symbol : 'MARKET',
        regime: 'REGIME_UNKNOWN',
        volatilityPct: '0.00',
        recommendedStrategy: 'FAIL_CLOSED_NO_NEW_RISK',
        confidence: '0%',
        riskMultiplier: 0.0,
        timestamp: new Date().toISOString()
      };
      if (marketKey) this.marketRegimes.set(marketKey.toUpperCase(), fallback);
      return fallback;
    }

    const closes = candles.map(c => c.close);
    const n = closes.length;
    const currentPrice = closes[n - 1];

    // Compute 20-period SMA
    const sma20 = closes.slice(n - 20).reduce((a, b) => a + b, 0) / 20;

    // Compute standard deviation (volatility)
    const variance = closes.slice(n - 20).reduce((acc, val) => acc + Math.pow(val - sma20, 2), 0) / 20;
    const stdDev = Math.sqrt(variance);
    const volatilityPct = (stdDev / sma20) * 100;

    // Compute trend slope (first vs last of window)
    const windowStart = closes[n - 20];
    const trendReturn = (currentPrice - windowStart) / windowStart;

    // Detect Chop: Count how many times price crossed the 20-period SMA in the last 10 bars
    let crosses = 0;
    for (let i = n - 10; i < n; i++) {
      if (i > 0 && ((closes[i] > sma20) !== (closes[i - 1] > sma20))) {
        crosses++;
      }
    }
    const isExtremeChoppy = crosses >= 5 && Math.abs(trendReturn) < 0.002;

    let regime = 'RANGING_CHOPPY';
    let recommendedStrategy = 'MEAN_REVERSION';
    let riskMultiplier = 1.0;

    if (trendReturn > 0.002 && currentPrice > sma20) {
      regime = 'TRENDING_BULL';
      recommendedStrategy = 'MOMENTUM_BREAKOUT';
    } else if (trendReturn < -0.002 && currentPrice < sma20) {
      regime = 'TRENDING_BEAR';
      recommendedStrategy = 'MOMENTUM_SHORT';
    } else if (isExtremeChoppy) {
      regime = 'RANGING_CHOPPY';
      recommendedStrategy = 'MEAN_REVERSION';
    } else if (volatilityPct > 3.5) {
      regime = 'HIGH_VOLATILITY_PANIC';
      recommendedStrategy = 'DEFENSIVE_TIGHT_STOPS';
      riskMultiplier = 0.50; // Cut size in half
    } else {
      regime = 'RANGING_CHOPPY';
      recommendedStrategy = 'MEAN_REVERSION';
    }

    const result = {
      symbol: typeof symbol === 'string' ? symbol : 'MARKET',
      regime,
      volatilityPct: volatilityPct.toFixed(2),
      recommendedStrategy,
      riskMultiplier,
      market: marketKey ? marketKey.toUpperCase() : null,
      timestamp: new Date().toISOString()
    };

    if (typeof symbol === 'string') {
      this.currentRegimes.set(symbol, result);
    }
    if (marketKey) {
      this.marketRegimes.set(marketKey.toUpperCase(), result);
    }
    this.lastMarketRegime = result;
    return result;
  }

  /**
   * Get regime specifically for a given market (IN, CRYPTO, US, FOREX, FUTURES)
   */
  getRegimeForMarket(marketKey) {
    if (!marketKey) return this.getCurrentRegime();
    const key = marketKey.toUpperCase();
    if (this.marketRegimes.has(key)) {
      return this.marketRegimes.get(key).regime;
    }
    return this.getCurrentRegime();
  }

  /**
   * Get all venue regimes in a clean map
   */
  getAllRegimes() {
    const result = {};
    for (const [m, data] of this.marketRegimes.entries()) {
      result[m] = data.regime;
    }
    return result;
  }

  getCurrentRegime(symbol = 'BTCUSDT') {
    if (this.currentRegimes.has(symbol)) {
      return this.currentRegimes.get(symbol).regime;
    }
    if (this.lastMarketRegime && this.lastMarketRegime.regime) {
      return this.lastMarketRegime.regime;
    }
    return 'RANGING_CHOPPY';
  }
}

module.exports = new RegimeClassifier();
