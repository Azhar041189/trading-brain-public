const moment = require('moment-timezone');
const { createAgentLogger } = require('./logger');
const marketRegistry = require('./marketRegistry');
const riskManager = require('../agents/risk/riskManager');
const executionEngine = require('../agents/execution/executionEngine');
const momentumAgent = require('../agents/signal/momentumAgent');
const meanReversionAgent = require('../agents/signal/meanReversionAgent');
const preMarketAgent = require('../agents/research/preMarketAgent');
const learningAgent = require('../agents/learning/learningAgent');

const logger = createAgentLogger('AutonomousMesh');

/**
 * AutonomousMesh - Runs continuous, independent agent loops across all open markets.
 */
class AutonomousMesh {
  constructor() {
    this.isRunning = false;
    this.intervals = [];
    this.latestMarketData = new Map();
    this.activeBriefing = null;
    this.cycleCount = 0;
  }

  isMarketOpen(marketKey) {
    const market = marketRegistry.getMarket(marketKey);
    if (market.config.is24x7) return true;
    
    const tz = market.config.timezone || 'UTC';
    const now = moment().tz(tz);
    const day = now.day(); // 0 = Sun, 6 = Sat
    const timeStr = now.format('HH:mm');

    if (marketKey === 'US') {
      // US Equities (NYSE/NASDAQ Regular Hours): Mon-Fri 09:30 to 16:00 EST
      return day >= 1 && day <= 5 && timeStr >= '09:30' && timeStr <= '16:00';
    } else if (marketKey === 'IN') {
      // Indian Markets: Mon-Fri 09:15 to 15:30 IST
      return day >= 1 && day <= 5 && timeStr >= '09:15' && timeStr <= '15:30';
    } else if (marketKey === 'FOREX') {
      // Forex: Sun 17:00 to Fri 17:00 EST
      return (day === 0 && now.hour() >= 17) || (day >= 1 && day <= 4) || (day === 5 && now.hour() < 17);
    } else if (marketKey === 'FUTURES') {
      return day >= 1 && day <= 5;
    }
    return false;
  }

  getOpenMarkets() {
    const all = marketRegistry.listMarkets();
    return all.filter(m => this.isMarketOpen(m));
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Autonomous mesh is already running');
      return;
    }

    this.isRunning = true;
    logger.info('🚀 Starting Autonomous Multi-Agent Trading Mesh...');

    await riskManager.initialize();
    await executionEngine.initialize();

    // 1. Initial Research Pulse
    await this.runResearchLoop();

    // 2. Loop A: Fast Market Data Poller (Every 10s with concurrency lock to prevent OOM/CPU lock)
    let isIngesting = false;
    this.intervals.push(setInterval(async () => {
      if (isIngesting) return;
      isIngesting = true;
      try {
        await this.runDataIngestionLoop();
      } finally {
        isIngesting = false;
      }
    }, 10000));

    // 3. Loop B: Signal & Execution Loop (Every 15s with concurrency lock)
    let isEvaluating = false;
    this.intervals.push(setInterval(async () => {
      if (isEvaluating) return;
      isEvaluating = true;
      try {
        await this.runSignalAndExecutionLoop();
      } finally {
        isEvaluating = false;
      }
    }, 15000));

    // 4. Loop C: Research & Macro Pulse (Every 15 minutes)
    this.intervals.push(setInterval(() => this.runResearchLoop(), 15 * 60 * 1000));

    // 5. Loop D: Learning & Recalibration Loop (Every 1 hour)
    this.intervals.push(setInterval(() => this.runLearningLoop(), 60 * 60 * 1000));

    // 6. Loop E: Daily Dhan Forever GTT 300-Day Expiry Sentinel (Runs every 24 hours at 09:00 AM IST pre-market)
    this.intervals.push(setInterval(async () => {
      try {
        const dhan = require('../tools/dhanClient');
        const openOrders = await dhan.getOrders().catch(() => []);
        const gttOrders = (openOrders.data || []).filter(o => o.orderType === 'FOREVER' || o.drvOptionType === 'GTT');
        await dhan.checkAndRenewExpiringGTTs(gttOrders);
      } catch (err) {
        logger.warn('Daily GTT renewal check note:', { error: err.message });
      }
    }, 24 * 60 * 60 * 1000));

    // Trigger first pass immediately
    await this.runDataIngestionLoop();
    await this.runSignalAndExecutionLoop();

