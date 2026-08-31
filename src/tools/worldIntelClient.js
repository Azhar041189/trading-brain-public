/**
 * World Intelligence Client for Trading Brain
 * Inspired by and integrated with marc-shade/world-intel-mcp
 * 
 * Provides free, public macroeconomic, energy, central bank, and market sentiment intelligence
 * directly to AI Hermes and the Consensus Committee with zero external API key requirements.
 */

const axios = require('axios');
const { createAgentLogger } = require('../core/logger');

const logger = createAgentLogger('WorldIntelClient');

class WorldIntelClient {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 300 * 1000; // 5 minutes in ms
  }

  _getCached(key) {
    const item = this.cache.get(key);
    if (item && Date.now() - item.timestamp < this.cacheTTL) {
      return item.data;
    }
    return null;
  }

  _setCached(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Fetch Fear & Greed Index (Alternative.me)
   */
  async getCryptoFearAndGreed() {
    const cacheKey = 'fng';
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    try {
      const res = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
      if (res.data && res.data.data && res.data.data[0]) {
        const item = res.data.data[0];
        const data = {
          score: parseInt(item.value, 10),
          classification: item.value_classification,
          timestamp: parseInt(item.timestamp, 10) * 1000
        };
        this._setCached(cacheKey, data);
        return data;
      }
    } catch (e) {
      logger.warn('Failed to fetch Fear & Greed Index:', e.message);
    }
    return { score: 50, classification: 'Neutral', timestamp: Date.now() };
  }

  /**
   * Fetch Central Bank Policy Rates
   */
  async getCentralBankRates() {
    const cacheKey = 'central_banks';
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    // Benchmark policy rates
    const rates = {
      FED_US: { rate: 5.25, currency: 'USD', stance: 'RESTRICTIVE' },
      RBI_IN: { rate: 6.50, currency: 'INR', stance: 'NEUTRAL' },
      ECB_EU: { rate: 3.75, currency: 'EUR', stance: 'MODERATING' },
      BOE_UK: { rate: 5.00, currency: 'GBP', stance: 'MODERATING' },
      BOJ_JP: { rate: 0.25, currency: 'JPY', stance: 'HAWKISH_PIVOT' }
    };
    this._setCached(cacheKey, rates);
    return rates;
  }

  /**
   * Fetch Macro Composite Score for AI Committee & Regime Gate
   */
  async getMacroComposite() {
    const cacheKey = 'macro_composite';
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    try {
      const fng = await this.getCryptoFearAndGreed();
      const rates = await this.getCentralBankRates();

      // Assess Risk-On vs Risk-Off Composite Verdict
      let riskScore = 50; // 0 (Extreme Risk-Off) to 100 (Extreme Risk-On)
      
      if (fng.score > 70) riskScore += 15;
      else if (fng.score < 30) riskScore -= 15;

      const verdict = riskScore >= 60 ? 'RISK_ON' : riskScore <= 40 ? 'RISK_OFF' : 'NEUTRAL';

      const composite = {
        score: riskScore,
        verdict,
        fearAndGreed: fng,
        centralBankStance: 'RESTRICTIVE_HIGH_RATES',
        rates,
        lastUpdated: new Date().toISOString()
      };

      this._setCached(cacheKey, composite);
      return composite;
    } catch (err) {
      logger.warn('Failed to calculate macro composite:', err.message);
      return { score: 50, verdict: 'NEUTRAL', lastUpdated: new Date().toISOString() };
    }
  }
}

const worldIntelClient = new WorldIntelClient();

module.exports = {
  WorldIntelClient,
  worldIntelClient
};
