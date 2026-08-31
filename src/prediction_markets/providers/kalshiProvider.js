/**
 * 🏛️ Kalshi Public Market Provider Adapter (Final Frozen Specification)
 * 
 * - Full complement transformation: for each NO bid [p, q] -> YES ask = [1 - p, q], sort ascending, aggregate duplicate price ticks.
 * - Integer Fixed-Point Units: priceTicks (units of $0.0001), quantityUnits (units of 0.01 fp).
 * - Tracks requestStartedAt, responseReceivedAt, rttMs, and timestampUncertaintyMs.
 * - Fails closed to KALSHI_PUBLIC_DATA_UNAVAILABLE on 401/auth challenges (never injects keys).
 * - WebSockets disabled under zero-signing; trading methods do NOT exist.
 */

const axios = require('axios');
const IPredictionMarketProvider = require('./IPredictionMarketProvider');
const { complianceGate } = require('../compliance/complianceGate');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('KalshiProvider');

class KalshiProvider extends IPredictionMarketProvider {
  constructor(config = {}) {
    super();
    complianceGate.verifyEnvironment();

    this.baseUrl = config.baseUrl || 'https://external-api.kalshi.com/trade-api/v2';
    this.timeout = config.timeout || 8000;
  }

  async getMarkets(filter = {}) {
    const startedAt = Date.now();
    try {
      const params = {
        limit: filter.limit || 50,
        status: filter.status || 'open',
        ...filter
      };

      const res = await axios.get(`${this.baseUrl}/markets`, { params, timeout: this.timeout });
      const receivedAt = Date.now();
      const rawMarkets = res.data && res.data.markets ? res.data.markets : [];

      return rawMarkets.map(m => this._normalizeMarket(m, startedAt, receivedAt));
    } catch (err) {
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        logger.error(`🛑 [KalshiProvider] Public endpoint returned auth error (${err.response.status}). Failing closed to KALSHI_PUBLIC_DATA_UNAVAILABLE.`);
        return [];
      }
      logger.error(`❌ [KalshiProvider] getMarkets failed: ${err.message}`);
      return [];
    }
  }

  async getContract(ticker) {
    const startedAt = Date.now();
    try {
      const res = await axios.get(`${this.baseUrl}/markets/${ticker}`, { timeout: this.timeout });
      const receivedAt = Date.now();
      const raw = res.data && res.data.market ? res.data.market : res.data;
      return this._normalizeMarket(raw, startedAt, receivedAt);
    } catch (err) {
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        logger.error(`🛑 [KalshiProvider] Auth challenge for ${ticker}. Failing closed.`);
        return null;
      }
      logger.error(`❌ [KalshiProvider] getContract(${ticker}) failed: ${err.message}`);
      return null;
    }
  }

  async getOrderBook(ticker) {
    const startedAt = Date.now();
    try {
      const res = await axios.get(`${this.baseUrl}/markets/${ticker}/orderbook`, { timeout: this.timeout });
      const receivedAt = Date.now();
      const book = res.data && res.data.orderbook ? res.data.orderbook : res.data;

      return this.reconstructOrderBook(book, ticker, startedAt, receivedAt);
    } catch (err) {
      const receivedAt = Date.now();
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        logger.error(`🛑 [KalshiProvider] Orderbook auth challenge for ${ticker}. Returning KALSHI_PUBLIC_DATA_UNAVAILABLE.`);
      } else {
        logger.warn(`⚠️ [KalshiProvider] getOrderBook(${ticker}) failed: ${err.message}`);
      }
      return {
        venue: 'KALSHI',
        ticker,
        bids: [],
        asks: [],
        bestBid: 0,
        bestAsk: 1,
        requestStartedAt: startedAt,
        responseReceivedAt: receivedAt,
        rttMs: receivedAt - startedAt,
        timestampUncertaintyMs: Math.round((receivedAt - startedAt) / 2),
        observedAt: new Date(startedAt + Math.round((receivedAt - startedAt) / 2)).toISOString(),
        status: 'KALSHI_PUBLIC_DATA_UNAVAILABLE'
      };
    }
  }

  /**
   * Reconstruct and Normalize Level-by-Level Asks from Complementary Bids
   * Applies Integer Fixed-Point Tick Arithmetic (units of $0.0001 and 0.01 count)
   */
  reconstructOrderBook(rawBook, ticker = 'UNKNOWN', startedAt = Date.now(), receivedAt = Date.now()) {
    const rawYes = rawBook.yes || rawBook.yes_bids || [];
    const rawNo = rawBook.no || rawBook.no_bids || [];

    // Parse and aggregate YES bids
    const parsedYesBids = this._parseAndAggregateLevels(rawYes, 'DESC');
    // Parse and aggregate NO bids
    const parsedNoBids = this._parseAndAggregateLevels(rawNo, 'DESC');

    // Reconstruct YES asks from NO bids: Ask YES = 10000 - Bid NO (in price ticks)
    const rawYesAsks = parsedNoBids.map(level => ({
      priceTicks: 10000 - level.priceTicks,
      quantityUnits: level.quantityUnits
    }));
    const reconstructedYesAsks = this._aggregateAndSortLevels(rawYesAsks, 'ASC');

    // Reconstruct NO asks from YES bids: Ask NO = 10000 - Bid YES (in price ticks)
    const rawNoAsks = parsedYesBids.map(level => ({
      priceTicks: 10000 - level.priceTicks,
      quantityUnits: level.quantityUnits
    }));
    const reconstructedNoAsks = this._aggregateAndSortLevels(rawNoAsks, 'ASC');

    // Map back to friendly display objects while keeping exact ticks
    const yesBids = parsedYesBids.map(l => this._levelToDisplay(l));
    const yesAsks = reconstructedYesAsks.map(l => this._levelToDisplay(l));
    const noBids = parsedNoBids.map(l => this._levelToDisplay(l));
    const noAsks = reconstructedNoAsks.map(l => this._levelToDisplay(l));

    const rttMs = Math.max(1, receivedAt - startedAt);
    const timestampUncertaintyMs = Math.round(rttMs / 2);
    const observedAtMs = startedAt + timestampUncertaintyMs;

    return {
      venue: 'KALSHI',
      ticker,
      bids: yesBids,
      asks: yesAsks,
      noBids,
      noAsks,
      bestBid: yesBids[0]?.price || 0,
      bestAsk: yesAsks[0]?.price || 1,
      bestNoBid: noBids[0]?.price || 0,
      bestNoAsk: noAsks[0]?.price || 1,
      requestStartedAt: startedAt,
      responseReceivedAt: receivedAt,
      rttMs,
      timestampUncertaintyMs,
      observedAt: new Date(observedAtMs).toISOString(),
      status: 'OK'
    };
  }

  _parseAndAggregateLevels(rawLevels, sortDirection = 'DESC') {
    const levelMap = new Map(); // priceTicks -> quantityUnits

    for (const [pRaw, qRaw] of rawLevels) {
      let pTicks = 0;
      if (typeof pRaw === 'number') {
        pTicks = Math.round((pRaw > 1 ? pRaw / 100 : pRaw) * 10000);
      } else {
        pTicks = Math.round(parseFloat(pRaw) * 10000);
      }

      let qUnits = 0;
      if (typeof qRaw === 'number') {
        qUnits = Math.round(qRaw * 100);
      } else {
        qUnits = Math.round(parseFloat(qRaw) * 100);
      }

      if (pTicks <= 0 || pTicks >= 10000 || qUnits <= 0) continue;

      levelMap.set(pTicks, (levelMap.get(pTicks) || 0) + qUnits);
    }

    const levels = [];
    for (const [priceTicks, quantityUnits] of levelMap.entries()) {
      levels.push({ priceTicks, quantityUnits });
    }

    return this._aggregateAndSortLevels(levels, sortDirection);
  }

  _aggregateAndSortLevels(levels, sortDirection = 'ASC') {
    const levelMap = new Map();
    for (const l of levels) {
      if (l.priceTicks <= 0 || l.priceTicks >= 10000 || l.quantityUnits <= 0) continue;
      levelMap.set(l.priceTicks, (levelMap.get(l.priceTicks) || 0) + l.quantityUnits);
    }

    const result = [];
    for (const [priceTicks, quantityUnits] of levelMap.entries()) {
      result.push({ priceTicks, quantityUnits });
    }

    if (sortDirection === 'ASC') {
      result.sort((a, b) => a.priceTicks - b.priceTicks);
    } else {
      result.sort((a, b) => b.priceTicks - a.priceTicks);
    }
    return result;
  }

  _levelToDisplay(level) {
    const price = level.priceTicks / 10000;
    const size = level.quantityUnits / 100;
    return {
      price,
      size,
      priceTicks: level.priceTicks,
      quantityUnits: level.quantityUnits,
      priceStr: price.toFixed(4),
      sizeStr: size.toFixed(2)
    };
  }

  subscribeBook(tokenId, callback) {
    throw new Error('DISABLED_ZERO_SIGNING: Kalshi WebSocket requires signed auth headers and is disabled in research mode.');
  }

  _normalizeMarket(m, startedAt = Date.now(), receivedAt = Date.now()) {
    const yesBid = m.yes_bid ? parseFloat((m.yes_bid > 1 ? m.yes_bid / 100 : m.yes_bid).toFixed(4)) : (m.yes_sub_title ? 0.5 : 0);
    const yesAsk = m.yes_ask ? parseFloat((m.yes_ask > 1 ? m.yes_ask / 100 : m.yes_ask).toFixed(4)) : 0;
    const lastPrice = m.last_price ? parseFloat((m.last_price > 1 ? m.last_price / 100 : m.last_price).toFixed(4)) : yesBid;

    const rttMs = Math.max(1, receivedAt - startedAt);
    const timestampUncertaintyMs = Math.round(rttMs / 2);

    return {
      id: m.ticker || m.id,
      venue: 'KALSHI',
      ticker: m.ticker,
      title: m.title,
      subtitle: m.subtitle,
      category: m.category || 'Macroeconomics',
      status: m.status,
      yesBid,
      yesAsk,
      lastPrice,
      volume: m.volume || m.volume_24h || 0,
      openInterest: m.open_interest || 0,
      expirationTime: m.expiration_time || m.close_time,
      rulesText: m.rule_book_variables?.settlement_sources || m.subtitle || m.title,
      settlementSource: m.rule_book_variables?.settlement_sources || 'Bureau of Labor Statistics / Federal Reserve',
      requestStartedAt: startedAt,
      responseReceivedAt: receivedAt,
      rttMs,
      timestampUncertaintyMs,
      observedAt: new Date(startedAt + timestampUncertaintyMs).toISOString(),
      raw: m
    };
  }
}

const kalshiProvider = new KalshiProvider();
module.exports = { KalshiProvider, kalshiProvider };
