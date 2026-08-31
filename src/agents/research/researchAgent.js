const { createAgentLogger } = require('../../core/logger');
const macroAlphaSentinel = require('../../core/macroAlphaSentinel');
const socialAlphaSentinel = require('../../core/socialAlphaSentinel');
const darkPoolWhaleHunter = require('../../core/darkPoolWhaleHunter');
const database = require('../../core/database');

const logger = createAgentLogger('ResearchAgent');

/**
 * Autonomous Research Agent
 * Aggregates multi-source market intelligence (macro, sentiment, dark pool, technical catalysts)
 * Output: Standardized MarketIntelligenceReport (Does NOT place orders)
 */
class ResearchAgent {
  constructor() {
    this.intelligenceFeed = [];
    this.maxFeedSize = 100;
  }

  /**
   * Run comprehensive intelligence scan across macro, news, dark pool and on-chain
   */
  async conductResearch(symbol = 'BTCUSDT', market = 'CRYPTO') {
    logger.info(`🔍 [Research Agent] Conducting deep intelligence scan for ${symbol} [${market}]`);
    const timestamp = new Date().toISOString();

    try {
      // 1. Ingest Macro Data
      let macroData = { status: 'UNAVAILABLE', rateBias: 'UNKNOWN', inflationTrend: 'UNKNOWN', yield10Y: null };
      try {
        if (macroAlphaSentinel && typeof macroAlphaSentinel.getLatestMacroPulse === 'function') {
          macroData = await macroAlphaSentinel.getLatestMacroPulse();
        }
      } catch (e) {
        logger.warn('Macro sentinel query failed', { error: e.message });
      }

      // 2. Ingest Sentiment & Breaking Catalysts
      let sentimentData = { score: null, sentiment: 'UNAVAILABLE', catalystCount: 0 };
      try {
        if (socialAlphaSentinel && typeof socialAlphaSentinel.getSocialSentiment === 'function') {
          sentimentData = await socialAlphaSentinel.getSocialSentiment(symbol);
        }
      } catch (e) {
        logger.warn('Sentiment sentinel query failed', { error: e.message });
      }

      // 3. Ingest Dark Pool & Whale Flow Toxicity (VPIN)
      let darkPoolData = { vpin: null, toxicOrderFlow: null, whaleImbalance: 'UNAVAILABLE' };
      try {
        if (darkPoolWhaleHunter && typeof darkPoolWhaleHunter.getMetrics === 'function') {
          darkPoolData = await darkPoolWhaleHunter.getMetrics(symbol);
        }
      } catch (e) {
        logger.warn('Dark pool hunter query failed', { error: e.message });
      }

      // 4. Construct Standardized MarketIntelligenceReport
      const isDataAvailable = macroData.status !== 'UNAVAILABLE' || sentimentData.score !== null || darkPoolData.vpin !== null;

      const report = {
        id: `INTEL_${symbol}_${Date.now()}`,
        symbol,
        market,
        timestamp,
        dataStatus: isDataAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
        macro: {
          yield10Y: macroData.yield10Y !== undefined ? macroData.yield10Y : null,
          bias: macroData.rateBias || 'UNKNOWN',
          macroRegime: macroData.regime || 'UNKNOWN'
        },
        sentiment: {
          score: sentimentData.score !== undefined ? sentimentData.score : null,
          classification: sentimentData.sentiment || 'UNKNOWN',
          volumeShock: Boolean(sentimentData.volumeShock)
        },
        microstructure: {
          vpin: darkPoolData.vpin !== undefined ? darkPoolData.vpin : null,
          toxicFlow: darkPoolData.toxicOrderFlow !== null ? Boolean(darkPoolData.toxicOrderFlow) : null,
          whaleFlow: darkPoolData.whaleImbalance || 'UNKNOWN'
        },
        summary: `DataStatus: ${isDataAvailable ? 'AVAILABLE' : 'UNAVAILABLE'} | Macro: ${macroData.rateBias || 'UNKNOWN'} | Sentiment: ${sentimentData.sentiment || 'UNKNOWN'} | Microstructure: ${darkPoolData.whaleImbalance || 'UNKNOWN'}`
      };

      this.intelligenceFeed.unshift(report);
      if (this.intelligenceFeed.length > this.maxFeedSize) {
        this.intelligenceFeed.pop();
      }

      // Optionally save to SQL database if available
      if (database && typeof database.isUsingDatabase === 'function' && database.isUsingDatabase()) {
        await database.query(
          `CREATE TABLE IF NOT EXISTS market_intelligence_reports (
            id TEXT PRIMARY KEY,
            symbol TEXT NOT NULL,
            market TEXT NOT NULL,
            report_data TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
          )`
        ).catch(() => {});

        await database.query(
          `INSERT INTO market_intelligence_reports (id, symbol, market, report_data)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
          [report.id, symbol, market, JSON.stringify(report)]
        ).catch(() => {});
      }

      logger.info(`✅ [Research Agent] Intelligence report generated for ${symbol}`, { reportId: report.id });
      return report;

    } catch (error) {
      logger.error('Research scan encountered an error', { error: error.message, symbol });
      return {
        id: `INTEL_${symbol}_ERROR_${Date.now()}`,
        symbol,
        market,
        timestamp,
        dataStatus: 'UNAVAILABLE',
        error: error.message,
        macro: { bias: 'UNKNOWN', yield10Y: null, macroRegime: 'UNKNOWN' },
        sentiment: { score: null, classification: 'UNAVAILABLE', volumeShock: false },
        microstructure: { vpin: null, toxicFlow: null, whaleFlow: 'UNAVAILABLE' },
        summary: `Research scan error: ${error.message} | dataStatus: UNAVAILABLE`
      };
    }
  }

  getRecentIntelligence(limit = 10) {
    return this.intelligenceFeed.slice(0, limit);
  }
}

module.exports = new ResearchAgent();
