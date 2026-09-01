const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('AdversarialHardener');

/**
 * AdversarialTrainingEngine
 * Generates synthetic flash-crash, liquidity vacuum, and spoofing noise vectors
 * to stress-test and harden the DRL Actor-Critic neural weights against black swan market conditions.
 */
class AdversarialTrainingEngine {
  constructor() {
    this.scenarios = [
      { name: 'FLASH_CRASH_CASCADE', priceShockPct: -0.15, volMultiplier: 8.5, spreadWidenBps: 120 },
      { name: 'SPOOFING_LIQUIDITY_VACUUM', priceShockPct: -0.04, volMultiplier: 12.0, spreadWidenBps: 250 },
      { name: 'SHORT_SQUEEZE_EXPLOSION', priceShockPct: 0.18, volMultiplier: 9.0, spreadWidenBps: 180 },
      { name: 'MICROSTRUCTURE_NOISE_CHURN', priceShockPct: 0.01, volMultiplier: 4.0, spreadWidenBps: 60 }
    ];
    this.hardenedCycles = 0;
  }

  /**
   * Generates adversarial perturbed candle sequence from real base candles
   */
  generateAdversarialVector(baseCandles = [], scenarioName = 'FLASH_CRASH_CASCADE') {
    if (!baseCandles || baseCandles.length < 5) return baseCandles;
    
    const scenario = this.scenarios.find(s => s.name === scenarioName) || this.scenarios[0];
    const perturbed = JSON.parse(JSON.stringify(baseCandles));
    const lastIdx = perturbed.length - 1;

    // Apply asymmetric non-linear shock to final 3 candles
    for (let i = Math.max(0, lastIdx - 2); i <= lastIdx; i++) {
      const c = perturbed[i];
      const factor = (i === lastIdx ? 1.0 : 0.5) * scenario.priceShockPct;
      c.close = +(c.close * (1 + factor)).toFixed(4);
      c.high = +(Math.max(c.high, c.close * 1.02)).toFixed(4);
      c.low = +(Math.min(c.low, c.close * 0.98)).toFixed(4);
      c.volume = +(c.volume * scenario.volMultiplier).toFixed(2);
      c.isAdversarial = true;
      c.scenario = scenario.name;
    }

    return perturbed;
  }

  /**
   * Hardens DRL Actor-Critic weights by running policy through all 4 adversarial scenarios
   */
  hardenDRLPolicy(drlEngine, sampleCandles = []) {
    if (!drlEngine || !sampleCandles || sampleCandles.length === 0) return { status: 'SKIPPED' };

    const stressResults = [];
    this.scenarios.forEach(scenario => {
      const advCandles = this.generateAdversarialVector(sampleCandles, scenario.name);
      const advState = drlEngine.extractState(advCandles);
      const policyBefore = drlEngine.evaluatePolicy(advState);
      
      // Calculate stress penalty: reward defensive action (close to 0 or inverse hedge)
      const stressPenalty = Math.abs(policyBefore.action) > 0.8 ? -1.0 : 0.5;
      
      // Force gradient step on policy weights
      drlEngine.trainOnline(advState, policyBefore.action, stressPenalty, advState);
      const policyAfter = drlEngine.evaluatePolicy(advState);

      stressResults.push({
        scenario: scenario.name,
        actionBefore: policyBefore.action,
        actionHardened: policyAfter.action,
        resilienceScore: (1 - Math.abs(policyAfter.action)).toFixed(2)
      });
    });

    this.hardenedCycles++;
    logger.info(`🛡️ [Adversarial Defense] Hardened DRL policy against ${this.scenarios.length} extreme market shock vectors (Cycle #${this.hardenedCycles})`);

    return {
      status: 'HARDENED',
      cycles: this.hardenedCycles,
      stressResults,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new AdversarialTrainingEngine();
