const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('HawkesProcess');

/**
 * HawkesOrderArrivalEngine
 * Self-exciting point process modeling micro-tick cluster intensity:
 * lambda(t) = mu + sum(alpha * exp(-beta * (t - t_i)))
 * Detects predatory HFT order clustering and stop-hunt cascade cascades.
 */
class HawkesOrderArrivalEngine {
  constructor() {
    this.mu = 1.2; // Baseline arrival intensity
    this.alpha = 0.85; // Excitation jump magnitude
    this.beta = 1.40;  // Exponential decay rate
    this.tickHistory = [];
    this.maxTicks = 150;
  }

  recordTick(symbol, price, qty, side) {
    const now = Date.now() / 1000;
    const tick = { timestamp: now, symbol, price, qty, side };
    this.tickHistory.push(tick);
    if (this.tickHistory.length > this.maxTicks) this.tickHistory.shift();

    return this.computeIntensity(now);
  }

  computeIntensity(currentTime = Date.now() / 1000) {
    let intensity = this.mu;

    for (let i = this.tickHistory.length - 1; i >= 0; i--) {
      const dt = currentTime - this.tickHistory[i].timestamp;
      if (dt > 15) break; // Decay negligible after 15s
      intensity += this.alpha * Math.exp(-this.beta * dt);
    }

    const isPredatoryCluster = intensity > 4.5;
    const cascadeRisk = Math.min(100, Math.round((intensity / 6.0) * 100));

    return {
      intensity: parseFloat(intensity.toFixed(2)),
      baseline: this.mu,
      isPredatoryCluster,
      cascadeRiskPct: cascadeRisk,
      state: isPredatoryCluster ? 'PREDATORY_HFT_CASCADE_ACTIVE' : 'ORGANIC_LIQUIDITY_FLOW'
    };
  }
}

module.exports = new HawkesOrderArrivalEngine();
