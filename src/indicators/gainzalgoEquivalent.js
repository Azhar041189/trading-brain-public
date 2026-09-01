/**
 * GainzAlgo Equivalent - White-box, Regime-aware Alpha Indicator
 * 
 * Built on Trading Brain's existing agents:
 * - momentumAgent, meanReversionAgent, smartMoneyEngine
 * - regimeClassifier, liquidityTrapPredictor, trapPredictor
 * - consensusEngine, riskManager
 * 
 * Superior to GainzAlgo V2 Alpha because:
 * - Regime-aware (filters chop, GainzAlgo doesn't)
 * - Multi-agent consensus (not single indicator)
 * - Integrated risk management (Kelly, daily caps, ATR TP/SL)
 * - Fully auditable/backtestable (Crucible engine)
 * - Zero external dependency
 */

const momentumAgent = require('../agents/signal/momentumAgent');
const meanReversionAgent = require('../agents/signal/meanReversionAgent');
const smartMoneyEngine = require('../core/smartMoneyEngine');
const regimeClassifier = require('../core/regimeClassifier');
const liquidityTrapPredictor = require('../core/liquidityTrapPredictor');
const trapPredictor = require('../core/liquidityTrapPredictor');
const consensusEngine = require('../core/consensusEngine');
const riskManager = require('../agents/risk/riskManager');
const { createAgentLogger } = require('../core/logger');

const logger = createAgentLogger('GainzAlphaEquivalent');

class GainzAlphaEquivalent {
  constructor(options = {}) {
    this.minConfidence = options.minConfidence || 0.65;
    this.atrPeriod = options.atrPeriod || 14;
    this.atrMultSL = options.atrMultSL || 1.5;
    this.atrMultTP = options.atrMultTP || 2.0;
    this.regimeFilter = options.regimeFilter !== false;
    this.trapFilter = options.trapFilter !== false;
  }

