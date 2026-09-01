const config = require('../config');
const { createAgentLogger } = require('./logger');
const database = require('./database');
const marketRegistry = require('./marketRegistry');

const preMarketAgent = require('../agents/research/preMarketAgent');
const momentumAgent = require('../agents/signal/momentumAgent');
const meanReversionAgent = require('../agents/signal/meanReversionAgent');
const optionsAgent = require('../agents/signal/optionsAgent');
const riskManager = require('../agents/risk/riskManager');
const executionEngine = require('../agents/execution/executionEngine');
const learningAgent = require('../agents/learning/learningAgent');

const logger = createAgentLogger('Orchestrator');

class TradingOrchestrator {
  constructor(marketId = process.env.MARKET || 'IN') {
    this.marketId = marketId.toUpperCase();
    this.market = marketRegistry.getMarket(this.marketId);
    this.isRunning = false;
    this.preMarketBriefing = null;
    this.marketData = new Map();
    this.portfolio = {
      totalCapital: config.trading.initialCapital,
      availableMargin: config.trading.initialCapital * 0.8,
      availableCash: config.trading.initialCapital
    };
  }

  async initialize() {
    logger.info(`Initializing Trading Brain for Market: [${this.market.config.name}]...`);
    
    // Initialize database
    await database.initDatabase();
    
    // Initialize components
    await riskManager.initialize();
    await executionEngine.initialize();
    
    // Initialize broker adapter for active market
    await this.initBroker();
    
    logger.info(`Trading Brain initialized successfully for ${this.market.config.id}`);
  }

  async initBroker() {
    try {
      if (this.market.broker) {
        await this.market.broker.initialize();
        const funds = await this.market.broker.getFunds();
        if (funds) {
          this.portfolio.totalCapital = funds.totalCapital || this.portfolio.totalCapital;
          this.portfolio.availableCash = funds.availableCash || this.portfolio.availableCash;
          this.portfolio.availableMargin = funds.availableMargin || this.portfolio.availableMargin;
        }
        logger.info(`Broker adapter connected: ${this.market.broker.name}`, {
          currency: this.market.config.currencySymbol,
          capital: this.portfolio.totalCapital
        });
      }
    } catch (error) {
      logger.warn(`Broker initialization warning: ${error.message}`);
    }
  }

  // ============ FULL TRADING CYCLE ============

  async runFullCycle() {
    if (this.isRunning) {
      logger.warn('Cycle already running, skipping');
      return;
    }

    this.isRunning = true;
    const cycleStart = Date.now();
    
    try {
      logger.info(`=== Starting Full Trading Cycle [${this.market.config.id}] ===`);
      
      // 1. Pre-market research
      await this.runPreMarket();
      
      // 2. Fetch market data
      await this.fetchMarketData();
      
      // 3. Generate signals
      const signals = await this.generateSignals();
      
      // 4. Execute trades
      const executionResults = await this.executeSignals(signals);
      
      // 5. Monitor positions
      await this.monitorPositions();
      
      // 6. End of day routine
      await this.endOfDay();
      
      // 7. Learning review
      await this.runLearning();
      
      logger.info(`=== Full Trading Cycle Complete [${this.market.config.id}] ===`, { 
        duration: `${((Date.now() - cycleStart) / 1000 / 60).toFixed(1)} min`,
        signalsGenerated: signals.length,
        tradesExecuted: executionResults.filter(r => r.success).length
      });
      
    } catch (error) {
      logger.error('Trading cycle failed', { error: error.message, stack: error.stack });
    } finally {
      this.isRunning = false;
    }
  }

  async runPreMarket() {
    logger.info(`Running pre-market research for ${this.market.config.id}...`);
    this.preMarketBriefing = await preMarketAgent.run();
    
    // Log key findings
    logger.info('Pre-market briefing', {
      date: this.preMarketBriefing.date,
      bias: this.preMarketBriefing.marketBias?.bias,
      score: this.preMarketBriefing.marketBias?.score,
      ideas: this.preMarketBriefing.actionableIdeas?.length || 0
    });
  }

  async fetchMarketData() {
    logger.info(`Fetching market data for ${this.market.config.id}...`);
    
    const symbols = this.getWatchlistSymbols();
    const dataProvider = this.market.dataProvider;
    
    for (const symbol of symbols) {
      try {
        const candles = await dataProvider.fetchCandles(symbol);
        if (candles && candles.length > 0) {
          this.marketData.set(symbol, { candles, symbol, market: this.market.config.id });
        }
      } catch (error) {
        logger.warn(`Market data fetch failed for ${symbol}`, { error: error.message });
      }
    }
    
    logger.info(`Market data loaded for ${this.marketData.size} symbols`);
  }

