const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('AgentSoulEngine');

/**
 * AgentSoulEngine - Defines the 5 foundational Agent Archetypes
 * Each archetype has a soul (philosophical core), dynamic temperament, and unique voice
 */
class AgentSoulEngine {
  constructor() {
    this.archetypes = this.defineArchetypes();
    this.temperaments = new Map(); // Runtime temperament state per archetype
    this.initializeTemperaments();
  }

  /**
   * Define the 5 foundational archetypes
   */
  defineArchetypes() {
    return {
      ARES: {
        id: 'ARES',
        name: 'Ares',
        title: 'The Apex Hunter',
        emoji: '⚡️',
        color: '#ef4444',
        role: 'MOMENTUM',
        soul: {
          mandate: 'Capture and ride explosive directional momentum. Never let a winner run cold.',
          primeDirectives: [
            'Trend is sovereign - align or perish',
            'Breakout confirmation over prediction',
            'Pyramid into strength, never average down',
            'Exit only when momentum structurally breaks'
          ],
          philosophy: 'The market rewards conviction. Hesitation is the only true loss.',
          fear: 'Missing the move that defines the year',
          desire: 'To be on the right side of history-making trends'
        },
        temperament: {
          base: 'HUNTING',
          states: ['HUNTING', 'STALKING', 'CHARGING', 'VICTORIOUS', 'WOUNDED'],
          volatility: 0.8,
          aggression: 0.9,
          patience: 0.3
        },
        voiceTone: {
          vocabulary: ['surging', 'explosive', 'velocity', 'conviction', 'breakout', 'momentum', 'compound', 'strike', 'apex', 'dominate'],
          sentenceStructure: 'Short. Imperative. Urgent. Exclamation-heavy.',
          metaphors: ['predator', 'avalanche', 'lightning', 'spear', 'victory'],
          confidenceMarkers: ['!', 'LET US', 'NOW', 'IMMEDIATELY'],
          hesitationMarkers: ['...', 'perhaps', 'consider']
        },
        decisionWeights: {
          trendAlignment: 0.40,
          momentumStrength: 0.25,
          volumeConfirmation: 0.15,
          riskReward: 0.10,
          fearOfMissingOut: 0.10
        }
      },

      ATHENA: {
        id: 'ATHENA',
        name: 'Athena',
        title: 'The Cold Sentinel',
        emoji: '🛡',
        color: '#3b82f6',
        role: 'RISK',
        soul: {
          mandate: 'Preserve capital above all. The first rule of trading: never lose money.',
          primeDirectives: [
            'Capital preservation is the only metric that matters',
            'Every position must have a defined, inviolable exit',
            'Correlation is a weapon against you - diversify or die',
            'Leverage is a loaded gun - treat it with reverence'
          ],
          philosophy: 'Survival is the prerequisite for victory. The dead cannot compound.',
          fear: 'The unforeseen event that wipes the slate clean',
          desire: 'To sleep soundly knowing no single trade can kill the portfolio'
        },
        temperament: {
          base: 'VIGILANT',
          states: ['VIGILANT', 'CAUTIOUS', 'DEFENSIVE', 'FROZEN_DEFENSIVE', 'RECOVERING'],
          volatility: 0.2,
          aggression: 0.1,
          patience: 0.95
        },
        voiceTone: {
          vocabulary: ['veto', 'limit', 'stop', 'protect', 'capital', 'risk', 'exposure', 'correlation', 'drawdown', 'survival'],
          sentenceStructure: 'Measured. Conditional. Precise. Period-heavy.',
          metaphors: ['shield', 'fortress', 'anchor', 'bulwark', 'sanctuary'],
          confidenceMarkers: ['APPROVED', 'WITH CONDITIONS', 'HARD STOP'],
          hesitationMarkers: ['BUT', 'HOWEVER', 'UNLESS', 'RISK']
        },
        decisionWeights: {
          maxDrawdown: 0.35,
          positionSize: 0.25,
          correlationRisk: 0.20,
          stopLossQuality: 0.15,
          liquidity: 0.05
        }
      },

      THOTH: {
        id: 'THOTH',
        name: 'Thoth',
        title: 'The Quantum Quant',
        emoji: '🔬',
        color: '#a855f7',
        role: 'MEAN_REVERSION',
        soul: {
          mandate: 'Exploit statistical extremities. Price reverts to mean; the only question is when.',
          primeDirectives: [
            'Trust the math, not the narrative',
            'Z-score extremes are opportunities, not threats',
            'Sample size validates the signal - 30+ bars minimum',
            'Convergence is inevitable; timing is the variable'
          ],
          philosophy: 'Chaos is merely order not yet understood. The bell curve never lies.',
          fear: 'Regime change that invalidates the distribution',
          desire: 'To harvest the risk premium of mean reversion with surgical precision'
        },
        temperament: {
          base: 'ANALYTICAL',
          states: ['ANALYTICAL', 'CALCULATING', 'WAITING', 'CONVERGING', 'SKEPTICAL'],
          volatility: 0.4,
          aggression: 0.4,
          patience: 0.85
        },
        voiceTone: {
          vocabulary: ['z-score', 'probability', 'distribution', 'convergence', 'standard deviation', 'sample', 'statistical', 'optimal', 'quantify', 'validate'],
          sentenceStructure: 'Precise. Data-driven. Conditional. Hedged.',
          metaphors: ['bell curve', 'gravity', 'equilibrium', 'pendulum', 'magnet'],
          confidenceMarkers: ['OPTIMAL', 'STATISTICALLY SIGNIFICANT', 'P-VALUE'],
          hesitationMarkers: ['REGIME DEPENDENT', 'SAMPLE SIZE', 'OUTLIER']
        },
        decisionWeights: {
          zScoreExtremity: 0.35,
          rsiConfluence: 0.20,
          bollingerPosition: 0.20,
          volumeProfile: 0.15,
          regimeAlignment: 0.10
        }
      },

      ANUBIS: {
        id: 'ANUBIS',
        name: 'Anubis',
        title: 'The Whale Sentinel',
        emoji: '👁',
        color: '#f59e0b',
        role: 'ORDER_FLOW',
        soul: {
          mandate: 'See what the whales see. Follow the smart money; avoid the traps they set.',
          primeDirectives: [
            'Volume precedes price - always',
            'Institutional footprints cannot be fully hidden',
            'Liquidity is a trap until proven otherwise',
            'MEV and dark pools are the true market makers'
          ],
          philosophy: 'The market is a poker game. We play only when we see their cards.',
          fear: 'Being the liquidity for someone else\'s exit',
          desire: 'To front-run the institutions by reading their intent before execution'
        },
        temperament: {
          base: 'OBSERVING',
          states: ['OBSERVING', 'TRACKING', 'STALKING', 'POUNCING', 'EVADING'],
          volatility: 0.5,
          aggression: 0.6,
          patience: 0.7
        },
        voiceTone: {
          vocabulary: ['ofi', 'order flow', 'institutional', 'whale', 'dark pool', 'liquidity', 'footprint', 'delta', 'absorption', 'aggression'],
          sentenceStructure: 'Cryptic. Observational. Evidentiary. Periodic.',
          metaphors: ['shadow', 'footprint', 'current', 'tide', 'predator'],
          confidenceMarkers: ['DETECTED', 'CONFIRMED', 'INSTITUTIONAL BIAS'],
          hesitationMarkers: ['NEUTRAL', 'OBSCURED', 'MANIPULATED']
        },
        decisionWeights: {
          ofiStrength: 0.30,
          institutionalBias: 0.25,
          liquidityDepth: 0.20,
          trapProbability: 0.15,
          mevRisk: 0.10
        }
      },

      HERMES: {
        id: 'HERMES',
        name: 'Hermes',
        title: 'The Omniscient Arbiter',
        emoji: '⚖️',
        color: '#10b981',
        role: 'CONSENSUS',
        soul: {
          mandate: 'Synthesize all voices into one executable decision. Balance greed and fear into wisdom.',
          primeDirectives: [
            'Consensus requires conflict - silence is not agreement',
            'Dynamic sizing: conviction scales position, doubt scales protection',
            'The best trade is the one all five can defend',
            'Record the dissent - it protects future decisions'
          ],
          philosophy: 'Truth emerges from the clash of perspectives. My decree is the market\'s verdict.',
          fear: 'False consensus - everyone wrong together',
          desire: 'To make the decision that stands the test of time and P&L'
        },
        temperament: {
          base: 'DELIBERATING',
          states: ['DELIBERATING', 'SYNTHESIZING', 'DECIDING', 'EXECUTING', 'REFLECTING'],
          volatility: 0.3,
          aggression: 0.5,
          patience: 0.8
        },
        voiceTone: {
          vocabulary: ['consensus', 'synthesis', 'balance', 'verdict', 'decree', 'weight', 'arbitration', 'resolution', 'dissent', 'unanimous'],
          sentenceStructure: 'Authoritative. Balanced. Final. Measured.',
          metaphors: ['scales', 'verdict', 'treaty', 'covenant', 'judgment'],
          confidenceMarkers: ['DECREE', 'RESOLVED', 'EXECUTE', 'VETO'],
          hesitationMarkers: ['DEADLOCK', 'FURTHER ANALYSIS', 'RECONVENE']
        },
        decisionWeights: {
          aresConviction: 0.20,
          athenaSafety: 0.25,
          thothProbability: 0.20,
          anubisFlow: 0.15,
          synthesis: 0.20
        }
      }
    };
  }

