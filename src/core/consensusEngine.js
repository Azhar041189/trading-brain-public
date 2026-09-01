const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('ConsensusEngine');

/**
 * ConsensusEngine - Vets trading signals across multiple independent specialist agents.
 * Requires a minimum composite score (default 75%) before approving execution.
 */
class ConsensusEngine {
  constructor(threshold = 0.72) {
    this.threshold = threshold;
    this.minCompositeScore = threshold;
  }

  setThreshold(val) {
    this.threshold = parseFloat(val);
    this.minCompositeScore = parseFloat(val);
  }

  /**
   * Evaluate a signal through the Multi-Agent Committee
   * @param {Object} signal - Candidate signal
   * @param {Object} context - Market context containing macro briefing, higher-timeframe candles, orderbook
   */
  evaluate(signal, context = {}) {
    const activeThreshold = this.minCompositeScore !== undefined ? this.minCompositeScore : (this.threshold || 0.72);
    const votes = [];
    let totalWeight = 0;
    let weightedScore = 0;

    // 1. Higher-Timeframe (HTF) Trend Alignment (Weight: 20%)
    const htfWeight = 0.20;
    const htfVote = this._evaluateHTFTrend(signal, context.htfCandles);
    votes.push({ agent: 'HTF_Trend_Sentinel', ...htfVote, weight: htfWeight });
    totalWeight += htfWeight;
    weightedScore += htfVote.score * htfWeight;

    // 2. Macro / Research Regime Alignment (Weight: 15%)
    const macroWeight = 0.15;
    const macroVote = this._evaluateMacroRegime(signal, context.macroBriefing);
    votes.push({ agent: 'Macro_Research_Agent', ...macroVote, weight: macroWeight });
    totalWeight += macroWeight;
    weightedScore += macroVote.score * macroWeight;

    // 3. Technical Strength & Momentum Quality (Weight: 15%)
    const techWeight = 0.15;
    const techVote = this._evaluateTechnicalQuality(signal);
    votes.push({ agent: 'Technical_Vetting_Agent', ...techVote, weight: techWeight });
    totalWeight += techWeight;
    weightedScore += techVote.score * techWeight;

    // 4. Options Chain PCR & Derivatives Sentiment (Weight: 10%)
    const optionsWeight = 0.10;
    const optionsVote = this._evaluateOptionsPCR(signal, context.optionsAnalysis);
    votes.push({ agent: 'Options_Derivatives_Auditor', ...optionsVote, weight: optionsWeight });
    totalWeight += optionsWeight;
    weightedScore += optionsVote.score * optionsWeight;

    // 5. Volume Shocker & Dark Pool Inflow (Weight: 10%)
    const volumeWeight = 0.10;
    const volumeVote = this._evaluateVolumeShocker(signal, context.volumeShocker);
    votes.push({ agent: 'Volume_Shocker_Sentinel', ...volumeVote, weight: volumeWeight });
    totalWeight += volumeWeight;
    weightedScore += volumeVote.score * volumeWeight;

    // 6. Risk / Sizing Integrity (Weight: 10%)
    const riskWeight = 0.10;
    const riskVote = this._evaluateRiskReward(signal);
    votes.push({ agent: 'Risk_Reward_Auditor', ...riskVote, weight: riskWeight });
    totalWeight += riskWeight;
    weightedScore += riskVote.score * riskWeight;

    // 7. Market Regime Alignment Gate (Weight: 10%)
    const regimeWeight = 0.10;
    const regimeVote = this._evaluateRegimeAlignment(signal);
    votes.push({ agent: 'Regime_Consistency_Sentinel', ...regimeVote, weight: regimeWeight });
    totalWeight += regimeWeight;
    weightedScore += regimeVote.score * regimeWeight;

    // 8. Prompt Strategy Community Advisor (Weight: 10%)
    const promptWeight = 0.10;
    const promptVote = this._evaluatePromptStrategy(signal, context);
    votes.push({ agent: 'Prompt_Strategy_Advisor', ...promptVote, weight: promptWeight });
    totalWeight += promptWeight;
    weightedScore += promptVote.score * promptWeight;

    const compositeScore = parseFloat((weightedScore / totalWeight).toFixed(2));
    const approved = compositeScore >= activeThreshold;

    const result = {
      approved,
      compositeScore,
      threshold: activeThreshold,
      symbol: signal.symbol,
      direction: signal.direction,
      votes,
      rejectionReasons: approved ? [] : votes.filter(v => v.score < 0.6).map(v => `${v.agent}: ${v.reason}`)
    };

    if (!approved) {
      logger.warn(`⛔ [Consensus Veto] Signal ${signal.direction} ${signal.symbol} rejected (${(compositeScore * 100).toFixed(0)}% < ${(activeThreshold * 100)}%)`, {
        rejectionReasons: result.rejectionReasons
      });
    } else {
      logger.info(`✨ [Consensus Approved] Signal ${signal.direction} ${signal.symbol} cleared committee with ${(compositeScore * 100).toFixed(0)}% confidence`);
    }

    return result;
  }

  _evaluateHTFTrend(signal, htfCandles) {
    if (!htfCandles || htfCandles.length < 20) {
      return { score: 0.70, reason: 'HTF data neutral (insufficient bars)' };
    }

    const closes = htfCandles.map(c => c.close);
    const latestPrice = closes[closes.length - 1];
    
    // Calculate simple 20-period moving average on HTF
    const sum20 = closes.slice(-20).reduce((acc, v) => acc + v, 0);
    const sma20 = sum20 / 20;

    const isBullishHTF = latestPrice > sma20;

    if (signal.direction === 'LONG') {
      return isBullishHTF
        ? { score: 1.0, reason: 'Aligned with bullish 1h/1D trend (Price > 20 SMA)' }
        : { score: 0.35, reason: 'Counter-trend: Long signal during bearish 1h/1D trend' };
    } else {
      return !isBullishHTF
        ? { score: 1.0, reason: 'Aligned with bearish 1h/1D trend (Price < 20 SMA)' }
        : { score: 0.35, reason: 'Counter-trend: Short signal during bullish 1h/1D trend' };
    }
  }

