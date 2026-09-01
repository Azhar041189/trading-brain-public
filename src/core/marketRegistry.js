const path = require('path');
const fs = require('fs');

/**
 * MarketRegistry - Dynamic registry and factory for all markets (IN, US, Crypto, etc.)
 */
class MarketRegistry {
  constructor() {
    this.markets = new Map();
    this.registerBuiltInMarkets();
  }

  registerBuiltInMarkets() {
    const marketsDir = path.join(__dirname, '../markets');
    if (fs.existsSync(marketsDir)) {
      const entries = fs.readdirSync(marketsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const marketKey = entry.name.toUpperCase();
          const indexPath = path.join(marketsDir, entry.name, 'index.js');
          if (fs.existsSync(indexPath)) {
            try {
              const marketModule = require(indexPath);
              this.markets.set(marketKey, marketModule);
            } catch (err) {
              console.warn(`Could not load market module ${entry.name}:`, err.message);
            }
          }
        }
      }
    }
  }

  getMarket(marketKey = 'IN') {
    const key = marketKey.toUpperCase();
    if (!this.markets.has(key)) {
      // Try reloading or throw
      const fallbackPath = path.join(__dirname, `../markets/${key.toLowerCase()}/index.js`);
      if (fs.existsSync(fallbackPath)) {
        const mod = require(fallbackPath);
        this.markets.set(key, mod);
        return mod;
      }
      throw new Error(`Market '${key}' not found. Available markets: ${Array.from(this.markets.keys()).join(', ')}`);
    }
    return this.markets.get(key);
  }

  listMarkets() {
    return Array.from(this.markets.keys());
  }
}

module.exports = new MarketRegistry();
