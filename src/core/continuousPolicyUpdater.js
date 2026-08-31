const config = require('../config');
const database = require('./database');
const { createAgentLogger } = require('./logger');
const ppoEngine = require('./drlPPOEngine');
const metaLearning = require('./metaLearningEngine');
const moment = require('moment-timezone');

const logger = createAgentLogger('ContinuousPolicyUpdater');

/**
 * ContinuousPolicyUpdater - Daily RL weight updates from realized trade outcomes
 * Reads closed trades from SQLite, performs PPO gradient steps + MAML/Reptile meta-updates
 * Persists updated weights for next session's compounding edge.
 */
class ContinuousPolicyUpdater {
  constructor() {
    this.name = 'continuousPolicyUpdater';
    this.weightVersion = 1;
    this.lastUpdateDate = null;
    this.ppoUpdateCount = 0;
    this.metaUpdateCount = 0;
  }

  /**
   * Main entry point - call daily from learning agent or scheduler
   */
  async runDailyPolicyUpdate() {
    const today = moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
    
    if (this.lastUpdateDate === today) {
      logger.info('Policy already updated today', { date: today });
      return { skipped: true, date: today };
    }

    try {
      logger.info('🧠 [Continuous Policy Updater] Starting daily RL weight update...');

      // 1. Fetch closed trades from last N days (rolling window)
      const lookbackDays = 30;
      const trades = await this.getClosedTrades(lookbackDays);
      
      if (trades.length === 0) {
        logger.info('No closed trades for policy update');
        return { trades: 0, ppoUpdates: 0, metaUpdates: 0 };
      }

      logger.info(`Fetched ${trades.length} closed trades for policy training`);

      // 2. Group trades by symbol/strategy for regime-specific learning
      const tradesByStrategy = this.groupTradesByStrategy(trades);
      
      // 3. PPO Weight Updates - gradient step on realized P&L
      let ppoUpdates = 0;
      for (const [strategy, strategyTrades] of Object.entries(tradesByStrategy)) {
        if (strategyTrades.length < 3) continue; // Need minimum samples
        
        const ppoResult = await this.updatePPOWeights(strategy, strategyTrades);
        ppoUpdates += ppoResult.steps;
      }

      // 4. MAML/Reptile Meta-Updates - adapt base parameters to recent regimes
      const metaResult = await this.updateMetaParameters(trades);
      
      // 5. Persist updated weights
      await this.persistWeights();

      this.lastUpdateDate = today;
      this.ppoUpdateCount += ppoUpdates;
      this.metaUpdateCount += metaResult.updates;

      logger.info('✅ [Continuous Policy Updater] Daily update complete', {
        date: today,
        tradesProcessed: trades.length,
        ppoUpdates,
        metaUpdates: metaResult.updates,
        totalPPOUpdates: this.ppoUpdateCount,
        totalMetaUpdates: this.metaUpdateCount
      });

      return {
        date: today,
        tradesProcessed: trades.length,
        ppoUpdates,
        metaUpdates: metaResult.updates,
        weightVersion: this.weightVersion
      };

    } catch (error) {
      logger.error('Daily policy update failed', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  /**
   * Fetch closed trades from database with market data context
   */
  async getClosedTrades(days = 30) {
    try {
      const startDate = moment().subtract(days, 'days').format('YYYY-MM-DD');
      
      // Get trades from learning_records or trades table
      // Using the existing learning_records table which has daily performance data
      const result = await database.query(`
        SELECT 
          date,
          data->>'performance' as performance,
          data->>'regime' as regime,
          data->>'strategyStats' as strategyStats,
          data->>'paramUpdates' as paramUpdates
        FROM learning_records 
        WHERE date >= $1 AND date <= $2
        ORDER BY date ASC
      `, [startDate, moment().format('YYYY-MM-DD')]);

      if (result.rows.length === 0) return [];

      // Reconstruct trades from daily performance records
      const trades = [];
      for (const row of result.rows) {
        try {
          const performance = JSON.parse(row.performance || '{}');
          const strategyStats = JSON.parse(row.strategyStats || '{}');
          const regime = JSON.parse(row.regime || '{}');
          
          // Create synthetic trade entries for each strategy
          for (const [strategy, stats] of Object.entries(strategyStats)) {
            if (stats.trades > 0) {
              const avgPnL = stats.totalPnL / stats.trades;
              for (let i = 0; i < stats.trades; i++) {
                // Distribute wins/losses proportionally
                const isWin = i < stats.wins;
                const pnl = isWin ? stats.avgWin : -stats.avgLoss;
                
                trades.push({
                  date: row.date,
                  symbol: strategy, // strategy acts as symbol here
                  strategy,
                  pnl,
                  isWin,
                  regime: regime.type || 'unknown',
                  regimeConfidence: regime.confidence || 0.5
                });
              }
            }
          }
        } catch (e) {
          logger.warn('Failed to parse learning record', { date: row.date, error: e.message });
        }
      }

      return trades;
    } catch (error) {
      logger.warn('Could not fetch trades for policy update', { error: error.message });
      return [];
    }
  }

  /**
   * Group trades by strategy for targeted learning
   */
  groupTradesByStrategy(trades) {
    const grouped = {};
    for (const trade of trades) {
      const key = trade.strategy || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(trade);
    }
    return grouped;
  }

  /**
   * Update PPO Actor-Critic weights using realized trade outcomes
   * Each winning trade = positive reward, losing trade = negative reward
   */
  async updatePPOWeights(strategy, trades) {
    let steps = 0;
    
    // Extract state vectors from trade context
    for (const trade of trades) {
      try {
        // Build state vector from trade features
        const state = this.buildStateVector(trade);
        const action = trade.isWin ? 0.8 : -0.6; // LONG/short proxy
        const reward = this.calculateReward(trade);
        
        // Get next state (use same for simplicity, could use next trade)
        const nextState = state;
        const oldProb = 0.7; // prior policy probability

        // Perform PPO clipped update
        ppoEngine.trainPPOClipped(state, action, reward, nextState, oldProb);
        steps++;
      } catch (e) {
        logger.warn('PPO update step failed', { strategy, trade: trade.date, error: e.message });
      }
    }

    if (steps > 0) {
      logger.info(`PPO weights updated for ${strategy}`, { steps });
    }

    return { steps };
  }

  /**
   * Build 12-dimensional state vector from trade features
   */
  buildStateVector(trade) {
    const regimeOneHot = {
      'bull_trending': [1,0,0,0],
      'bear_trending': [0,1,0,0],
      'volatile_range': [0,0,1,0],
      'quiet_range': [0,0,0,1],
      'fii_driven_bull': [1,0,0,0],
      'fii_driven_bear': [0,1,0,0],
      'unknown': [0.25,0.25,0.25,0.25]
    };

    const regimeVec = regimeOneHot[trade.regime] || regimeOneHot.unknown;
    
    return [
      trade.pnl > 0 ? 1 : -1,           // 0: outcome direction
      Math.abs(trade.pnl) / 1000,       // 1: normalized magnitude
      trade.regimeConfidence,            // 2: regime confidence
      regimeVec[0],                      // 3: bull trending
      regimeVec[1],                      // 4: bear trending
      regimeVec[2],                      // 5: volatile range
      regimeVec[3],                      // 6: quiet range
      trade.isWin ? 1 : 0,               // 7: win flag
      Math.min(1, Math.abs(trade.pnl) / 5000), // 8: scaled PnL
      0.5,                               // 9: placeholder volatility
      0.5,                               // 10: placeholder momentum
      0.5                                // 11: placeholder volume
    ];
  }

  /**
   * Calculate reward signal from trade outcome
   * Scales P&L to [-1, 1] range for stable gradients
   */
  calculateReward(trade) {
    const baseReward = trade.isWin ? 1 : -1;
    const magnitude = Math.min(1, Math.abs(trade.pnl) / 2000); // Normalize to $2k
    return baseReward * (0.5 + 0.5 * magnitude);
  }

  /**
   * MAML/Reptile Meta-Update: Pull base parameters toward task-specific champions
   * Adapts learning rate, risk multiplier, volatility threshold based on recent regimes
   */
  async updateMetaParameters(trades) {
    // Group trades by regime
    const tradesByRegime = {};
    for (const trade of trades) {
      const regime = trade.regime || 'unknown';
      if (!tradesByRegime[regime]) tradesByRegime[regime] = [];
      tradesByRegime[regime].push(trade);
    }

    let updates = 0;

    // For each regime with enough trades, compute adapted params and pull meta weights
    for (const [regime, regimeTrades] of Object.entries(tradesByRegime)) {
      if (regimeTrades.length < 5) continue;

      // Create synthetic candles from trade P&L sequence
      const syntheticCandles = this.tradesToSyntheticCandles(regimeTrades);
      
      // Get adapted parameters via MAML inner loop
      const adaptedParams = metaLearning.adaptFewShot(syntheticCandles, regime);
      
      // Reptile meta-update: pull base params toward adapted
      metaLearning.metaUpdateReptile(adaptedParams, 0.05); // Small step size
      updates++;
      
      logger.info(`Meta-update applied for regime ${regime}`, { 
        trades: regimeTrades.length,
        adaptedLR: adaptedParams.learningRate,
        adaptedRisk: adaptedParams.riskMultiplier
      });
    }

    return { updates };
  }

  /**
   * Convert trade sequence to synthetic candles for MAML adaptation
   */
  tradesToSyntheticCandles(trades) {
    const candles = [];
    let price = 100; // Base price
    
    for (const trade of trades) {
      const change = trade.pnl > 0 ? 0.005 : -0.005; // 0.5% move per trade
      price *= (1 + change);
      candles.push({
        open: price / (1 + change),
        high: price * 1.002,
        low: price * 0.998,
        close: price,
        volume: 1000000
      });
    }
    
    return candles;
  }

  /**
   * Persist PPO and Meta-Learning weights to disk
   */
  async persistWeights() {
    try {
      const weights = {
        version: ++this.weightVersion,
        timestamp: new Date().toISOString(),
        ppo: {
          w1_actor: ppoEngine.w1_actor,
          b1_actor: ppoEngine.b1_actor,
          w2_actor: ppoEngine.w2_actor,
          b2_actor: ppoEngine.b2_actor,
          w1_critic: ppoEngine.w1_critic,
          b1_critic: ppoEngine.b1_critic,
          w2_critic: ppoEngine.w2_critic,
          b2_critic: ppoEngine.b2_critic,
          learningRate: ppoEngine.learningRate,
          totalUpdates: this.ppoUpdateCount
        },
        meta: {
          metaParameters: metaLearning.metaParameters,
          totalUpdates: this.metaUpdateCount
        }
      };

      // Save to JSON file for persistence across restarts
      const fs = require('fs');
      const path = require('path');
      const weightsDir = path.join(__dirname, '../../data/weights');
      if (!fs.existsSync(weightsDir)) {
        fs.mkdirSync(weightsDir, { recursive: true });
      }
      
      const weightsFile = path.join(weightsDir, `policy_weights_v${this.weightVersion}.json`);
      fs.writeFileSync(weightsFile, JSON.stringify(weights, null, 2));
      
      // Also save as latest
      const latestFile = path.join(weightsDir, 'policy_weights_latest.json');
      fs.writeFileSync(latestFile, JSON.stringify(weights, null, 2));

      // Store in database for audit trail
      await database.query(`
        CREATE TABLE IF NOT EXISTS policy_weights (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          version INTEGER NOT NULL,
          weights JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_policy_version ON policy_weights(version);
      `);
      
      await database.query(`
        INSERT INTO policy_weights (version, weights) VALUES ($1, $2)
      `, [this.weightVersion, JSON.stringify(weights)]);

      logger.info('Policy weights persisted', { version: this.weightVersion, file: weightsFile });
    } catch (error) {
      logger.error('Failed to persist weights', { error: error.message });
    }
  }

  /**
   * Load persisted weights on startup
   */
  async loadWeights() {
    try {
      const fs = require('fs');
      const path = require('path');
      const latestFile = path.join(__dirname, '../../data/weights/policy_weights_latest.json');
      
      if (fs.existsSync(latestFile)) {
        const data = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
        
        // Restore PPO weights
        if (data.ppo) {
          Object.assign(ppoEngine, {
            w1_actor: data.ppo.w1_actor,
            b1_actor: data.ppo.b1_actor,
            w2_actor: data.ppo.w2_actor,
            b2_actor: data.ppo.b2_actor,
            w1_critic: data.ppo.w1_critic,
            b1_critic: data.ppo.b1_critic,
            w2_critic: data.ppo.w2_critic,
            b2_critic: data.ppo.b2_critic,
            learningRate: data.ppo.learningRate
          });
          this.ppoUpdateCount = data.ppo.totalUpdates || 0;
        }
        
        // Restore Meta-Learning params
        if (data.meta) {
          Object.assign(metaLearning.metaParameters, data.meta.metaParameters);
          this.metaUpdateCount = data.meta.totalUpdates || 0;
        }
        
        this.weightVersion = data.version || 1;
        
        logger.info('Policy weights loaded from disk', { 
          version: this.weightVersion,
          ppoUpdates: this.ppoUpdateCount,
          metaUpdates: this.metaUpdateCount
        });
        
        return true;
      }
    } catch (error) {
      logger.warn('Could not load persisted weights, starting fresh', { error: error.message });
    }
    return false;
  }

  /**
   * Get policy update statistics for dashboard/monitoring
   */
  getStats() {
    return {
      weightVersion: this.weightVersion,
      lastUpdateDate: this.lastUpdateDate,
      totalPPOUpdates: this.ppoUpdateCount,
      totalMetaUpdates: this.metaUpdateCount,
      ppoLearningRate: ppoEngine.learningRate,
      metaParams: metaLearning.metaParameters
    };
  }
}

module.exports = new ContinuousPolicyUpdater();