    logger.info('✅ Autonomous Multi-Agent Mesh is active across all open global venues');
  }

  pauseMesh(reason = 'MANUAL_PAUSE') {
    this.isPaused = true;
    logger.warn(`⏸️ [Autonomous Mesh] Mesh paused: ${reason}. New signal execution halted.`);
  }

  resumeMesh(reason = 'MANUAL_RESUME') {
    this.isPaused = false;
    logger.info(`▶️ [Autonomous Mesh] Mesh resumed: ${reason}. Signal scanning active.`);
  }

  async stop() {
    this.isRunning = false;
    this.isPaused = false;
    this.intervals.forEach(i => clearInterval(i));
    this.intervals = [];
    logger.info('🛑 Autonomous mesh stopped');
  }

  async runResearchLoop() {
    try {
      logger.info('🧠 [Research Agent] Conducting macro & cross-market research pulse...');
      this.activeBriefing = await preMarketAgent.run();
    } catch (e) {
      logger.warn('Research pulse note:', { error: e.message });
    }
  }

  async runDataIngestionLoop() {
    const openMarkets = this.getOpenMarkets();
    for (const marketKey of openMarkets) {
      try {
        const market = marketRegistry.getMarket(marketKey);
        const watchlist = market.config.defaultWatchlist || [];
        for (const symbol of watchlist.slice(0, 20)) {
          // 1. Fetch 5m micro candles
          const candles5m = await market.dataProvider.fetchCandles(symbol, '5m', '1d');
          // 2. Fetch 1h macro candles for Multi-Timeframe (MTF) trend confirmation
          const candles1h = await market.dataProvider.fetchCandles(symbol, '1h', '5d');

          if (candles5m && candles5m.length > 0) {
            const key = `${marketKey}:${symbol}`;
            const latestCandle = candles5m[candles5m.length - 1];
            this.latestMarketData.set(key, { 
              symbol, 
              market: marketKey, 
              candles: candles5m,
              htfCandles: candles1h 
            });

            // Mark-to-market open positions and trigger Dynamic Auto-Exit Sentinel
            const pos = riskManager.updateMarkToMarket(symbol, latestCandle.close) || riskManager.openPositions.get(symbol);
            if (pos && latestCandle) {
              const isLong = pos.side === 'LONG' || pos.side === 'BUY';
              const cur = parseFloat(pos.currentPrice || latestCandle.close);
              const entry = parseFloat(pos.avgPrice || pos.avg_price || pos.entryPrice || cur);
              const profitPct = pos.pnl_pct !== undefined ? pos.pnl_pct : (entry > 0 ? (isLong ? ((cur - entry) / entry) * 100 : ((entry - cur) / entry) * 100) : 0);

            const minTakeProfitPct = (marketKey === 'IN' || pos.market === 'IN') ? 0.90 : 1.25; // Require +1.25% minimum target on crypto, +0.90% for India
            
            // 0. Intraday Auto-Square-Off Safety Sentinel (3:15 PM IST Indian Market Closeout)
            const moment = require('moment-timezone');
            const istNow = moment().tz('Asia/Kolkata');
            const istTime = istNow.format('HH:mm');
            const isDeliveryETF = ['GOLDBEES', 'SILVERBEES', 'NIFTYBEES', 'BANKBEES', 'ITBEES', 'LIQUIDBEES'].includes(pos.symbol);
            const isIndianIntradayCloseTime = (pos.market === 'IN' || marketKey === 'IN') && !isDeliveryETF && (istNow.day() >= 1 && istNow.day() <= 5) && (istTime >= '15:15' && istTime <= '15:30');

            if (isIndianIntradayCloseTime) {
              logger.info(`⏱️ [Intraday Auto-Square-Off 3:15 PM IST] Closing Indian MIS position ${pos.symbol} @ ₹${cur} to prevent broker penalty`);
              executionEngine.closePosition(pos.symbol, pos.segment, pos.quantity, cur, 'INTRADAY_315PM_SQUARE_OFF');
              alertGateway.notifyAutoExit({ ...pos, currentPrice: cur, exitPrice: cur }, 'INTRADAY_315PM_SQUARE_OFF');
            }
            // 1. Take Profit Trigger: High-Asymmetric (+1.25% for Crypto, +0.90% for India)
            else if (profitPct >= minTakeProfitPct && (pos.takeProfit && pos.takeProfit > 0 ? (isLong ? cur >= pos.takeProfit : cur <= pos.takeProfit) : true)) {
              logger.info(`🎯 [Auto-Exit Sentinel: TAKE PROFIT] Closing ${pos.symbol} in solid profit (+${profitPct.toFixed(2)}%, +$${pos.unrealizedPnL.toFixed(2)})`);
              executionEngine.closePosition(pos.symbol, pos.segment, pos.quantity, cur, 'AUTO_TAKE_PROFIT');
              alertGateway.notifyAutoExit({ ...pos, currentPrice: cur, exitPrice: cur }, 'TAKE_PROFIT');
            }
            // 2. Trailing Stop / Stop Loss Trigger
            else if (pos.stopLoss && (isLong ? cur <= pos.stopLoss : cur >= pos.stopLoss)) {
              logger.info(`🛡️ [Auto-Exit Sentinel: STOP LOSS] Closing ${pos.symbol} at protected stop ($${cur})`);
              executionEngine.closePosition(pos.symbol, pos.segment, pos.quantity, cur, 'AUTO_STOP_LOSS');
              alertGateway.notifyAutoExit({ ...pos, currentPrice: cur, exitPrice: cur }, 'STOP_LOSS');
            }
                          // 3. Counter-Trend Bear/Bull Regime Force-Exit (Stops bleeding in trending markets)
                          else {
                            try {
                              const regimeClassifier = require('./regimeClassifier');
                              const reg = regimeClassifier.classify(pos.symbol, item?.candles || []);
                              if ((reg.regime === 'TRENDING_BEAR' || reg.regime === 'VOLATILE_CRASH') && isLong) {
                                logger.info(`🛑 [Regime Exit Sentinel] Force-closing counter-trend LONG on ${pos.symbol} (${reg.regime} Active - Freeing Capital for SHORTs)`);
                                executionEngine.closePosition(pos.symbol, pos.segment, pos.quantity, cur, 'REGIME_CHANGE_EXIT');
                                alertGateway.notifyAutoExit({ ...pos, currentPrice: cur, exitPrice: cur }, 'REGIME_CHANGE_EXIT');
                              } else if (reg.regime === 'TRENDING_BULL' && !isLong) {
                                logger.info(`🛑 [Regime Exit Sentinel] Force-closing counter-trend SHORT on ${pos.symbol} (TRENDING_BULL Active - Freeing Capital for LONGs)`);
                                executionEngine.closePosition(pos.symbol, pos.segment, pos.quantity, cur, 'REGIME_CHANGE_EXIT');
                                alertGateway.notifyAutoExit({ ...pos, currentPrice: cur, exitPrice: cur }, 'REGIME_CHANGE_EXIT');
                              }
                            } catch (e) {}
                          }
                        }
                      }
        }

        // Run continuous trailing stop & breakeven ratchet with full live candle context
        const quotesMap = new Map();
        const candlesMap = new Map();
        for (const [k, v] of this.latestMarketData.entries()) {
          if (v.candles && v.candles.length > 0) {
            quotesMap.set(v.symbol, v.candles[v.candles.length - 1].close);
            candlesMap.set(v.symbol, v.candles);
          }
        }
        await executionEngine.updateTrailingStopsAndBreakeven(quotesMap, candlesMap);

        // Run partial profit scale-out and dynamic breakeven evaluator
        try {
          const scaleOutEngine = require('./scaleOutEngine');
          const soInstance = new scaleOutEngine();
          await soInstance.evaluateOpenPositions(marketKey);
        } catch (e) {}
      } catch (e) {}
    }
  }

  async runSignalAndExecutionLoop() {
    if (this.isPaused) {
      return;
    }
    const openMarkets = this.getOpenMarkets();
    this.cycleCount++;

    logger.info(`⚡ [Autonomous Signal Pulse #${this.cycleCount}] Scanning open venues: [${openMarkets.join(', ')}]`);

    for (const marketKey of openMarkets) {
      try {
        const market = marketRegistry.getMarket(marketKey);
        const marketDataSubset = new Map();

        for (const [key, val] of this.latestMarketData.entries()) {
          if (val.market === marketKey) {
            marketDataSubset.set(val.symbol, val);
          }
        }

        if (marketDataSubset.size === 0) continue;

        // 1. Classify Market Benchmark Regime from real live candles per venue
        try {
          const regimeClassifier = require('./regimeClassifier');
          const benchmarkSymbol = marketKey === 'CRYPTO' ? 'BTCUSDT' : (marketKey === 'US' ? 'SPY' : (marketKey === 'IN' ? 'NIFTY' : (marketKey === 'FOREX' ? 'EURUSD=X' : 'ES=F')));
          const benchmarkItem = marketDataSubset.get(benchmarkSymbol) || Array.from(marketDataSubset.values())[0];
          if (benchmarkItem && benchmarkItem.candles) {
            const oldRegime = regimeClassifier.getRegimeForMarket(marketKey);
            regimeClassifier.classify(benchmarkItem.symbol, benchmarkItem.candles, marketKey);
            const newRegime = regimeClassifier.getRegimeForMarket(marketKey);
            
            // Notify on regime shift
            if (oldRegime !== newRegime) {
              logger.info(`🔄 [Regime Shift: ${marketKey}] ${oldRegime} → ${newRegime} (${benchmarkItem.symbol})`);
              alertGateway.notifyRegimeShift(oldRegime, newRegime, `${marketKey}:${benchmarkItem.symbol}`);
            }
          }
        } catch (e) {}

        // Run Independent Signal Agents & 5.0 Alpha Engines with venue-specific regime context
        const [momSignals, mrSignals] = await Promise.all([
          momentumAgent.generateSignals(marketDataSubset, this.activeBriefing, marketKey),
          meanReversionAgent.generateSignals(marketDataSubset, this.activeBriefing, marketKey)
        ]);

        const rawSignals = [...(momSignals || []), ...(mrSignals || [])];

        // Fuse High-Conviction Quant Alpha Engines (SMC Order Blocks, DEX-CEX Arb, Pairs Z-Score)
        try {
          const smartMoney = require('./smartMoneyEngine');
          for (const [sym, item] of marketDataSubset.entries()) {
            if (item.candles && item.candles.length >= 15) {
              const smcAnalysis = smartMoney.analyzeSMC(sym, item.candles);
              if (smcAnalysis.direction !== 'NEUTRAL' && smcAnalysis.confidence >= 0.70) {
                const curPrice = item.candles[item.candles.length - 1].close;
                const isLong = smcAnalysis.direction === 'LONG';
                const atrEst = curPrice * 0.006;
                rawSignals.push({
                  symbol: sym,
                  direction: isLong ? 'LONG' : 'SHORT',
                  entryPrice: curPrice,
                  stopLoss: isLong ? curPrice - (atrEst * 1.5) : curPrice + (atrEst * 1.5),
                  takeProfit: isLong ? curPrice + (atrEst * 3.0) : curPrice - (atrEst * 3.0),
                  riskReward: 2.0,
                  confidence: smcAnalysis.confidence,
                  strategy: 'smc_order_block_fvg_alpha',
                  reason: `SMC ${isLong ? 'Bullish' : 'Bearish'} OB/FVG detected at ${curPrice.toFixed(2)} (${(smcAnalysis.confidence * 100).toFixed(0)}% conf)`,
                  boundaryValidated: false,
                  smcDetails: smcAnalysis
                });
              }
            }
          }
        } catch (e) {}

        // Fuse Helix Lucky MTF (Multi-Timeframe 1h -> 15m -> 5m) Confluence Alpha
        try {
          const helixEngine = require('./helixLuckyMtfEngine');
          for (const [sym, item] of marketDataSubset.entries()) {
            if (item.candles && item.candles.length >= 25) {
              const helixSignal = helixEngine.analyzeConfluence(sym, item.candles);
              if (helixSignal && helixSignal.valid && helixSignal.confidence >= 0.75) {
                rawSignals.push({
                  symbol: sym,
                  direction: helixSignal.direction,
                  entryPrice: helixSignal.entryPrice,
                  stopLoss: helixSignal.stopLoss,
                  takeProfit: helixSignal.takeProfit,
                  riskReward: helixSignal.riskReward || 2.5,
                  confidence: helixSignal.confidence,
                  strategy: 'helix_lucky_mtf_alpha',
                  reason: helixSignal.reason,
                  boundaryValidated: true,
                  helixDetails: helixSignal.confluenceDetails
                });
              }
            }
          }
        } catch (e) {}

        // Candidate Alpha Evaluator: GainzAlgo V2 (Telemetry / Shadow Logging Only — Zero Active Contamination)
        try {
          const GainzAlgoV2AlphaEngine = require('./gainzAlgoV2AlphaEngine');
          const gainzEngine = new GainzAlgoV2AlphaEngine();
          for (const [sym, item] of marketDataSubset.entries()) {
            if (item.candles && item.candles.length >= 20) {
              const gSignal = gainzEngine.evaluate(sym, item.candles, marketKey);
              if (gSignal && gSignal.hasSignal && gSignal.confidence >= 0.78) {
                // Log candidate telemetry without contaminating active v14.0 Challenger trade mesh
                logger.debug(`🔬 [Candidate Alpha Log] GainzAlgo V2: ${sym} ${gSignal.action} @ ${gSignal.price} (Confidence: ${(gSignal.confidence*100).toFixed(0)}%) [ISOLATED]`);
              }
            }
          }
        } catch (e) {}

        // 3. Autonomous Visual Strategy Studio Rule Evaluator & Auto-Deployer
        try {
          const visualStrategyEngine = require('./visualStrategyEngine');
          for (const [sym, item] of marketDataSubset.entries()) {
            if (item.candles && item.candles.length >= 25) {
              const activeRule = {
                name: 'Auto-Synthesized RSI Momentum Spike',
                direction: 'LONG',
                entryConditions: [
                  { indicator: 'RSI', operator: '<', threshold: 42 },
                  { indicator: 'VOLUME_SPIKE', operator: '>', threshold: 1.15 }
                ],
                stopLossPct: 1.2,
                takeProfitPct: 2.8
              };
              const bt = visualStrategyEngine.backtestVisualStrategy(activeRule, item.candles);
              const winRateNum = parseFloat(bt.winRate) || 0;
              if (winRateNum >= 55.0) {
                const c = item.candles[item.candles.length - 1];
                const prev = item.candles[item.candles.length - 2];
                const entryTriggered = (activeRule.entryConditions || []).every(b => visualStrategyEngine.evaluateCondition(c, prev, b));
                if (entryTriggered) {
                  rawSignals.push({
                    symbol: sym,
                    direction: 'LONG',
                    entryPrice: c.close,
                    stopLoss: c.close * 0.988,
                    takeProfit: c.close * 1.028,
                    riskReward: 2.33,
                    confidence: Math.min(0.92, (winRateNum / 100) + 0.15),
                    strategy: 'visual_studio_auto_alpha',
                    reason: `Autonomous Visual Rule [RSI < 42 & Vol > 1.15x] Triggered (Backtested WR: ${bt.winRate}, PF: ${bt.profitFactor}x)`
                  });
                }
              }
            }
          }
        } catch (e) {}

        // 4. Autonomous Options Multi-Leg Hedging & 70% Margin Optimizer
        try {
          const optionsMultiLegEngine = require('./optionsMultiLegEngine');
          const regimeClassifier = require('./regimeClassifier');
          const currentRegime = regimeClassifier.getRegimeForMarket(marketKey);
          
          if (['IN', 'US', 'CRYPTO'].includes(marketKey)) {
            const optSym = marketKey === 'IN' ? 'NIFTY' : (marketKey === 'US' ? 'SPY' : 'BTCUSDT');
            const item = marketDataSubset.get(optSym) || Array.from(marketDataSubset.values())[0];
            if (item && item.candles && item.candles.length > 5) {
              const curP = item.candles[item.candles.length - 1].close;
              let selectedStrat = 'IRON_CONDOR';
              
              if (currentRegime === 'TRENDING_BULL' || currentRegime === 'BULLISH_EXPANSION') {
                selectedStrat = 'BULL_PUT_SPREAD';
              } else if (currentRegime === 'TRENDING_BEAR') {
                selectedStrat = 'BEAR_CALL_SPREAD';
              } else if (currentRegime === 'HIGH_VOLATILITY_PANIC') {
                selectedStrat = 'LONG_STRADDLE';
              }

              const multiLeg = optionsMultiLegEngine.buildStrategy(selectedStrat, curP, curP, 50, 50, marketKey === 'IN' ? '₹' : '$');
              if (multiLeg.success) {
                logger.debug(`🦅 [Auto Options Slicer] ${marketKey} Regime ${currentRegime} -> Auto-Structured ${multiLeg.name} (Hedge Margin: ${multiLeg.metrics.marginReliefPct})`);
              }
            }
          }
        } catch (e) {}

        // Filter and Vet through Sentiment Sentinel & Multi-Agent Consensus Veto Committee
        const consensusEngine = require('./consensusEngine');
        const newsSentiment = require('./newsSentimentSentinel');
        const hermesDebate = require('./hermesDebateEngine');
        const tauricFundamentals = require('./tauricFundamentalAgent');
        const drlEngine = require('./drlActorCriticEngine');
        const ppoEngine = require('./drlPPOEngine');
        const metaLearning = require('./metaLearningEngine');
        const vpinEngine = require('./vpinEngine');
        const darkPoolHunter = require('./darkPoolWhaleHunter');
        const trapPredictor = require('./liquidityTrapPredictor');
        const advHardener = require('./adversarialTrainingEngine');
        const alertGateway = require('./alertGateway');
        const approvedSignals = [];

        // Adaptive Capital Tier Strategy Router Check
        const adaptiveRouter = require('./adaptiveCapitalStrategyRouter');
        const sessionStore = require('./sessionStateStore');
        const chartContextHypothesis = require('../agents/hypothesis/chartContextHypothesisModule');
        const currentCompoundedEquity = sessionStore.getState().compoundedEquity || (marketKey === 'IN' ? 500 : 10);

        for (const sig of rawSignals) {
          // 0. Adaptive Capital Tier & Fee-Aware Decision Gate
          const tierCheck = adaptiveRouter.evaluateTradeSuitability(sig, marketKey, currentCompoundedEquity);
          if (!tierCheck.allowed) {
            continue;
          }

          // 0.5. Institutional Chart Context, Market Structure & Volume Profile Gate (Candidate Alpha Engine)
          const item = marketDataSubset.get(sig.symbol);
          if (item?.candles && item.candles.length >= 20) {
            const chartEval = chartContextHypothesis.evaluateEvidence(
              { symbol: sig.symbol, direction: sig.direction, price: sig.entryPrice || item.candles[item.candles.length - 1].close },
              item.candles,
              marketKey,
              { vwap: true, volumeProfile: true, marketStructure: true, rvol: true }
            );

            if (!chartEval.hypothesisApproval) {
              const scoreVal = chartEval.evidenceScore !== undefined ? chartEval.evidenceScore.toFixed(2) : '0.00';
              logger.warn(`🛑 [Chart Context Veto] Blocked ${sig.direction} on ${sig.symbol}: Institutional flow misalignment (Score: ${scoreVal}, Detractors: ${(chartEval.detractors || []).join('; ')})`);
              continue;
            }

            // Apply institutional confidence modifier
            sig.confidence = Math.max(0.65, Math.min(0.98, (sig.confidence || 0.75) + (chartEval.confidenceModifier || 0)));
            sig.chartContextDetails = {
              score: chartEval.evidenceScore,
              confluences: chartEval.confluences,
              detractors: chartEval.detractors
            };
          }

          // Get PER-SYMBOL regime for accurate regime guard
          const regimeClassifier = require('./regimeClassifier');
          const symbolRegime = item?.candles && item.candles.length >= 15
            ? regimeClassifier.classify(sig.symbol, item.candles).regime
            : regimeClassifier.getRegimeForMarket(marketKey);
          const activeMarketRegime = symbolRegime;

          // 1. Strict Regime Guard for RANGING_CHOPPY & CONSOLIDATION
          if (activeMarketRegime === 'RANGING_CHOPPY' || activeMarketRegime === 'CONSOLIDATION' || activeMarketRegime === 'LOW_VOLATILITY') {
            const stratName = (sig.strategy || '').toLowerCase();
            const isMomentumOrSynth = stratName.includes('momentum') || stratName.includes('breakout') || stratName.includes('autonomous');
            
            // Block momentum-based synthesized or breakout signals in chop
            if (isMomentumOrSynth && !sig.boundaryValidated) {
              logger.warn(`🛡️ [Autonomous Regime Gate] Blocked unvalidated momentum/synth trade ${sig.direction} on ${sig.symbol} in ${activeMarketRegime} regime`);
              continue;
            }
            
            // Also block SMC signals in chop unless boundary validated
            if (stratName.includes('smc') && !sig.boundaryValidated) {
              logger.warn(`🛡️ [Autonomous Regime Gate] Blocked unvalidated SMC trade ${sig.direction} on ${sig.symbol} in ${activeMarketRegime} regime`);
              continue;
            }

            // Enforce 50% sizing cut on all approved chop signals
            if (sig.quantity && sig.quantity > 1) {
              sig.quantity = Math.max(1, Math.floor(sig.quantity * 0.5));
            }
          }

          // 1. News sentiment circuit breaker check
          const sentimentCheck = newsSentiment.evaluateSentiment(sig.symbol);
          if (!sentimentCheck.canTrade) {
            logger.warn(`⛔ [News Veto] Trade on ${sig.symbol} blocked due to negative sentiment event`);
            alertGateway.notifyCircuitBreaker(sig.symbol, 'Extreme negative news sentiment detected', 'HIGH');
            continue;
          }

          // 2. Tauric Fundamental valuation analysis
          const fundamentalInsight = await tauricFundamentals.evaluateFundamentals(sig.symbol, marketKey);
          sig.fundamentalInsight = fundamentalInsight;

          // 2b. Range Boundary Validation Check
          if (item?.candles && item.candles.length >= 20) {
            const highs = item.candles.map(c => c.high).slice(-20);
            const lows = item.candles.map(c => c.low).slice(-20);
            const rHigh = Math.max(...highs);
            const rLow = Math.min(...lows);
            const currClose = item.candles[item.candles.length - 1].close;

            if (activeMarketRegime === 'RANGING_CHOPPY' || activeMarketRegime === 'CONSOLIDATION') {
              if (sig.direction === 'SHORT' && currClose < (rHigh * 0.985)) {
                // Shorting below the upper 1.5% of range in chop is a breakdown chase trap!
                logger.warn(`⛔ [Boundary Gate] Rejected SHORT on ${sig.symbol} @ ${currClose} (Range High: ${rHigh}) — Breakdown Chase Trap!`);
                continue;
              }
              if (sig.direction === 'LONG' && currClose > (rLow * 1.015)) {
                // Buying above lower 1.5% of range in chop is a bounce chase trap!
                logger.warn(`⛔ [Boundary Gate] Rejected LONG on ${sig.symbol} @ ${currClose} (Range Low: ${rLow}) — Bounce Chase Trap!`);
                continue;
              }
            }
          }

          // 3. Liquidity Trap & Stop-Hunt Check
          const trapCheck = trapPredictor.evaluateTrapRisk(item?.candles || []);
          if (trapCheck.isTrap) {
            if ((sig.direction === 'LONG' && trapCheck.trapType === 'BULL_TRAP_SWEEP') ||
                (sig.direction === 'SHORT' && trapCheck.trapType === 'BEAR_TRAP_SWEEP')) {
              logger.warn(`🪤 [Trap Veto] Rejected ${sig.direction} on ${sig.symbol} due to ${trapCheck.trapType}`);
              continue;
            }
          }

          // 4. Regime Classifier & Meta-Learning Adaptive Sizing
          const marketRegime = regimeClassifier.classify(sig.symbol);
          sig.regime = marketRegime.regime;

          if (item?.candles) {
            advHardener.hardenDRLPolicy(drlEngine, item.candles);
            const dState = drlEngine.extractState(item.candles);
            const ppoPolicy = ppoEngine.evaluateDeepPolicy(dState);
            const metaParams = metaLearning.adaptFewShot(item.candles, this.activeBriefing?.bias?.bias);
            sig.drlPolicy = ppoPolicy;
            sig.metaParameters = metaParams;

            // Regime-adaptive targets & confidence
            if (marketRegime.regime === 'TRENDING_BULL' || marketRegime.regime === 'TRENDING_BEAR') {
              sig.riskReward = 3.0;
              sig.confidence = Math.min(0.95, (sig.confidence || 0.75) * 1.15);
            } else if (marketRegime.regime === 'VOLATILE_CRASH') {
              sig.riskReward = 1.5;
              sig.confidence = (sig.confidence || 0.75) * 0.70;
            }
          }

          // 4.5. Institutional Strategy Health & Lifecycle Gate
          try {
            const strategySentinel = require('./strategyHealthSentinel');
            const stratEvaluation = strategySentinel.evaluateAllStrategies(marketRegime.regime);
            const approvedStrategies = strategySentinel.filterApprovedStrategiesForRegime(marketRegime.regime);
            
            // If strategy is paused due to regime misfit (e.g. Mean Reversion in Trending Bull), block execution
            const matchingStrat = stratEvaluation.strategies?.find(s => 
              sig.strategy && s.id.toLowerCase().includes(sig.strategy.toLowerCase().split('_')[0])
            );

            if (matchingStrat && matchingStrat.lifecycleStage.includes('PAUSED')) {
              logger.warn(`🛑 [Strategy Health Gate] Blocked ${sig.symbol} entry for ${matchingStrat.name} (Lifecycle: ${matchingStrat.lifecycleStage} | Health: ${matchingStrat.healthScore}/100)`);
              continue;
            }
          } catch (e) {}

          // 5. Macro 1-Hour Trend Direction Gate (Symmetrical Two-Way Execution)
          if (item?.htfCandles && item.htfCandles.length > 5) {
            const htfCloses = item.htfCandles.map(c => c.close);
            const htfTrendUp = htfCloses[htfCloses.length - 1] > htfCloses[htfCloses.length - 5];
            const isLong = sig.direction === 'LONG';

            // If macro 1H trend is DOWN, strictly BLOCK dip-buying counter-trend LONGs
            if (isLong && !htfTrendUp) {
              logger.warn(`⛔ [Macro 1H Trend Gate] Blocked counter-trend LONG on ${sig.symbol} (1H Downtrend Active - Catching Knife Prevented)`);
              continue;
            }
            // If macro 1H trend is DOWN and signal is SHORT, boost confidence for trend-following short
            if (!isLong && !htfTrendUp) {
              sig.confidence = Math.min(0.95, (sig.confidence || 0.75) * 1.25);
              const baseReason = sig.reason || sig.strategy?.replace(/_/g, ' ') || 'Alpha Signal';
              sig.reason = `${baseReason} | [1H Trend Breakdown Confirmed]`;
            }
          }

          // 6. Dark Pool & VPIN Order Flow Gate
          const vpinCheck = vpinEngine.calculateVPIN(item?.candles || []);
          if (vpinCheck.toxicityRegime === 'HIGH_TOXICITY_ALERT') {
            logger.warn(`⛔ [VPIN Gate Block] Rejected ${sig.symbol} entry due to high toxic order flow`);
            continue;
          }

          // 6.5. Session Edge Profiler Range Saturation Gate (Flux Charts Edge)
          try {
            const sessionProfiler = require('./sessionEdgeProfiler');
            const sessionData = sessionProfiler.profile(sig.symbol, item?.candles || [], marketKey);
            if (sessionData.activeSession?.isExtremeExpansion) {
              // Range > 90th percentile: penalize breakout chasing, reduce risk sizing
              sig.confidence = Math.max(0.60, (sig.confidence || 0.75) * 0.85);
              const baseReason = sig.reason || sig.strategy?.replace(/_/g, ' ') || 'Alpha Signal';
              sig.reason = `${baseReason} | [${sessionData.activeSession.name} 90th %ile Saturation Alert]`;
              logger.info(`🕒 [Session Edge Gate] ${sig.symbol} detected in ${sessionData.activeSession.name} (${sessionData.activeSession.todayPercentile}th %ile range). Tactical warning applied.`);
            }
          } catch (e) {}
          // 7. Options Chain & Volume Shocker Context
          let optionsAnalysis = null;
          let volumeShocker = null;
          if (marketKey === 'IN') {
            try {
              const optionsEngine = require('./dhanOptionsChainEngine');
              const marketScanner = require('./marketActionScanner');
              const latestPrice = item?.candles?.[item.candles.length - 1]?.close || 24366.0;
              optionsAnalysis = optionsEngine.analyzeOptionsChain(sig.symbol, latestPrice);
              const marketAction = marketScanner.scanMarketAction();
              volumeShocker = marketAction.volumeShockers.find(s => s.symbol === sig.symbol);
            } catch (e) {}
          }

          // 8. Consensus Committee Vetting
          const consensusResult = consensusEngine.evaluate(sig, {
            macroBriefing: this.activeBriefing,
            htfCandles: item?.htfCandles,
            optionsAnalysis,
            volumeShocker
          });

          // 9. Conduct Hermes Multi-Agent Debate with Deep PPO & VPIN insights
          hermesDebate.conductDebate(sig, item, this.activeBriefing);

          if (consensusResult.approved) {
            sig.confidence = consensusResult.compositeScore;
            sig.consensusVotes = consensusResult.votes;
            approvedSignals.push(sig);
          }
        }

        // Broadcast active signals and debates to dashboard
        try {
          const dashboardServer = require('../dashboard/server');
          const broadcastList = approvedSignals.length > 0 ? approvedSignals : rawSignals.slice(0, 3);
          broadcastList.forEach(sig => dashboardServer.broadcast('signal', sig));
          dashboardServer.broadcast('debate', { status: 'UPDATE' });
        } catch (e) {}

        if (approvedSignals.length > 0) {
          logger.info(`🎯 [Consensus Committee] Approved ${approvedSignals.length}/${rawSignals.length} high-confidence signals for ${marketKey}`, {
            approved: approvedSignals.map(s => `${s.direction} ${s.symbol} (${(s.confidence * 100).toFixed(0)}% Conf)`)
          });

          // 10. Autonomous L3 Microstructure Execution Routing (Maker vs Taker Queue Resolver)
          const l3Simulator = require('./l3DepthReplaySimulator');
          for (const s of approvedSignals) {
            const snap = l3Simulator.generateL3Snapshot(s.symbol, s.entryPrice || 24000);
            const simRes = l3Simulator.simulatePassiveExecution(s.direction === 'LONG' ? 'BUY' : 'SELL', s.entryPrice || 24000, s.quantity || 1, snap);
            s.routingMode = simRes.executionRecommendation || 'FAVOR_PASSIVE_MAKER';
            s.queuePositionAhead = simRes.queuePositionAhead || 0;
            s.fillProbability = simRes.fillProbabilityPct || '88%';
            logger.debug(`⚡ [L3 Routing Resolver] ${s.symbol} ${s.direction} -> Mode: ${s.routingMode} (Queue: ${s.queuePositionAhead} ahead, Fill: ${s.fillProbability})`);
          }

          // Execute via Risk Sentinel using actual live compounded equity ($6,902+)
          const compoundingEngine = require('./compoundingEngine');
          const sessionStore = require('./sessionStateStore');
          const liveCompoundedEquity = compoundingEngine.getCompoundedEquity() || sessionStore.getState().compoundedEquity || (marketKey === 'IN' ? 500 : 10);
          const activeCapital = (marketKey === 'IN') ? (sessionStore.getState().inEquity || 500) : liveCompoundedEquity;
          const leverage = (marketKey === 'IN' || marketKey === 'US') ? 4 : 2;
          const results = await executionEngine.executeMultipleSignals(approvedSignals, {
            totalCapital: activeCapital,
            availableMargin: activeCapital * leverage,
            availableCash: activeCapital
          });

          const executed = results.filter(r => r.success).length;
          if (executed > 0) {
            logger.info(`✅ [Execution Engine] Executed ${executed} paper trades autonomously in ${marketKey}`);
            
            // Dispatch Multi-Channel Alerts for each successfully executed trade
            results.forEach((res, i) => {
              if (res.success) {
                const s = approvedSignals[i] || {};
                const execDetails = {
                  ...s,
                  market: marketKey,
                  quantity: res.filledQuantity || s.quantity || 1,
                  entryPrice: res.averagePrice || s.entryPrice || 0
                };
                alertGateway.notifyHermesEntryCleared(execDetails);
                alertGateway.notifyTradeExecuted(execDetails);
              }
            });

            try {
              const dashboardServer = require('../dashboard/server');
              const positions = await executionEngine.getCurrentPositions();
              positions.forEach(p => dashboardServer.broadcast('position', p));

              // Trading Brain 8.0: Broadcast snapshot to Supabase Distributed Real-Time Hub
              const stateHub = require('./realtimeStateHub');
              stateHub.broadcastState();
            } catch (e) {}
          }
        }

        // 10. Institutional Scale-Out & Trailing Breakeven Engine Evaluation
        try {
          const scaleOutEngine = require('./scaleOutEngine');
          await scaleOutEngine.evaluateOpenPositions(marketKey);
        } catch (e) {}

        // Periodic Cluster State Sync
        try {
          const stateHub = require('./realtimeStateHub');
          stateHub.broadcastState();
        } catch (e) {}
      } catch (e) {
        logger.warn(`Signal loop note for ${marketKey}:`, { error: e.message });
      }
    }
  }

  async runLearningLoop() {
    try {
      logger.info('📊 [Learning Agent] Autonomous performance review & parameter recalibration...');
      await learningAgent.runDailyReview();
    } catch (e) {}
  }
}

module.exports = new AutonomousMesh();
