/**
 * 🔮 Polymarket MCP (Model Context Protocol) Client for Trading Brain & AI Swarm
 * 
 * Exposes standardized MCP tool interfaces for AI Hermes, Macro Committee,
 * and Research Subagents to query Polymarket Gamma REST API and CLOB depth.
 * 
 * Invariants:
 * - 100% Read-Only (Zero-Signing Enforced)
 * - Cached responses (TTL 60s) to prevent rate limits
 * - Bounded output formatting for token-efficient LLM contexts
 */

const axios = require('axios');
const { PolymarketProvider } = require('../prediction_markets/providers/polymarketProvider');
const { createAgentLogger } = require('../core/logger');

const logger = createAgentLogger('PolymarketMcpClient');

class PolymarketMcpClient {
  constructor(config = {}) {
    this.provider = new PolymarketProvider(config);
    this.cache = new Map();
    this.cacheTTL = (config.cacheTTLSeconds || 60) * 1000;
  }

  _getCached(key) {
    const item = this.cache.get(key);
    if (item && (Date.now() - item.timestamp < this.cacheTTL)) {
      return item.data;
    }
    return null;
  }

  _setCached(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Tool: search_markets
   * Search Polymarket active events and contracts by keyword or category
   */
  async searchMarkets(query = '', limit = 10) {
    const cacheKey = `search_${query}_${limit}`;
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    try {
      const allMarkets = await this.provider.getMarkets({ limit: 40 });
      let filtered = allMarkets;

      if (query && query.trim().length > 0) {
        const q = query.toLowerCase();
        filtered = allMarkets.filter(m => 
          (m.question && m.question.toLowerCase().includes(q)) ||
          (m.category && m.category.toLowerCase().includes(q)) ||
          (m.description && m.description.toLowerCase().includes(q))
        );
      }

      const results = filtered.slice(0, limit).map(m => ({
        id: m.id,
        conditionId: m.conditionId,
        question: m.question,
        category: m.category,
        yesOddsPct: m.outcomePrices?.yes ? (m.outcomePrices.yes * 100).toFixed(1) + '%' : '50.0%',
        noOddsPct: m.outcomePrices?.no ? (m.outcomePrices.no * 100).toFixed(1) + '%' : '50.0%',
        tokenYes: m.tokenIds?.yes,
        resolutionSource: m.resolutionSource || 'UMA Oracle',
        endDate: m.endTimestamp
      }));

      const out = {
        totalFound: filtered.length,
        returned: results.length,
        markets: results
      };

      this._setCached(cacheKey, out);
      return out;
    } catch (err) {
      logger.error(`searchMarkets error: ${err.message}`);
      return { totalFound: 0, returned: 0, markets: [], error: err.message };
    }
  }

  /**
   * Tool: get_market_odds
   * Retrieve live odds, implied probabilities, and risk metrics for a specific market
   */
  async getMarketOdds(conditionIdOrSlug) {
    const cacheKey = `odds_${conditionIdOrSlug}`;
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    try {
      const contract = await this.provider.getContract(conditionIdOrSlug);
      if (!contract) {
        return { success: false, error: `Market not found for identifier: ${conditionIdOrSlug}` };
      }

      const fee = await this.provider.getFeeSchedule(conditionIdOrSlug);

      const data = {
        success: true,
        question: contract.question,
        category: contract.category,
        conditionId: contract.conditionId,
        yesPrice: contract.outcomePrices?.yes || 0.5,
        noPrice: contract.outcomePrices?.no || 0.5,
        yesPercent: ((contract.outcomePrices?.yes || 0.5) * 100).toFixed(1) + '%',
        noPercent: ((contract.outcomePrices?.no || 0.5) * 100).toFixed(1) + '%',
        feeRate: fee.feeRate,
        resolutionOracle: contract.resolutionSource || 'UMA Optimistic Oracle',
        tokenIds: contract.tokenIds
      };

      this._setCached(cacheKey, data);
      return data;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Tool: get_clob_order_book
   * Fetch L2 bids, asks, midpoint, and spread for a CLOB token
   */
  async getClobOrderBook(tokenId) {
    if (!tokenId) {
      return { success: false, error: 'tokenId is required' };
    }

    try {
      const book = await this.provider.getOrderBook(tokenId);
      return {
        success: true,
        tokenId,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        midpoint: book.midpoint,
        spread: book.spread,
        bidsCount: book.bids?.length || 0,
        asksCount: book.asks?.length || 0,
        topBids: (book.bids || []).slice(0, 5),
        topAsks: (book.asks || []).slice(0, 5)
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Tool: get_macro_predictions
   * Curated high-impact macroeconomic prediction markets (Fed rates, Inflation, Policy)
   */
  async getMacroPredictions() {
    const cacheKey = 'macro_predictions';
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    try {
      const markets = await this.provider.getMarkets({ limit: 40 });
      const macroKeywords = ['fed', 'rate', 'cut', 'inflation', 'gdp', 'recession', 'tariff', 'treasury', 'election', 'president'];
      
      const macroMarkets = markets.filter(m => {
        const text = `${m.question} ${m.category} ${m.description}`.toLowerCase();
        return macroKeywords.some(k => text.includes(k));
      }).map(m => ({
        question: m.question,
        category: m.category,
        yesOdds: (m.outcomePrices?.yes * 100).toFixed(0) + '%',
        noOdds: (m.outcomePrices?.no * 100).toFixed(0) + '%',
        conditionId: m.conditionId,
        tokenYes: m.tokenIds?.yes
      }));

      const result = {
        count: macroMarkets.length,
        curatedAt: new Date().toISOString(),
        predictions: macroMarkets
      };

      this._setCached(cacheKey, result);
      return result;
    } catch (err) {
      return { count: 0, predictions: [], error: err.message };
    }
  }

  /**
   * Tool: get_crypto_predictions
   * Curated cryptocurrency milestone prediction markets (BTC, ETH, SOL)
   */
  async getCryptoPredictions() {
    const cacheKey = 'crypto_predictions';
    const cached = this._getCached(cacheKey);
    if (cached) return cached;

    try {
      const markets = await this.provider.getMarkets({ limit: 40 });
      const cryptoKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'crypto'];
      
      const cryptoMarkets = markets.filter(m => {
        const text = `${m.question} ${m.category}`.toLowerCase();
        return cryptoKeywords.some(k => text.includes(k));
      }).map(m => ({
        question: m.question,
        category: m.category,
        yesOdds: (m.outcomePrices?.yes * 100).toFixed(0) + '%',
        noOdds: (m.outcomePrices?.no * 100).toFixed(0) + '%',
        conditionId: m.conditionId,
        tokenYes: m.tokenIds?.yes
      }));

      const result = {
        count: cryptoMarkets.length,
        curatedAt: new Date().toISOString(),
        predictions: cryptoMarkets
      };

      this._setCached(cacheKey, result);
      return result;
    } catch (err) {
      return { count: 0, predictions: [], error: err.message };
    }
  }

  /**
   * Tool: simulate_paper_trade
   * Execute a simulated paper trade against real-time Polymarket CLOB book depth
   */
  async simulatePaperTrade(args = {}) {
    const { conditionIdOrSlug, outcome = 'YES', side = 'BUY', shares = 10 } = args;
    if (!conditionIdOrSlug) {
      return { success: false, error: 'conditionIdOrSlug is required' };
    }

    try {
      const contract = await this.provider.getContract(conditionIdOrSlug);
      if (!contract) {
        return { success: false, error: `Contract not found for: ${conditionIdOrSlug}` };
      }

      const tokenId = outcome.toUpperCase() === 'YES' ? contract.tokenIds?.yes : contract.tokenIds?.no;
      if (!tokenId) {
        return { success: false, error: `Token ID not found for outcome: ${outcome}` };
      }

      const book = await this.provider.getOrderBook(tokenId);
      const bookSide = side.toUpperCase() === 'BUY' ? book.asks : book.bids;

      if (!bookSide || bookSide.length === 0) {
        return { success: false, error: 'No live liquidity available in CLOB book for this token' };
      }

      const { paperPredictionClobSimulator } = require('../prediction_markets/simulation/paperPredictionClobSimulator');
      const fill = paperPredictionClobSimulator.simulateTakerOrder({
        marketId: contract.id || conditionIdOrSlug,
        question: contract.question,
        tokenId,
        side,
        outcome: outcome.toUpperCase(),
        shares: parseFloat(shares),
        bookSide,
        feeSchedule: { feesEnabled: contract.category !== 'Economics', feeRate: 0.07 }
      });

      return {
        success: fill.status === 'FILLED' || fill.status === 'PARTIALLY_FILLED',
        paperTrade: {
          orderId: fill.orderId,
          question: contract.question,
          outcome: fill.outcome,
          side: fill.side,
          shares: fill.filledShares,
          avgPrice: fill.averageFillPrice,
          totalCostUSD: fill.totalCostUSD,
          feeUSD: fill.totalFeeUSD,
          maxLossUSD: fill.maxLossTotalUSD,
          status: fill.status,
          fillProvenance: fill.fillProvenance,
          timestamp: fill.timestamp
        }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * List available MCP tools with their parameter schemas
   */
  listTools() {
    return [
      {
        name: 'polymarket_search_markets',
        description: 'Search active Polymarket prediction markets by keyword, topic, or category (e.g. Fed rates, crypto, politics).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term or topic (optional)' },
            limit: { type: 'number', description: 'Maximum results to return (default 10)' }
          }
        }
      },
      {
        name: 'polymarket_get_market_odds',
        description: 'Get live implied probabilities (YES/NO odds), fee schedule, and resolution oracle for a specific Polymarket condition ID or slug.',
        parameters: {
          type: 'object',
          properties: {
            conditionIdOrSlug: { type: 'string', description: 'Market condition ID (0x...) or slug' }
          },
          required: ['conditionIdOrSlug']
        }
      },
      {
        name: 'polymarket_get_clob_order_book',
        description: 'Fetch live CLOB orderbook depth, best bid/ask, midpoint, and spread for a Polymarket outcome token.',
        parameters: {
          type: 'object',
          properties: {
            tokenId: { type: 'string', description: 'ERC-1155 Token ID' }
          },
          required: ['tokenId']
        }
      },
      {
        name: 'polymarket_get_macro_predictions',
        description: 'Fetch curated macroeconomic & geopolitical prediction markets (Fed rate decisions, recession odds, tariffs, elections).',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'polymarket_get_crypto_predictions',
        description: 'Fetch curated cryptocurrency prediction markets (Bitcoin all-time-high targets, Ethereum ETF flows, Solana milestones).',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'polymarket_simulate_paper_trade',
        description: 'Execute a simulated paper trade against real-time Polymarket CLOB book depth with realistic fee curve & slippage modeling (Zero Real Capital).',
        parameters: {
          type: 'object',
          properties: {
            conditionIdOrSlug: { type: 'string', description: 'Market condition ID (0x...) or slug' },
            outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome token to trade (YES or NO)' },
            side: { type: 'string', enum: ['BUY', 'SELL'], description: 'Order direction (BUY or SELL)' },
            shares: { type: 'number', description: 'Number of outcome shares to purchase' }
          },
          required: ['conditionIdOrSlug', 'outcome', 'shares']
        }
      }
    ];
  }

  /**
   * Universal MCP tool executor
   */
  async executeTool(toolName, args = {}) {
    switch (toolName) {
      case 'polymarket_search_markets':
        return this.searchMarkets(args.query, args.limit);
      case 'polymarket_get_market_odds':
        return this.getMarketOdds(args.conditionIdOrSlug);
      case 'polymarket_get_clob_order_book':
        return this.getClobOrderBook(args.tokenId);
      case 'polymarket_get_macro_predictions':
        return this.getMacroPredictions();
      case 'polymarket_get_crypto_predictions':
        return this.getCryptoPredictions();
      case 'polymarket_simulate_paper_trade':
        return this.simulatePaperTrade(args);
      default:
        throw new Error(`Unknown Polymarket MCP tool: ${toolName}`);
    }
  }
}

module.exports = {
  PolymarketMcpClient,
  polymarketMcpClient: new PolymarketMcpClient()
};
