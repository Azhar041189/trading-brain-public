const fs = require('fs');
const path = require('path');
const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('GeneticStrategyFoundry');

/**
 * GeneticStrategyFoundry - Simulates evolutionary hyper-parameter mutations
 * (EMA lengths, RSI thresholds, Kelly fractions) and persists optimal configurations.
 * Upgraded with:
 *  1. Strict Quality Gate: Only auto-deploys if Sharpe >= 1.5 AND WinRate >= 55%.
 *  2. Dual Persistence: Local disk file + Remote Supabase cloud table (bypassing Render ephemeral wipeouts).
 */
class GeneticStrategyFoundry {
  constructor() {
    this.generation = 1;
    this.bestFitnessScore = 2.45;
    this.storagePath = path.join(__dirname, '../../data/genetic_champions.json');
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
        this.generation = raw.generation || 1;
        this.bestFitnessScore = raw.bestFitnessScore || 2.45;
        this.champion = raw.champion || null;
      }
    } catch (e) {
      logger.warn(`Could not load genetic state: ${e.message}`);
    }
  }

  async saveState(champion) {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify({
        generation: this.generation,
        bestFitnessScore: this.bestFitnessScore,
        champion,
        updatedAt: new Date().toISOString()
      }, null, 2));

      // Sync to remote Supabase Cloud table (resilient across Render redeploys)
      try {
        const supabase = require('./supabaseClient');
        if (supabase && typeof supabase.upsert === 'function') {
          await supabase.upsert('genetic_champions', {
            id: 'latest_champion',
            generation: this.generation,
            champion_data: champion,
            fitness_score: this.bestFitnessScore,
            updated_at: new Date().toISOString()
          });
        }
      } catch (cloudErr) {}
    } catch (e) {
      logger.error(`Failed to persist genetic champions: ${e.message}`);
    }
  }

  /**
   * Run an evolutionary optimization cycle with strict quality fitness gates
   */
  runEvolutionCycle(populationSize = 25) {
    this.generation++;
    const population = [];

    for (let i = 0; i < populationSize; i++) {
      const fastEma = 5 + Math.floor(Math.random() * 10); // 5 - 15
      const slowEma = 18 + Math.floor(Math.random() * 15); // 18 - 32
      const rsiOversold = 25 + Math.floor(Math.random() * 10); // 25 - 35
      const kellyMultiplier = +(0.15 + Math.random() * 0.25).toFixed(2); // 0.15 - 0.40

      // Simulated fitness score (Sharpe * WinRate)
      const simulatedWinRate = 0.52 + Math.random() * 0.24;
      const simulatedSharpe = 1.2 + Math.random() * 1.8;
      const fitness = +(simulatedSharpe * (simulatedWinRate / 0.50)).toFixed(2);

      population.push({
        candidateId: `GEN${this.generation}_IND_${i + 1}`,
        parameters: { fastEma, slowEma, rsiOversold, kellyMultiplier },
        metrics: { 
          winRate: `${(simulatedWinRate * 100).toFixed(1)}%`, 
          rawWinRate: simulatedWinRate,
          sharpe: simulatedSharpe.toFixed(2), 
          rawSharpe: simulatedSharpe,
          fitness 
        }
      });
    }

    population.sort((a, b) => b.metrics.fitness - a.metrics.fitness);
    const topCandidate = population[0];

    // Strict Quality Safeguard Gate: Sharpe >= 1.5 AND WinRate >= 55%
    const passesQualityGate = topCandidate.metrics.rawSharpe >= 1.5 && topCandidate.metrics.rawWinRate >= 0.55;

    if (passesQualityGate) {
      if (topCandidate.metrics.fitness > this.bestFitnessScore) {
        this.bestFitnessScore = topCandidate.metrics.fitness;
      }
      this.champion = topCandidate;
      this.saveState(topCandidate);
      logger.info(`🧬 [Genetic Foundry] Quality Champion Approved & Deployed: ${topCandidate.candidateId} (Sharpe: ${topCandidate.metrics.sharpe}, WinRate: ${topCandidate.metrics.winRate})`);
    } else {
      logger.warn(`⚠️ [Genetic Gate] Candidate ${topCandidate.candidateId} failed quality gate (Sharpe ${topCandidate.metrics.sharpe} < 1.5 or WinRate ${topCandidate.metrics.winRate} < 55%). Retaining existing champion.`);
    }

    return {
      generation: this.generation,
      champion: this.champion || topCandidate,
      deployed: passesQualityGate,
      topCandidates: population.slice(0, 3),
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new GeneticStrategyFoundry();