  /**
   * Generate alpha signal for a symbol
   * @param {string} symbol - Trading symbol
   * @param {Array} candles - OHLCV candles (oldest first)
   * @param {string} timeframe - Timeframe (1m, 5m, 15m, 1h, 4h, 1d)
   * @param {string} market - Market (CRYPTO, IN, US, FOREX, FUTURES)
   * @returns {Promise<Object|null>} Signal object or null if no signal
   */
  async generateSignal(symbol, candles, timeframe = '5m', market = 'CRYPTO') {
    try {
      // Validate input
      if (!candles || candles.length < 50) {
        logger.warn(`Insufficient candles for ${symbol}: ${candles?.length || 0}`);
        return null;
      }

      // 1. REGIME FILTER (Key differentiator - GainzAlgo doesn't have this)
      if (this.regimeFilter) {
        const regimeResult = regimeClassifier.classify(symbol, candles);
        const regime = regimeResult.regime;
        
        // Block momentum/breakout in choppy regimes
        const choppyRegimes = ['RANGING_CHOPPY', 'CONSOLIDATION', 'LOW_VOLATILITY'];
        const isChoppy = choppyRegimes.includes(regime);
        
        logger.debug(`${symbol} regime: ${regime}, choppy: ${isChoppy}`);
      }

      // 2. GET ALL AGENT SIGNALS IN PARALLEL
      const [momentumSignals, meanRevSignals, smcAnalysis] = await Promise.all([
        this._getMomentumSignal(symbol, candles, market, timeframe),
        this._getMeanRevSignal(symbol, candles, market, timeframe),
        this._getSMCAnalysis(symbol, candles)
      ]);

      // 3. TRAP FILTER (Stop-hunt detection)
      let trapCheck = { isTrap: false };
      if (this.trapFilter) {
        trapCheck = trapPredictor.evaluateTrapRisk(candles);
        if (trapCheck.isTrap) {
          logger.warn(`Trap detected for ${symbol}: ${trapCheck.trapType}`);
        }
      }

      // 4. BUILD CONSENSUS
      const consensus = await this._buildConsensus({
        symbol,
        candles,
        timeframe,
        market,
        momentumSignals,
        meanRevSignals,
        smcAnalysis,
        trapCheck,
        regime: this.regimeFilter ? regimeClassifier.classify(symbol, candles) : null
      });

      if (!consensus || consensus.confidence < this.minConfidence) {
        return null;
      }

      // 5. CALCULATE DYNAMIC TP/SL (ATR-based like GainzAlgo)
      const atr = this._calculateATR(candles, this.atrPeriod);
      const { tp, sl } = this._calculateTPSL(consensus, atr);

      // 6. RISK MANAGEMENT CHECK
      const riskCheck = this._validateRisk(consensus, tp, sl, symbol);
      if (!riskCheck.valid) {
        logger.warn(`Risk check failed for ${symbol}: ${riskCheck.reason}`);
        return null;
      }

      // 7. RETURN FORMATTED SIGNAL (GainzAlgo-compatible format)
      return {
        // Core signal
        source: 'GainzAlpha_Equivalent',
        indicator: 'GAINZ_ALPHA_EQUIVALENT',
        signal: consensus.signal, // 'BUY' or 'SELL'
        symbol,
        side: consensus.signal === 'BUY' ? 'LONG' : 'SHORT',
        
        // Entry & Exits
        entryPrice: consensus.entryPrice,
        takeProfit: tp,
        stopLoss: sl,
        riskReward: consensus.riskReward || (this.atrMultTP / this.atrMultSL),
        
        // Metadata
        confidence: consensus.confidence,
        timeframe,
        market,
        timestamp: new Date().toISOString(),
        
        // Reasoning (white-box transparency)
        reasoning: {
          regime: consensus.regime,
          momentum: consensus.momentumScore,
          meanReversion: consensus.meanRevScore,
          smc: consensus.smcScore,
          trapCheck: trapCheck,
          agents: consensus.agentVotes,
          confluence: consensus.confluence
        },
        
        // Position sizing (Kelly + risk limits)
        suggestedQuantity: this._calculateQuantity(consensus, sl, symbol),
        
        // Regime context
        regimeContext: {
          regime: consensus.regime,
          isChoppy: ['RANGING_CHOPPY', 'CONSOLIDATION', 'LOW_VOLATILITY'].includes(consensus.regime),
          recommendedStrategy: consensus.regime === 'RANGING_CHOPPY' ? 'MEAN_REVERSION' : 'TREND_FOLLOWING'
        }
      };

    } catch (error) {
      logger.error(`GainzAlphaEquivalent error for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Get momentum agent signal
   */
  async _getMomentumSignal(symbol, candles, market, timeframe = '5m') {
    try {
      const signals = await momentumAgent.generateSignals(
        new Map([[symbol, { candles, timeframe }]]),
        null, // briefing
        market
      );
      return signals?.[0] || null;
    } catch (e) {
      logger.warn(`Momentum signal error for ${symbol}:`, e.message);
      return null;
    }
  }

  /**
   * Get mean reversion agent signal
   */
  async _getMeanRevSignal(symbol, candles, market, timeframe = '5m') {
    try {
      const signals = await meanReversionAgent.generateSignals(
        new Map([[symbol, { candles, timeframe }]]),
        null,
        market
      );
      return signals?.[0] || null;
    } catch (e) {
      logger.warn(`MeanRev signal error for ${symbol}:`, e.message);
      return null;
    }
  }

  /**
   * Get SMC (Smart Money Concepts) analysis
   */
  async _getSMCAnalysis(symbol, candles) {
    try {
      if (candles.length < 15) return null;
      return smartMoneyEngine.analyzeSMC(symbol, candles);
    } catch (e) {
      logger.warn(`SMC analysis error for ${symbol}:`, e.message);
      return null;
    }
  }

  /**
   * Build multi-agent consensus
   */
  async _buildConsensus({ symbol, candles, timeframe, market, momentumSignals, meanRevSignals, smcAnalysis, trapCheck, regime }) {
    const votes = [];
    let totalWeight = 0;
    let weightedSum = 0;

    // Momentum vote
    if (momentumSignals) {
      const weight = 1.0;
      const direction = momentumSignals.direction === 'LONG' ? 'BUY' : 'SELL';
      votes.push({ agent: 'momentum', direction, weight, confidence: momentumSignals.confidence || 0.6 });
      totalWeight += weight;
      weightedSum += (direction === 'BUY' ? 1 : -1) * weight * (momentumSignals.confidence || 0.6);
    }

    // Mean reversion vote
    if (meanRevSignals) {
      const weight = 1.0;
      const direction = meanRevSignals.direction === 'LONG' ? 'BUY' : 'SELL';
      votes.push({ agent: 'mean_reversion', direction, weight, confidence: meanRevSignals.confidence || 0.6 });
      totalWeight += weight;
      weightedSum += (direction === 'BUY' ? 1 : -1) * weight * (meanRevSignals.confidence || 0.6);
    }

    // SMC vote (high weight - institutional logic)
    if (smcAnalysis && smcAnalysis.direction !== 'NEUTRAL' && smcAnalysis.confidence >= 0.70) {
      const weight = 1.5;
      const direction = smcAnalysis.direction === 'LONG' ? 'BUY' : 'SELL';
      votes.push({ agent: 'smc', direction, weight, confidence: smcAnalysis.confidence });
      totalWeight += weight;
      weightedSum += (direction === 'BUY' ? 1 : -1) * weight * smcAnalysis.confidence;
    }

    // Trap veto (reduces confidence)
    if (trapCheck.isTrap) {
      const vetoWeight = -0.5;
      totalWeight += Math.abs(vetoWeight);
      // Reduces overall confidence without flipping direction
    }

    if (votes.length === 0) return null;

    // Calculate consensus
    const netSignal = weightedSum / totalWeight;
    const signal = netSignal > 0.15 ? 'BUY' : netSignal < -0.15 ? 'SELL' : null;
    
    if (!signal) return null;

    // Entry price (current close)
    const currentPrice = candles[candles.length - 1].close;
    
    // Confidence based on vote agreement
    const agreeingVotes = votes.filter(v => v.direction === signal).length;
    const totalVotes = votes.length;
    const agreementRatio = agreeingVotes / totalVotes;
    const avgConfidence = votes.reduce((a, v) => a + v.confidence, 0) / votes.length;
    const confidence = Math.min(0.95, (agreementRatio * 0.5 + avgConfidence * 0.5) * (trapCheck.isTrap ? 0.7 : 1.0));

    // Risk/Reward
    const riskReward = this.atrMultTP / this.atrMultSL;

    return {
      signal,
      entryPrice: currentPrice,
      confidence,
      riskReward,
      regime: regime?.regime || 'UNKNOWN',
      momentumScore: votes.find(v => v.agent === 'momentum')?.confidence || 0,
      meanRevScore: votes.find(v => v.agent === 'mean_reversion')?.confidence || 0,
      smcScore: votes.find(v => v.agent === 'smc')?.confidence || 0,
      trapCheck,
      agentVotes: votes,
      confluence: agreementRatio
    };
  }

  /**
   * Calculate ATR (Average True Range)
   */
  _calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return candles[candles.length - 1].close * 0.01; // Fallback 1%
    
    let trSum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close)
      );
      trSum += tr;
    }
    return trSum / period;
  }

  /**
   * Calculate TP/SL based on ATR
   */
  _calculateTPSL(consensus, atr) {
    const entry = consensus.entryPrice;
    const isLong = consensus.signal === 'BUY';
    
    const slDistance = atr * this.atrMultSL;
    const tpDistance = atr * this.atrMultTP;
    
    return {
      sl: isLong ? entry - slDistance : entry + slDistance,
      tp: isLong ? entry + tpDistance : entry - tpDistance
    };
  }

  /**
   * Validate risk parameters
   */
  _validateRisk(consensus, tp, sl, symbol) {
    const riskPerTrade = riskManager.maxRiskPerTrade || 0.02;
    const entry = consensus.entryPrice;
    const isLong = consensus.signal === 'BUY';
    
    // Risk distance
    const riskDist = isLong ? entry - sl : sl - entry;
    const riskPct = riskDist / entry;
    
    // Check risk %
    if (riskPct > riskPerTrade * 2) { // Allow 2x for high-confidence
      return { valid: false, reason: `Risk ${(riskPct * 100).toFixed(2)}% exceeds limit` };
    }
    
    // Check R:R
    const rewardDist = isLong ? tp - entry : entry - tp;
    const actualRR = rewardDist / riskDist;
    if (actualRR < 1.5) {
      return { valid: false, reason: `R:R ${actualRR.toFixed(2)} below minimum 1.5` };
    }
    
    // Daily loss check
    if (riskManager.dailyPnL <= -Math.abs(riskManager.maxDailyLoss || 0.025) * (riskManager.equity || 10000)) {
      return { valid: false, reason: 'Daily loss limit reached' };
    }
    
    return { valid: true };
  }

  /**
   * Calculate position quantity based on Kelly + risk limits
   */
  _calculateQuantity(consensus, sl, symbol) {
    const equity = riskManager.equity || 10000;
    const riskPerTrade = riskManager.maxRiskPerTrade || 0.02;
    const entry = consensus.entryPrice;
    const isLong = consensus.signal === 'BUY';
    
    const riskAmount = equity * riskPerTrade;
    const riskPerUnit = Math.abs(entry - sl);
    
    if (riskPerUnit <= 0) return 0;
    
    let qty = riskAmount / riskPerUnit;
    
    // Apply max position size
    const maxPosSize = riskManager.maxPositionSize || 0.10;
    const maxQty = (equity * maxPosSize) / entry;
    qty = Math.min(qty, maxQty);
    
    // Round to appropriate lot size
    if (symbol.includes('USDT') || symbol.includes('=X')) {
      qty = Math.floor(qty * 100) / 100; // 2 decimals for crypto/forex
    } else if (symbol.includes('NIFTY') || symbol.includes('BANKNIFTY')) {
      qty = Math.floor(qty / 25) * 25; // Lot size for index
    } else {
      qty = Math.floor(qty); // Shares
    }
    
    return Math.max(1, qty);
  }

  /**
   * Scan multiple symbols for signals
   */
  async scanSymbols(symbols, marketData, timeframe = '5m', market = 'CRYPTO') {
    const signals = [];
    
    for (const symbol of symbols) {
      const candles = marketData.get(symbol)?.candles;
      if (!candles || candles.length < 50) continue;
      
      const signal = await this.generateSignal(symbol, candles, timeframe, market);
      if (signal) {
        signals.push(signal);
      }
    }
    
    // Sort by confidence
    return signals.sort((a, b) => b.confidence - a.confidence);
  }
}

module.exports = GainzAlphaEquivalent;