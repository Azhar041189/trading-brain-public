const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('AgentMemoryEngine');

/**
 * AgentMemoryEngine - Episodic Reflection, Dynamic Credibility Scoring & Pattern Recall
 * 
 * Features:
 * 1. Episodic Trade Journaling: Stores post-trade lessons and reflections.
 * 2. Meritocratic Credibility Weights: Scales agent vote weights (0.4x - 1.6x) based on rolling accuracy.
 * 3. Pattern Similarity Retrieval: Matches current market state to past successful/failed setups.
 */
class AgentMemoryEngine {
  constructor() {
    this.episodicMemories = [];
    this.maxMemories = 500;
    
    // Rolling agent performance credit scores (default base weight: 1.0)
    this.agentCredibility = {
      'ARES': { totalVotes: 10, correctVotes: 7, winRate: 0.70, voteMultiplier: 1.15 },
      'ATHENA': { totalVotes: 12, correctVotes: 10, winRate: 0.83, voteMultiplier: 1.35 },
      'THOTH': { totalVotes: 8, correctVotes: 6, winRate: 0.75, voteMultiplier: 1.20 },
      'ANUBIS': { totalVotes: 9, correctVotes: 7, winRate: 0.77, voteMultiplier: 1.25 }
    };
  }

  /**
   * Records a completed trade episode with agent reflections
   */
  storeEpisode(tradeData = {}) {
    return this.recordEpisode(tradeData);
  }

  recordEpisode(tradeData = {}) {
    const {
      symbol = 'BTCUSDT',
      direction = 'LONG',
      realizedPnL = 0,
      regime = 'RANGING_CHOPPY',
      supportingAgents = ['ARES'],
      opposingAgents = ['ATHENA'],
      entryPrice = 0,
      exitPrice = 0
    } = tradeData;

    const isWin = realizedPnL > 0;
    const pnlFormatted = (realizedPnL >= 0 ? '+' : '') + realizedPnL.toFixed(2);

    // Formulate key lesson learned
    let lesson = '';
    if (isWin) {
      lesson = `Successful ${direction} momentum on ${symbol} in ${regime}. High confidence consensus proved accurate.`;
    } else {
      lesson = `Loss on ${direction} ${symbol} in ${regime}. Opposing agent concerns should be given higher weight next time.`;
    }

    const episode = {
      id: `ep_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      timestamp: new Date().toISOString(),
      symbol,
      direction,
      realizedPnL,
      pnlFormatted,
      isWin,
      regime,
      supportingAgents,
      opposingAgents,
      entryPrice,
      exitPrice,
      lesson
    };

    this.episodicMemories.unshift(episode);
    if (this.episodicMemories.length > this.maxMemories) {
      this.episodicMemories.pop();
    }

    // Update dynamic credibility weights
    this.updateCredibility(supportingAgents, opposingAgents, isWin);

    logger.info(`🧠 [Episodic Memory Stored] ${symbol} ${direction} (${pnlFormatted}) ➔ Lesson: "${lesson}"`);
    return episode;
  }

  /**
   * Updates agent credibility and voting multipliers
   */
  updateCredibility(supporters, opposers, isWin) {
    supporters.forEach(agent => {
      const a = agent.toUpperCase();
      if (this.agentCredibility[a]) {
        this.agentCredibility[a].totalVotes++;
        if (isWin) this.agentCredibility[a].correctVotes++;
        this.recalcMultiplier(a);
      }
    });

    opposers.forEach(agent => {
      const a = agent.toUpperCase();
      if (this.agentCredibility[a]) {
        this.agentCredibility[a].totalVotes++;
        if (!isWin) this.agentCredibility[a].correctVotes++; // Opposer was right to doubt!
        this.recalcMultiplier(a);
      }
    });
  }

  recalcMultiplier(agentKey) {
    const cred = this.agentCredibility[agentKey];
    if (!cred || cred.totalVotes === 0) return;
    cred.winRate = parseFloat((cred.correctVotes / cred.totalVotes).toFixed(2));
    
    // Scale multiplier: 50% win rate = 1.0x, 80% = 1.4x, 30% = 0.5x
    const rawMultiplier = 0.4 + (cred.winRate * 1.2);
    cred.voteMultiplier = parseFloat(Math.max(0.4, Math.min(1.6, rawMultiplier)).toFixed(2));
  }

  /**
   * Retrieves dynamic credibility score/multiplier for an agent
   */
  getCredibility(agentId) {
    if (!agentId) return 1.0;
    const key = agentId.toUpperCase();
    const cred = this.agentCredibility[key];
    return cred ? (cred.voteMultiplier || 1.0) : 1.0;
  }

  /**
   * Retrieves relevant historical trade memories for a symbol & regime
   */
  recallSimilarEpisodes(symbol, regime, limit = 3) {
    const matched = this.episodicMemories.filter(m => 
      m.symbol === symbol || m.regime === regime
    );

    return matched.slice(0, limit);
  }

  getMemoryStatus() {
    return {
      totalEpisodes: this.episodicMemories.length,
      agentCredibility: this.agentCredibility,
      recentMemories: this.episodicMemories.slice(0, 10)
    };
  }
}

module.exports = new AgentMemoryEngine();
