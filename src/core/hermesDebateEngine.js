const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('HermesDebate');

/**
 * HermesDebateEngine - Orchestrates structured multi-agent debates (Bull vs. Bear vs. Macro).
 * Generates transparent plain-English rationale for consensus decision-making.
 */
class HermesDebateEngine {
  constructor() {
    this.debateHistory = [];
  }

  /**
   * Conduct a structured multi-agent debate on a proposed signal
   */
  conductDebate(signal, marketData, macroBriefing) {
    const symbol = signal.symbol;
    const direction = signal.direction;
    const price = signal.entryPrice;

    const agentSoul = require('./agentSoulEngine');
    const agentMemory = require('./agentMemoryEngine');

    const ares = agentSoul.getSoul('ARES');
    const athena = agentSoul.getSoul('ATHENA');
    const thoth = agentSoul.getSoul('THOTH');
    const anubis = agentSoul.getSoul('ANUBIS');
    const hermes = agentSoul.getSoul('HERMES');

    // Recall past trade memory for this symbol/regime
    const pastMemories = agentMemory.recallSimilarEpisodes(symbol, signal.regime || 'RANGING_CHOPPY', 1);
    const memoryLesson = pastMemories.length > 0 
      ? pastMemories[0].lesson 
      : 'No prior stop-outs on record for this setup.';

    // 1. Ares (Apex Trend Hunter) Speech
    const aresSpeech = direction === 'LONG'
      ? `${ares.emoji} [${ares.name}]: "Momentum velocity is surging above $${(price * 0.995).toFixed(2)}. Conviction is ${(signal.confidence * 100).toFixed(0)}%! Let the winners compound!"`
      : `${ares.emoji} [${ares.name}]: "Breakdown volume confirmed. Striking aggressively with 3R+ downside target!"`;

    // 2. Athena (Cold Risk Sentinel) Speech
    const athenaSpeech = signal.confidence < 0.75
      ? `${athena.emoji} [${athena.name}]: "Veto! Slippage and tail risk exceed safety limits. Remember rule #1: Never lose capital!"`
      : `${athena.emoji} [${athena.name}]: "Approved with conditions: Hard stop loss at $${signal.stopLoss}. Lock breakeven at 1R profit."`;

    // 3. Thoth (Quantum Quant) Statistical Evaluation
    const thothSpeech = `${thoth.emoji} [${thoth.name}]: "Statistical z-score is optimal. Probability of target hit: ${(signal.confidence * 100).toFixed(1)}%. Risk/Reward ratio ${signal.riskReward || 1.8}x."`;

    // 4. Anubis (Whale & Order Flow) & Smart Pipe Stream Synthesis
    let smartPipeFindings = [];
    try {
      const { MarketDataFilter } = require('./smartPipe');
      const rawLines = [
        signal.orderFlowInsight ? `OFI ${signal.orderFlowInsight.ofi > 0 ? '+' : ''}${signal.orderFlowInsight.ofi} ${signal.orderFlowInsight.institutionalBias} institutional bias` : '',
        signal.reason || '',
        macroBriefing?.bias ? `Macro bias: ${macroBriefing.bias.bias} (${(macroBriefing.bias.factors || []).join(', ')})` : '',
        `Breakout momentum confidence ${(signal.confidence * 100).toFixed(0)}% on ${symbol}`
      ].filter(Boolean);

      const filterResult = MarketDataFilter.processLines(rawLines, { limit: 3 });
      smartPipeFindings = filterResult.topFindings || [];
    } catch (e) {
      logger.warn(`Smart Pipe filter fallback: ${e.message}`);
    }

    const smartPipeSummary = smartPipeFindings.length > 0 ? ` [SmartPipe: ${smartPipeFindings[0]}]` : '';

    const anubisSpeech = signal.orderFlowInsight
      ? `${anubis.emoji} [${anubis.name}]: "OFI: ${signal.orderFlowInsight.ofi > 0 ? '+' : ''}${signal.orderFlowInsight.ofi} (${signal.orderFlowInsight.institutionalBias}). Institutional footprint detected.${smartPipeSummary}"`
      : `${anubis.emoji} [${anubis.name}]: "Dark pool liquidity neutral. No predatory sandwich bots active.${smartPipeSummary}"`;

    // 5. Hermes (Synthesizer Arbiter) Final Decree
    const hermesDecree = signal.confidence >= 0.75
      ? `${hermes.emoji} [${hermes.name}]: "Debate resolved. Ares & Thoth consensus granted. Dynamic Kelly sizing assigned."`
      : `${hermes.emoji} [${hermes.name}]: "Debate deadlock. Athena veto upheld to preserve trading capital."`;

    // 6. Community Strategist (Dynamic Prompts.Chat Persona)
    let communitySpeech = '📚 [Community Strategist]: "No community consensus available."';
    let communityPromptTitle = 'Community Strategy Vault';
    try {
      const promptsChatLibrary = require('./promptsChatLibrary');
      const persona = promptsChatLibrary.getDebatePersonaCached() || promptsChatLibrary._getFallbackPrompt('cmr6eqhk4000cjv04upxiyx9i');
      if (persona) {
        communityPromptTitle = persona.title || 'Simmerdeep Crypto Quant v2.0';
        const preview = persona.contentPreview || persona.description || (persona.content ? persona.content.slice(0, 120) + '...' : 'Macro & Micro Consensus');
        communitySpeech = `📚 [Community Strategist (${persona.title})]: "${preview}"`;
      }
    } catch (e) {
      logger.warn(`Could not load community persona: ${e.message}`);
    }

    // 7. Pythia (Polymarket Prediction Market Oracle) — RESEARCH_CONTEXT_ONLY
    //    Governance: This context is observational. It must NEVER influence
    //    signal.confidence, regime classification, sizing, or execution.
    let predictionSpeech = '🔮 [Pythia / Prediction Oracle]: "Polymarket macro sentiment: no current data. [RESEARCH_CONTEXT_ONLY]"';
    let predictionMarketData = null;
    try {
      const { polymarketMcpClient } = require('../tools/polymarketMcpClient');
      const macroOdds = polymarketMcpClient._getCached('macro_predictions');
      if (macroOdds && macroOdds.predictions && macroOdds.predictions.length > 0) {
        const topMacro = macroOdds.predictions[0];
        predictionSpeech = `🔮 [Pythia / Prediction Oracle]: "Polymarket crowd pricing '${topMacro.question}' at ${topMacro.yesOdds} YES odds. [RESEARCH_CONTEXT_ONLY — does not influence this decision]"`;
        predictionMarketData = { question: topMacro.question, yesOdds: topMacro.yesOdds, category: topMacro.category };
      }
    } catch (e) {
      logger.warn(`Prediction Oracle fallback: ${e.message}`);
    }

    const debate = {
      id: `debate_${Date.now()}_${symbol}`,
      timestamp: new Date().toISOString(),
      symbol,
      direction,
      price,
      aresSpeech,
      athenaSpeech,
      thothSpeech,
      anubisSpeech,
      hermesDecree,
      communitySpeech,
      communityPromptTitle,
      predictionSpeech,
      predictionMarketData,
      predictionMarketInfluencesDecision: false, // GOVERNANCE: shadow-only, zero decision-delta
      memoryLesson,
      bullCase: aresSpeech,
      bearCase: athenaSpeech,
      macroVerdict: thothSpeech,
      fundamentalNote: anubisSpeech,
      communityInsight: communitySpeech,
      predictionOracle: predictionSpeech,
      consensusDecision: signal.confidence >= 0.75 ? 'EXECUTE' : 'VETO',
      confidence: `${(signal.confidence * 100).toFixed(0)}%`
    };

    this.debateHistory.unshift(debate);
    if (this.debateHistory.length > 50) this.debateHistory.pop();

    logger.info(`🤖 [Hermes Debate on ${symbol}] ${hermes.name} Decree: ${debate.consensusDecision} (${debate.confidence})`);

    // Broadcast debate directly over dashboard WebSocket
    try {
      const dashboardServer = require('../dashboard/server');
      dashboardServer.broadcast('debate', debate);
    } catch (e) {}

    return debate;
  }

  getRecentDebates(limit = 10) {
    return this.debateHistory.slice(0, limit);
  }
}

module.exports = new HermesDebateEngine();