  _evaluateMacroRegime(signal, macroBriefing) {
    if (!macroBriefing || !macroBriefing.bias) {
      return { score: 0.75, reason: 'Macro regime neutral' };
    }

    const bias = (macroBriefing.bias.bias || 'neutral').toLowerCase();

    if (bias === 'neutral') {
      return { score: 0.75, reason: 'Macro cues neutral, range trading allowed' };
    }

    if (signal.direction === 'LONG' && (bias.includes('bullish') || bias.includes('positive'))) {
      return { score: 1.0, reason: 'Macro bias supports long posture' };
    }

    if (signal.direction === 'SHORT' && (bias.includes('bearish') || bias.includes('negative'))) {
      return { score: 1.0, reason: 'Macro bias supports short posture' };
    }

    return { score: 0.45, reason: `Direction ${signal.direction} conflicts with macro bias: ${bias}` };
  }

  _evaluateTechnicalQuality(signal) {
    const rawConf = signal.confidence || 0.65;
    return {
      score: Math.min(1.0, rawConf),
      reason: `Technical setup strength: ${(rawConf * 100).toFixed(0)}%`
    };
  }

  _evaluateOptionsPCR(signal, optionsAnalysis) {
    if (!optionsAnalysis || !optionsAnalysis.pcr) {
      return { score: 0.75, reason: 'Options PCR neutral / not applicable' };
    }
    const pcr = parseFloat(optionsAnalysis.pcr);
    if (signal.direction === 'LONG') {
      if (pcr >= 1.1) return { score: 1.0, reason: `Bullish Put-Call Ratio (${pcr} >= 1.10) confirms institutional put writing support` };
      if (pcr <= 0.7) return { score: 0.40, reason: `Heavy Call Overhang (PCR ${pcr} <= 0.70) creates overhead resistance for longs` };
    } else if (signal.direction === 'SHORT') {
      if (pcr <= 0.75) return { score: 1.0, reason: `Bearish Put-Call Ratio (${pcr} <= 0.75) confirms call writing resistance` };
      if (pcr >= 1.3) return { score: 0.40, reason: `High Put Floor (PCR ${pcr} >= 1.30) provides strong bounce support against shorts` };
    }
    return { score: 0.80, reason: `Options PCR (${pcr}) in equilibrium balance` };
  }

  _evaluateVolumeShocker(signal, volumeShocker) {
    if (!volumeShocker || !volumeShocker.volumeMultiple) {
      return { score: 0.75, reason: 'Volume activity normal' };
    }
    const mult = parseFloat(volumeShocker.volumeMultiple);
    if (mult >= 3.0) {
      return { score: 1.0, reason: `High-Conviction Volume Shocker (${mult.toFixed(1)}x average volume) confirms institutional order flow` };
    } else if (mult >= 1.5) {
      return { score: 0.85, reason: `Elevated volume multiple (${mult.toFixed(1)}x)` };
    }
    return { score: 0.70, reason: `Standard volume flow (${mult.toFixed(1)}x)` };
  }

  _evaluateRiskReward(signal) {
    const rr = signal.riskReward || 1.0;
    if (rr >= 2.0) return { score: 1.0, reason: `Optimal Risk:Reward (${rr.toFixed(2)})` };
    if (rr >= 1.5) return { score: 0.85, reason: `Acceptable Risk:Reward (${rr.toFixed(2)})` };
    return { score: 0.30, reason: `Sub-optimal Risk:Reward (${rr.toFixed(2)} < 1.5)` };
  }

  _evaluateRegimeAlignment(signal) {
    try {
      const regimeClassifier = require('./regimeClassifier');
      const currentRegime = regimeClassifier.getCurrentRegime();
      const strat = (signal.strategy || '').toLowerCase();

      if (currentRegime === 'RANGING_CHOPPY' || currentRegime === 'CONSOLIDATION') {
        if (strat.includes('momentum') || strat.includes('breakout')) {
          return { score: 0.20, reason: `Momentum/Breakout strictly penalized in ${currentRegime} regime (Whipsaw Trap)` };
        }
        if (signal.boundaryValidated || strat.includes('reversion') || strat.includes('fade')) {
          return { score: 1.0, reason: `Mean reversion setup perfectly aligned with ${currentRegime} boundaries` };
        }
        return { score: 0.50, reason: `Unvalidated signal in ${currentRegime} market` };
      }

      if (currentRegime === 'TRENDING_BULL' || currentRegime === 'TRENDING_BEAR') {
        if (strat.includes('momentum') || strat.includes('trend')) {
          return { score: 1.0, reason: `Momentum strategy optimal for ${currentRegime}` };
        }
      }

      return { score: 0.80, reason: `Regime compatibility neutral (${currentRegime})` };
    } catch (e) {
      return { score: 0.70, reason: 'Regime check fallback neutral' };
    }
  }

  _evaluatePromptStrategy(signal, context) {
    try {
      const promptsChatLibrary = require('./promptsChatLibrary');
      const result = promptsChatLibrary.scoreSignalAgainstTemplate(signal, context);
      return {
        score: result.score,
        reason: `${result.templateUsed}: ${result.reason}`
      };
    } catch (e) {
      return { score: 0.75, reason: 'Prompt strategy template evaluation neutral' };
    }
  }
}

module.exports = new ConsensusEngine(0.70);
