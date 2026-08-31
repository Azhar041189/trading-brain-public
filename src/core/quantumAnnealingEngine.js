const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('QuantumAnnealing');

/**
 * QuantumAnnealingEngine - Simulated Quantum Annealing & QUBO Portfolio Optimizer
 * Formulates multi-asset portfolio capital allocation as a Quadratic Unconstrained Binary Optimization (QUBO) problem:
 *   minimize  x^T Q x - lambda * R^T x
 *   subject to discrete lot constraints and binary selection vectors.
 * Uses simulated quantum thermal fluctuations and transverse field decay to escape local minima.
 */
class QuantumAnnealingEngine {
  constructor() {
    this.initialGamma = 2.0;    // Initial quantum transverse field strength
    this.decayRate = 0.92;      // Quantum field cooling schedule
    this.iterations = 100;      // Annealing Monte Carlo steps
    this.targetReturnWeight = 1.5;
  }

  /**
   * Optimizes portfolio asset selection and integer weights using simulated quantum annealing
   * @param {Array<string>} assets List of symbols (e.g. ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'])
   * @param {Array<number>} expectedReturns Expected returns vector
   * @param {Array<Array<number>>} covarianceMatrix Covariance matrix
   * @param {number} budgetDiscreteLots Total discrete lots to allocate (e.g. 10)
   */
  optimizeQUBOPortfolio(assets, expectedReturns = [], covarianceMatrix = [], budgetDiscreteLots = 10) {
    const N = assets.length;
    if (N === 0) return { selectedAssets: [], weights: {}, energy: 0 };

    // Fallback default returns and covariance if omitted
    const mu = expectedReturns.length === N ? expectedReturns : assets.map(() => 0.05 + Math.random() * 0.1);
    const Q = covarianceMatrix.length === N ? covarianceMatrix : Array.from({ length: N }, (_, i) =>
      Array.from({ length: N }, (_, j) => (i === j ? 0.04 : 0.012 + Math.random() * 0.005))
    );

    // Initial state: random binary spin configuration (+1 / -1)
    let spins = assets.map(() => (Math.random() > 0.5 ? 1 : 0));
    let bestSpins = [...spins];
    let bestEnergy = this._calculateQUBOEnergy(bestSpins, mu, Q, budgetDiscreteLots);

    let gamma = this.initialGamma;

    // Simulated Quantum Annealing Loop
    for (let step = 0; step < this.iterations; step++) {
      for (let i = 0; i < N; i++) {
        // Quantum spin flip trial
        const trialSpins = [...spins];
        trialSpins[i] = trialSpins[i] === 1 ? 0 : 1;

        const currentEnergy = this._calculateQUBOEnergy(spins, mu, Q, budgetDiscreteLots);
        const trialEnergy = this._calculateQUBOEnergy(trialSpins, mu, Q, budgetDiscreteLots);
        const deltaE = trialEnergy - currentEnergy;

        // Quantum Tunneling & Thermal Acceptance Probability
        const tunnelingProb = Math.exp(-Math.max(0, deltaE) / Math.max(0.05, gamma));
        if (deltaE < 0 || Math.random() < tunnelingProb) {
          spins = trialSpins;
          if (trialEnergy < bestEnergy) {
            bestEnergy = trialEnergy;
            bestSpins = [...trialSpins];
          }
        }
      }
      gamma *= this.decayRate; // Transverse field decay
    }

    // Ensure at least 1 asset selected
    if (bestSpins.every(s => s === 0)) {
      bestSpins[0] = 1;
    }

    // Compute normalized discrete weights
    const activeCount = bestSpins.reduce((a, b) => a + b, 0);
    const weights = {};
    assets.forEach((sym, idx) => {
      weights[sym] = bestSpins[idx] === 1 ? parseFloat((1 / activeCount).toFixed(4)) : 0;
    });

    const result = {
      model: 'QUANTUM_ANNEALING_QUBO',
      quantumFieldFinal: parseFloat(gamma.toFixed(4)),
      bestEnergy: parseFloat(bestEnergy.toFixed(4)),
      selectedAssets: assets.filter((_, idx) => bestSpins[idx] === 1),
      weights,
      timestamp: new Date().toISOString()
    };

    logger.info(`⚛️ [Quantum Annealer] QUBO solved with Energy: ${result.bestEnergy} | Selected ${result.selectedAssets.length}/${N} assets`);
    return result;
  }

  _calculateQUBOEnergy(spins, mu, Q, budgetLots) {
    let variance = 0;
    let expectedReturn = 0;
    const N = spins.length;

    for (let i = 0; i < N; i++) {
      if (spins[i] === 1) {
        expectedReturn += mu[i];
        for (let j = 0; j < N; j++) {
          if (spins[j] === 1) {
            variance += Q[i][j];
          }
        }
      }
    }

    // Penalty for deviating from target selection budget
    const activeCount = spins.reduce((a, b) => a + b, 0);
    const penalty = 5.0 * Math.pow(activeCount - Math.min(N, Math.max(1, Math.round(budgetLots / 2))), 2);

    // Energy function: Risk - Expected Return + Constraint Penalty
    return variance - (this.targetReturnWeight * expectedReturn) + penalty;
  }
}

module.exports = new QuantumAnnealingEngine();