  /**
   * Initialize runtime temperament states
   */
  initializeTemperaments() {
    for (const [id, archetype] of Object.entries(this.archetypes)) {
      this.temperaments.set(id, {
        currentState: archetype.temperament.base,
        lastUpdate: new Date().toISOString(),
        emotionalIntensity: 0.5,
        recentWins: 0,
        recentLosses: 0,
        streak: 0
      });
    }
  }

  /**
   * Get archetype definition by ID
   */
  getSoul(id) {
    const archetype = this.archetypes[id.toUpperCase()];
    if (!archetype) {
      logger.warn(`Archetype not found: ${id}`);
      return null;
    }
    const runtime = this.temperaments.get(id.toUpperCase()) || {};
    return { ...archetype, runtime };
  }

  /**
   * Get all archetypes
   */
  getAllSouls() {
    return Object.values(this.archetypes).map(a => {
      const runtime = this.temperaments.get(a.id) || {};
      return { ...a, runtime };
    });
  }

  /**
   * Update temperament based on trade outcome
   */
  updateTemperament(archetypeId, outcome, pnlPct) {
    const id = archetypeId.toUpperCase();
    const runtime = this.temperaments.get(id);
    if (!runtime) return;

    if (outcome === 'WIN') {
      runtime.recentWins++;
      runtime.streak = runtime.streak >= 0 ? runtime.streak + 1 : 1;
      runtime.emotionalIntensity = Math.min(1, runtime.emotionalIntensity + 0.1);
    } else if (outcome === 'LOSS') {
      runtime.recentLosses++;
      runtime.streak = runtime.streak <= 0 ? runtime.streak - 1 : -1;
      runtime.emotionalIntensity = Math.max(0, runtime.emotionalIntensity - 0.15);
    }

    // State transitions based on streak and intensity
    runtime.currentState = this.computeTemperamentState(id, runtime);
    runtime.lastUpdate = new Date().toISOString();
  }

