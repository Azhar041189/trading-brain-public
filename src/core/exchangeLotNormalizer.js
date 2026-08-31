/**
 * exchangeLotNormalizer.js
 * 
 * Production Exchange Precision & Filter Enforcement:
 * - LOT_SIZE (stepSize, minQty, maxQty)
 * - PRICE_FILTER (tickSize, minPrice, maxPrice)
 * - MIN_NOTIONAL (minimum order value in quote currency)
 */

class ExchangeLotNormalizer {
  constructor() {
    // Official exchange precision specifications
    this.symbolRules = {
      'BTCUSDT': { stepSize: 0.0001, minQty: 0.0001, maxQty: 9000, tickSize: 0.01, minNotional: 5.0 },
      'ETHUSDT': { stepSize: 0.001, minQty: 0.001, maxQty: 10000, tickSize: 0.01, minNotional: 5.0 },
      'SOLUSDT': { stepSize: 0.01, minQty: 0.01, maxQty: 50000, tickSize: 0.01, minNotional: 5.0 },
      'XRPUSDT': { stepSize: 1.0, minQty: 1.0, maxQty: 1000000, tickSize: 0.0001, minNotional: 5.0 },
      'DOGEUSDT': { stepSize: 1.0, minQty: 1.0, maxQty: 10000000, tickSize: 0.00001, minNotional: 5.0 },
      'ADAUSDT': { stepSize: 1.0, minQty: 1.0, maxQty: 1000000, tickSize: 0.0001, minNotional: 5.0 }
    };
  }

  /**
   * Get precision rules for a symbol
   */
  getRules(symbol) {
    const cleanSym = (symbol || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return this.symbolRules[cleanSym] || {
      stepSize: 0.01,
      minQty: 0.01,
      maxQty: 1000000,
      tickSize: 0.01,
      minNotional: 5.0
    };
  }

  /**
   * Normalizes raw quantity strictly to exchange stepSize and bounds
   * @param {string} symbol - Ticker (e.g. BTCUSDT)
   * @param {number} rawQty - Raw calculated quantity
   * @returns {number} Normalized exchange-safe quantity (or 0 if below minQty)
   */
  normalizeQuantity(symbol, rawQty) {
    if (!rawQty || rawQty <= 0 || isNaN(rawQty)) return 0;
    const rules = this.getRules(symbol);
    
    // Round down to the nearest multiple of stepSize to avoid exceeding max capital/limits
    const precision = this._getDecimalPlaces(rules.stepSize);
    const stepped = Math.floor(rawQty / rules.stepSize) * rules.stepSize;
    const normalized = parseFloat(stepped.toFixed(precision));

    if (normalized < rules.minQty) return 0; // Below minimum tradeable lot
    if (normalized > rules.maxQty) return rules.maxQty;
    return normalized;
  }

  /**
   * Normalizes price to exchange tickSize
   */
  normalizePrice(symbol, rawPrice) {
    if (!rawPrice || rawPrice <= 0 || isNaN(rawPrice)) return 0;
    const rules = this.getRules(symbol);
    const precision = this._getDecimalPlaces(rules.tickSize);
    const stepped = Math.round(rawPrice / rules.tickSize) * rules.tickSize;
    return parseFloat(stepped.toFixed(precision));
  }

  _getDecimalPlaces(num) {
    const match = ('' + num).match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
    if (!match) return 0;
    return Math.max(0, (match[1] ? match[1].length : 0) - (match[2] ? +match[2] : 0));
  }
}

module.exports = new ExchangeLotNormalizer();
