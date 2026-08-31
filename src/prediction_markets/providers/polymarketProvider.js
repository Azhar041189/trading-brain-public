/**
 * 🌐 Polymarket Public Data Provider (Phase P0 Read-Only)
 * 
 * Implements IPredictionMarketProvider for Polymarket's Gamma REST API & CLOB WebSocket.
 * Operates strictly in Read-Only mode without wallet private keys or signing capabilities.
 */

const axios = require('axios');
const WebSocket = require('ws');
const IPredictionMarketProvider = require('./IPredictionMarketProvider');
const { complianceGate } = require('../compliance/complianceGate');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('PolymarketProvider');

class PolymarketProvider extends IPredictionMarketProvider {
  constructor(config = {}) {
    super();
    // Verify zero-signing compliance invariant on instantiation
    complianceGate.verifyEnvironment();

    this.gammaApiUrl = config.gammaApiUrl || 'https://gamma-api.polymarket.com';
    this.clobApiUrl = config.clobApiUrl || 'https://clob.polymarket.com';
    this.clobWsUrl = config.clobWsUrl || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    
    this.ws = null;
    this.wsSubscriptions = new Map(); // tokenId -> Set of callback functions
    this.isWsConnected = false;
    this.reconnectTimer = null;
  }

  /**
   * Fetch active markets from Polymarket Gamma API
   * @param {Object} filter - { limit, offset, active, closed, tag_id, category }
   */
  async getMarkets(filter = {}) {
    try {
      const params = {
        limit: filter.limit || 20,
        offset: filter.offset || 0,
        active: filter.active !== undefined ? filter.active : true,
        closed: filter.closed !== undefined ? filter.closed : false,
        ...filter
      };

      const res = await axios.get(`${this.gammaApiUrl}/markets`, { params, timeout: 8000 });
      const rawMarkets = Array.isArray(res.data) ? res.data : [];

      return rawMarkets.map(m => this._normalizeMarket(m));
    } catch (err) {
      logger.error(`❌ [PolymarketProvider] getMarkets failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch top curated macro / geopolitics / economics events
   * @param {Object} filter - { limit, tag }
   */
  async getEvents(filter = {}) {
    try {
      const params = {
        limit: filter.limit || 15,
        active: true,
        closed: false,
        ...filter
      };

      const res = await axios.get(`${this.gammaApiUrl}/events`, { params, timeout: 8000 });
      return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      logger.error(`❌ [PolymarketProvider] getEvents failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch a single market / contract definition by conditionId or slug
   */
  async getContract(identifier) {
    try {
      let res;
      if (identifier.startsWith('0x')) {
        res = await axios.get(`${this.gammaApiUrl}/markets`, { params: { condition_id: identifier }, timeout: 8000 });
        if (Array.isArray(res.data) && res.data.length > 0) {
          return this._normalizeMarket(res.data[0]);
        }
      } else {
        res = await axios.get(`${this.gammaApiUrl}/markets`, { params: { slug: identifier }, timeout: 8000 });
        if (Array.isArray(res.data) && res.data.length > 0) {
          return this._normalizeMarket(res.data[0]);
        }
      }
      return null;
    } catch (err) {
      logger.error(`❌ [PolymarketProvider] getContract(${identifier}) failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch live CLOB order-book snapshot for a specific token
   * @param {string} tokenId - ERC-1155 Token ID
   */
  async getOrderBook(tokenId) {
    try {
      const res = await axios.get(`${this.clobApiUrl}/book`, {
        params: { token_id: tokenId },
        timeout: 5000
      });

      const data = res.data || {};
      const bids = (data.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
      const asks = (data.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));

      // Sort bids descending (highest buy price first), asks ascending (lowest sell price first)
      bids.sort((a, b) => b.price - a.price);
      asks.sort((a, b) => a.price - b.price);

      const bestBid = bids.length > 0 ? bids[0].price : 0;
      const bestAsk = asks.length > 0 ? asks[0].price : 1;
      const midpoint = bids.length > 0 && asks.length > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || 0.5);
      const spread = asks.length > 0 && bids.length > 0 ? parseFloat((bestAsk - bestBid).toFixed(4)) : 0;

      return {
        tokenId,
        timestamp: new Date().toISOString(),
        bestBid,
        bestAsk,
        midpoint,
        spread,
        bids,
        asks,
        marketHash: data.hash || null
      };
    } catch (err) {
      logger.warn(`⚠️ [PolymarketProvider] getOrderBook(${tokenId}) error: ${err.message}`);
      return {
        tokenId,
        timestamp: new Date().toISOString(),
        bestBid: 0,
        bestAsk: 1,
        midpoint: 0.5,
        spread: 1.0,
        bids: [],
        asks: [],
        marketHash: null
      };
    }
  }

  /**
   * Normalize raw API market object to standard internal format
   */
  normalizeMarket(raw) {
    return this._normalizeMarket(raw);
  }

  /**
   * Fetch official fee schedule metadata for a specific market
   * @param {string} marketIdentifier - Market or Condition ID or Slug
   */
  async getFeeSchedule(marketIdentifier) {
    try {
      let category = 'GENERAL';
      let question = '';

      if (typeof marketIdentifier === 'string' && marketIdentifier.toLowerCase().includes('crypto') || marketIdentifier.toLowerCase().includes('fed') || marketIdentifier.toLowerCase().includes('bitcoin')) {
        category = marketIdentifier.toLowerCase().includes('crypto') || marketIdentifier.toLowerCase().includes('bitcoin') ? 'CRYPTO' : 'MACRO';
      } else {
        const contract = await this.getContract(marketIdentifier).catch(() => null);
        if (contract) {
          category = (contract.category || '').toUpperCase();
          question = (contract.question || '').toLowerCase();
        }
      }
      
      // Official Polymarket fee rate parameters (Crypto: 0.07, Politics/Weather: 0.00)
      const isCrypto = category.includes('CRYPTO') || question.includes('bitcoin');
      const feeRate = isCrypto ? 0.07 : 0.00;
      const feesEnabled = isCrypto;

      const schedule = {
        marketId: marketIdentifier,
        category,
        feesEnabled,
        feeRate,
        exponent: 1,
        takerOnly: true,
        rebateRate: 0.00, // Conservative baseline = 0 for research
        roundingDecimals: 5,
        metadataTimestamp: new Date().toISOString(),
        scheduleHash: `poly_fee_${category}_${feeRate}_exp1`
      };

      return schedule;
    } catch (err) {
      return {
        marketId: marketIdentifier,
        category: 'DEFAULT',
        feesEnabled: false,
        feeRate: 0.00,
        exponent: 1,
        takerOnly: true,
        rebateRate: 0.00,
        roundingDecimals: 5,
        metadataTimestamp: new Date().toISOString(),
        scheduleHash: 'poly_fee_default'
      };
    }
  }

  /**
   * Fetch complete, unedited resolution rules and Oracle parameters
   */
  async getResolutionRules(conditionId) {
    const contract = await this.getContract(conditionId);
    if (!contract) return null;

    return {
      conditionId: contract.conditionId,
      question: contract.question,
      description: contract.description,
      resolutionSource: contract.resolutionSource,
      rulesText: contract.rulesText,
      endTimestamp: contract.endTimestamp,
      oracleMechanism: contract.oracleMechanism || 'UMA_OPTIMISTIC_ORACLE',
      negRisk: contract.negRisk || false,
      clarifications: contract.clarifications || []
    };
  }

  /**
   * Subscribe to real-time WebSocket order-book updates for a token
   * @param {string} tokenId - ERC-1155 Token ID
   * @param {Function} callback - Callback receiving updated book snapshot
   */
  subscribeBook(tokenId, callback) {
    if (!this.wsSubscriptions.has(tokenId)) {
      this.wsSubscriptions.set(tokenId, new Set());
    }
    this.wsSubscriptions.get(tokenId).add(callback);

    this._ensureWebSocket();
    this._sendWsSubscription(tokenId);

    // Return unsubscribe handle
    return () => {
      if (this.wsSubscriptions.has(tokenId)) {
        this.wsSubscriptions.get(tokenId).delete(callback);
        if (this.wsSubscriptions.get(tokenId).size === 0) {
          this.wsSubscriptions.delete(tokenId);
          this._sendWsUnsubscription(tokenId);
        }
      }
    };
  }

  // ============ PRIVATE HELPERS ============

  _normalizeMarket(raw) {
    let tokenIds = [];
    try {
      tokenIds = typeof raw.clobTokenIds === 'string' ? JSON.parse(raw.clobTokenIds) : (raw.clobTokenIds || []);
    } catch (e) {
      tokenIds = [];
    }

    let outcomePrices = [];
    try {
      outcomePrices = typeof raw.outcomePrices === 'string' ? JSON.parse(raw.outcomePrices) : (raw.outcomePrices || []);
    } catch (e) {
      outcomePrices = [];
    }

    let outcomes = [];
    try {
      outcomes = typeof raw.outcomes === 'string' ? JSON.parse(raw.outcomes) : (raw.outcomes || ['Yes', 'No']);
    } catch (e) {
      outcomes = ['Yes', 'No'];
    }

    return {
      id: raw.id,
      conditionId: raw.conditionId,
      slug: raw.slug,
      question: raw.question,
      description: raw.description || '',
      category: raw.category || 'General',
      active: raw.active,
      closed: raw.closed,
      endTimestamp: raw.endDate || raw.end_date_iso,
      resolutionSource: raw.resolutionSource || raw.resolution_source || 'UMA Oracle',
      rulesText: raw.description || raw.question || '',
      tokenIds: {
        yes: tokenIds[0] || null,
        no: tokenIds[1] || null
      },
      outcomes,
      outcomePrices: {
        yes: parseFloat(outcomePrices[0] || 0.5),
        no: parseFloat(outcomePrices[1] || 0.5)
      },
      volume: parseFloat(raw.volume || raw.volumeNum || raw.volume24hr || 0),
      volumeNum: parseFloat(raw.volumeNum || raw.volume || raw.volume24hr || 0),
      volume24hr: parseFloat(raw.volume24hr || 0),
      liquidity: parseFloat(raw.liquidity || 0),
      negRisk: Boolean(raw.negRisk),
      collateralAsset: 'pUSD',
      collateralDecimals: 6,
      collateralValueUSD: 1.00
    };
  }

  _ensureWebSocket() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.clobWsUrl);

      this.ws.on('open', () => {
        this.isWsConnected = true;
        logger.info('🌐 [PolymarketProvider] WebSocket connected to CLOB feed.');
        // Re-subscribe all active tokens
        for (const tokenId of this.wsSubscriptions.keys()) {
          this._sendWsSubscription(tokenId);
        }
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleWsMessage(msg);
        } catch (e) {}
      });

      this.ws.on('close', () => {
        this.isWsConnected = false;
        logger.warn('⚠️ [PolymarketProvider] WebSocket closed. Scheduling reconnection in 5s...');
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        logger.warn(`⚠️ [PolymarketProvider] WebSocket error: ${err.message}`);
      });
    } catch (err) {
      logger.error(`❌ [PolymarketProvider] Failed to open WebSocket: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.wsSubscriptions.size > 0) {
        this._ensureWebSocket();
      }
    }, 5000);
  }

  _sendWsSubscription(tokenId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        type: 'subscribe',
        channel: 'book',
        token_id: tokenId
      });
      this.ws.send(payload);
    }
  }

  _sendWsUnsubscription(tokenId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        type: 'unsubscribe',
        channel: 'book',
        token_id: tokenId
      });
      this.ws.send(payload);
    }
  }

  _handleWsMessage(msg) {
    if (!msg || !msg.token_id) return;
    const listeners = this.wsSubscriptions.get(msg.token_id);
    if (listeners && listeners.size > 0) {
      listeners.forEach(cb => {
        try { cb(msg); } catch (e) {}
      });
    }
  }
}

const polymarketProvider = new PolymarketProvider();
module.exports = { PolymarketProvider, polymarketProvider };