  getWatchlistSymbols() {
    const symbols = new Set();
    
    if (this.preMarketBriefing?.actionableIdeas) {
      for (const idea of this.preMarketBriefing.actionableIdeas) {
        symbols.add(idea.symbol);
      }
    }
    
    const defaultList = this.market.config.defaultWatchlist || [];
    defaultList.forEach(s => symbols.add(s));
    
    return Array.from(symbols);
  }

  async generateSignals() {
    logger.info(`Generating trading signals for ${this.market.config.id}...`);
    
    const allSignals = [];
    
    const [momentumSignals, mrSignals, optionsSignals] = await Promise.allSettled([
      momentumAgent.generateSignals(this.marketData, this.preMarketBriefing),
      meanReversionAgent.generateSignals(this.marketData, this.preMarketBriefing),
      this.market.config.id === 'IN' ? optionsAgent.generateSignals(this.marketData, this.preMarketBriefing) : Promise.resolve([])
    ]);
    
    if (momentumSignals.status === 'fulfilled') allSignals.push(...momentumSignals.value);
    if (mrSignals.status === 'fulfilled') allSignals.push(...mrSignals.value);
    if (optionsSignals.status === 'fulfilled' && Array.isArray(optionsSignals.value)) {
      allSignals.push(...optionsSignals.value);
    }
    
    for (const signal of allSignals) {
      signal.market = this.market.config.id;
      signal.currency = this.market.config.currency;
      signal.securityId = this.getSecurityId(signal.symbol);
      signal.segment = this.getSegment(signal.symbol);
      signal.exchangeSegment = this.getExchangeSegment(signal.symbol);
    }
    
    await this.saveSignals(allSignals);
    
    logger.info('Signals generated', { 
      market: this.market.config.id,
      total: allSignals.length,
      momentum: momentumSignals.status === 'fulfilled' ? momentumSignals.value.length : 0,
      meanReversion: mrSignals.status === 'fulfilled' ? mrSignals.value.length : 0
    });
    
    return allSignals;
  }

  getSecurityId(symbol) {
    if (this.market.config.securityIds) {
      return this.market.config.securityIds[symbol] || symbol;
    }
    return symbol;
  }

  getSegment(symbol) {
    if (this.market.config.id === 'IN') {
      const indices = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
      return indices.includes(symbol) ? 'NSE_FNO' : 'NSE_EQ';
    }
    return 'US_EQ';
  }

  getExchangeSegment(symbol) {
    if (this.market.config.id === 'IN') {
      const indices = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
      return indices.includes(symbol) ? 'NSE_FNO' : 'NSE_EQ';
    }
    return 'NASDAQ';
  }