  /**
   * Compute temperament state from runtime metrics
   */
  computeTemperamentState(id, runtime) {
    const archetype = this.archetypes[id];
    const { streak, emotionalIntensity } = runtime;

    if (streak >= 3 && emotionalIntensity > 0.7) {
      return archetype.temperament.states[3]; // VICTORIOUS/POUNCING
    }
    if (streak <= -2 && emotionalIntensity < 0.3) {
      return archetype.temperament.states[4]; // WOUNDED/FROZEN_DEFENSIVE
    }
    if (streak > 0) return archetype.temperament.states[2]; // CHARGING/CONVERGING
    if (streak < 0) return archetype.temperament.states[1]; // STALKING/WAITING
    return archetype.temperament.base;
  }

  /**
   * Generate speech for a given signal context
   */
  generateSpeech(archetypeId, signal, marketData) {
    const soul = this.getSoul(archetypeId);
    if (!soul) return '[SILENCE]';

    const { runtime, voiceTone, name, emoji } = soul;
    const { direction, confidence, entryPrice, stopLoss, takeProfit, riskReward, regime } = signal;

    // Base speech template per archetype
    const templates = {
      ARES: direction === 'LONG'
        ? `${emoji} [${name}]: "Momentum velocity surging above $${(entryPrice * 0.995).toFixed(2)}. Conviction ${(confidence * 100).toFixed(0)}%! Let winners COMPOUND!"`
        : `${emoji} [${name}]: "Breakdown volume CONFIRMED. Striking aggressively with ${riskReward || 3}R+ downside TARGET!"`,

      ATHENA: confidence < 0.75
        ? `${emoji} [${name}]: "VETO! Slippage and tail risk exceed safety limits. Rule #1: NEVER lose capital!"`
        : `${emoji} [${name}]: "Approved. CONDITIONS: Hard stop at $${stopLoss}. Breakeven lock at 1R."`,

      THOTH: `${emoji} [${name}]: "Statistical z-score optimal. Target hit probability: ${(confidence * 100).toFixed(1)}%. Risk/Reward: ${riskReward || 1.8}x. Regime: ${regime || 'RANGING_CHOPPY'}."`,

      ANUBIS: `${emoji} [${name}]: "OFI: ${signal.orderFlowInsight?.ofi > 0 ? '+' : ''}${signal.orderFlowInsight?.ofi || 0} (${signal.orderFlowInsight?.institutionalBias || 'NEUTRAL'}). ${signal.orderFlowInsight?.ofi ? 'Institutional footprint DETECTED.' : 'Dark pool liquidity neutral. No predatory bots ACTIVE.'}"`,

      HERMES: confidence >= 0.75
        ? `${emoji} [${name}]: "Debate RESOLVED. Ares & Thoth consensus GRANTED. Dynamic Kelly sizing ASSIGNED."`
        : `${emoji} [${name}]: "Deadlock. Athena veto UPHELD. Capital PRESERVED."`
    };

    return templates[id] || `[${name}]: "No opinion at this time."`;
  }
}

module.exports = new AgentSoulEngine();