  async saveSignals(signals) {
    try {
      for (const signal of signals) {
        await database.query(
          `INSERT INTO signals (symbol, exchange, segment, signal_type, direction, strength, entry_price, stop_loss, take_profit, indicators, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            signal.symbol,
            this.market.config.id === 'IN' ? 'NSE' : 'US',
            signal.segment,
            signal.strategy,
            signal.direction,
            signal.confidence,
            signal.entryPrice,
            signal.stopLoss,
            signal.takeProfit,
            JSON.stringify({ atr: signal.atr, riskReward: signal.riskReward }),
            JSON.stringify({ reason: signal.reason, preMarketBias: this.preMarketBriefing?.marketBias?.bias })
          ]
        );
      }
    } catch (error) {
      logger.warn('Save signals failed', { error: error.message });
    }
  }

  async executeSignals(signals) {
    logger.info('Executing signals...', { count: signals.length, market: this.market.config.id });
    
    const results = await executionEngine.executeMultipleSignals(signals, this.portfolio);
    await this.updatePortfolio();
    
    const successful = results.filter(r => r.success).length;
    logger.info('Execution complete', { 
      attempted: signals.length, 
      successful, 
      rejected: results.filter(r => r.rejected).length,
      skipped: results.filter(r => r.skipped).length
    });
    
    return results;
  }

  async monitorPositions() {
    logger.info(`Monitoring positions for ${this.market.config.id}...`);
  }

  async updatePortfolio() {
    try {
      const positions = await executionEngine.getCurrentPositions();
      let unrealizedPnL = 0;
      let marginUsed = 0;
      
      for (const pos of positions) {
        unrealizedPnL += parseFloat(pos.unrealized_pnl || pos.unrealizedPnL || 0);
        if (pos.segment === 'NSE_FNO') {
          marginUsed += (pos.quantity || 0) * (pos.avg_price || pos.avgPrice || 0) * 0.15;
        }
      }
      
      this.portfolio.availableMargin = this.portfolio.totalCapital - marginUsed;
      await riskManager.updatePnL(0, unrealizedPnL);
    } catch (error) {
      logger.warn('Portfolio update failed', { error: error.message });
    }
  }

  async endOfDay() {
    logger.info(`Running end-of-day routine for ${this.market.config.id}...`);
    await executionEngine.endOfDay();
    await riskManager.resetDaily();
    logger.info('End of day complete');
  }

  async runLearning() {
    logger.info(`Running learning agent for ${this.market.config.id}...`);
    await learningAgent.runDailyReview();
  }

  // ============ SCHEDULER ============

  startScheduler() {
    const CronJob = require('cron').CronJob;
    const tz = this.market.config.timezone || 'Asia/Kolkata';
    
    logger.info(`Starting scheduler for market ${this.market.config.name} (Timezone: ${tz})`);
    
    // Dynamic scheduling based on market config
    if (this.market.config.id === 'IN') {
      new CronJob('30 6 * * 1-5', () => this.runPreMarket(), null, true, tz);
      new CronJob('15 9 * * 1-5', () => this.runFullCycle(), null, true, tz);
      new CronJob('30 15 * * 1-5', () => this.endOfDay(), null, true, tz);
      new CronJob('0 16 * * 1-5', () => this.runLearning(), null, true, tz);
    } else if (this.market.config.id === 'US') {
      new CronJob('0 4 * * 1-5', () => this.runPreMarket(), null, true, tz);
      new CronJob('30 9 * * 1-5', () => this.runFullCycle(), null, true, tz);
      new CronJob('0 16 * * 1-5', () => this.endOfDay(), null, true, tz);
      new CronJob('30 16 * * 1-5', () => this.runLearning(), null, true, tz);
    }
    
    logger.info(`Scheduler started - jobs scheduled for ${this.market.config.name}`);
  }

  // ============ MANUAL CONTROLS ============

  async manualSignal(symbol, direction, strategy = 'manual') {
    const currentPrice = this.getCurrentPrice(symbol) || this.getEstimatedPrice(symbol);
    const atr = currentPrice * 0.01;
    const slMult = config.trading.defaultStopLossAtrMult;
    const tpMult = config.trading.defaultTakeProfitAtrMult;
    
    let stopLoss, takeProfit;
    if (direction.toUpperCase() === 'LONG') {
      stopLoss = currentPrice - (atr * slMult);
      takeProfit = currentPrice + (atr * tpMult);
    } else {
      stopLoss = currentPrice + (atr * slMult);
      takeProfit = currentPrice - (atr * tpMult);
    }
    
    const riskReward = Math.abs(takeProfit - currentPrice) / Math.abs(currentPrice - stopLoss);
    
    const signal = {
      symbol,
      market: this.market.config.id,
      currency: this.market.config.currency,
      strategy: `manual_${strategy}`,
      direction: direction.toUpperCase(),
      entryPrice: currentPrice,
      stopLoss: parseFloat(stopLoss.toFixed(2)),
      takeProfit: parseFloat(takeProfit.toFixed(2)),
      riskReward: parseFloat(riskReward.toFixed(2)),
      confidence: 1,
      reason: `Manual signal [${this.market.config.id}]`,
      securityId: this.getSecurityId(symbol),
      segment: this.getSegment(symbol),
      exchangeSegment: this.getExchangeSegment(symbol),
      atr
    };
    
    return await executionEngine.executeSignal(signal, this.portfolio);
  }

  async manualClose(symbol) {
    return await executionEngine.closePosition(symbol);
  }

  getCurrentPrice(symbol) {
    const data = this.marketData.get(symbol);
    if (data?.candles?.length) {
      return data.candles[data.candles.length - 1].close;
    }
    return 0;
  }

  getEstimatedPrice(symbol) {
    const estimates = {
      'NIFTY': 24500, 'BANKNIFTY': 51000, 'FINNIFTY': 23000,
      'RELIANCE': 2900, 'HDFCBANK': 1600, 'ICICIBANK': 1100,
      'TCS': 4000, 'INFY': 1500, 'ITC': 450, 'AAPL': 225,
      'NVDA': 120, 'MSFT': 420, 'TSLA': 210, 'SPY': 550, 'QQQ': 480
    };
    return estimates[symbol] || 150;
  }

  getStatus() {
    return {
      market: this.market.config.id,
      marketName: this.market.config.name,
      currency: this.market.config.currencySymbol,
      isRunning: this.isRunning,
      paperTrading: config.trading.paperTrading,
      portfolio: this.portfolio,
      preMarketBias: this.preMarketBriefing?.marketBias?.bias,
      marketDataSymbols: this.marketData.size,
      openPositions: riskManager.openPositions.size,
      dailyPnL: riskManager.dailyPnL,
      dailyTrades: riskManager.dailyTrades
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = TradingOrchestrator;