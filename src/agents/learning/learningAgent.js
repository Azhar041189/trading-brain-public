const config = require('../../config');
const { createAgentLogger } = require('../../core/logger');
const database = require('../../core/database');
const continuousPolicyUpdater = require('../../core/continuousPolicyUpdater');
const moment = require('moment-timezone');

const logger = createAgentLogger('LearningAgent');

class LearningAgent {
  constructor() {
    this.name = 'learning';
    this.regimeHistory = [];
  }

  async runDailyReview() {
    logger.info('Starting daily learning review');
    const today = moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
    
    try {
      // 1. Fetch today's trades
      const trades = await this.getTodaysTrades(today);
      
      // 2. Analyze performance
      const performance = this.analyzePerformance(trades);
      
      // 3. Detect market regime
      const regime = await this.detectRegime(today);
      
      // 4. Analyze strategy performance
      const strategyStats = this.analyzeStrategies(trades);
      
      // 5. Generate insights
      const insights = this.generateInsights(performance, strategyStats, regime);
      
      // 6. Update model parameters
      const paramUpdates = this.calculateParameterUpdates(performance, strategyStats);
      
      // 7. Run Continuous RL Policy Updates (NEW - Milestone 2)
      logger.info('🧠 [Learning Agent] Running continuous RL policy updates...');
      const policyUpdateResult = await continuousPolicyUpdater.runDailyPolicyUpdate();
      
      // 8. Save learning record
      await this.saveLearningRecord(today, {
        trades: trades.length,
        performance,
        regime,
        strategyStats,
        insights,
        paramUpdates,
        policyUpdates: policyUpdateResult
      });
      
      logger.info('Daily learning review complete', { 
        trades: trades.length,
        winRate: performance.winRate,
        regime: regime.type,
        policyUpdates: policyUpdateResult
      });
      
      return { performance, regime, strategyStats, insights, paramUpdates, policyUpdates: policyUpdateResult };
      
    } catch (error) {
      logger.error('Daily learning review failed', { error: error.message });
      throw error;
    }
  }

  async getTodaysTrades(date) {
    try {
      const result = await database.query(
        `SELECT * FROM trades WHERE DATE(opened_at AT TIME ZONE 'Asia/Kolkata') = $1 ORDER BY opened_at`,
        [date]
      );
      return result.rows;
    } catch (error) {
      logger.warn('Could not fetch trades', { error: error.message });
      return [];
    }
  }

  analyzePerformance(trades) {
    if (trades.length === 0) {
      return { 
        totalTrades: 0, 
        winningTrades: 0, 
        losingTrades: 0, 
        winRate: 0, 
        totalPnL: 0, 
        avgWin: 0, 
        avgLoss: 0, 
        profitFactor: 0,
        expectancy: 0,
        maxDrawdown: 0,
        sharpeRatio: 0
      };
    }

    const closedTrades = trades.filter(t => t.status === 'closed' && t.pnl !== null);
    const totalTrades = closedTrades.length;
    
    if (totalTrades === 0) {
      return { totalTrades: 0, winRate: 0, totalPnL: 0 };
    }

    const winningTrades = closedTrades.filter(t => parseFloat(t.pnl) > 0);
    const losingTrades = closedTrades.filter(t => parseFloat(t.pnl) < 0);
    
    const winRate = winningTrades.length / totalTrades;
    const totalPnL = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);
    
    const avgWin = winningTrades.length > 0 
      ? winningTrades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0) / winningTrades.length 
      : 0;
    const avgLoss = losingTrades.length > 0 
      ? Math.abs(losingTrades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0) / losingTrades.length) 
      : 0;
    
    const grossProfit = winningTrades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
    
    // Max drawdown
    let peak = 0, maxDD = 0;
    let runningPnL = 0;
    for (const t of closedTrades) {
      runningPnL += parseFloat(t.pnl || 0);
      if (runningPnL > peak) peak = runningPnL;
      const dd = peak - runningPnL;
      if (dd > maxDD) maxDD = dd;
    }
    
    // Sharpe ratio (simplified)
    const returns = closedTrades.map(t => parseFloat(t.pnl_pct || 0));
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdReturn = Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length);
    const sharpeRatio = stdReturn > 0 ? avgReturn / stdReturn * Math.sqrt(252) : 0;

    return {
      totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: parseFloat(winRate.toFixed(4)),
      totalPnL: parseFloat(totalPnL.toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(2)),
      maxDrawdown: parseFloat(maxDD.toFixed(2)),
      sharpeRatio: parseFloat(sharpeRatio.toFixed(2)),
      avgHoldTime: this.calculateAvgHoldTime(closedTrades)
    };
  }

  calculateAvgHoldTime(trades) {
    if (trades.length === 0) return 0;
    
    let totalMinutes = 0;
    let count = 0;
    
    for (const t of trades) {
      if (t.opened_at && t.closed_at) {
        const open = new Date(t.opened_at).getTime();
        const close = new Date(t.closed_at).getTime();
        totalMinutes += (close - open) / (1000 * 60);
        count++;
      }
    }
    
    return count > 0 ? Math.round(totalMinutes / count) : 0;
  }

  async detectRegime(date) {
    try {
      // Fetch market data for regime detection
      const marketData = await this.fetchMarketDataForRegime(date);
      
      const regime = this.classifyRegime(marketData);
      
      this.regimeHistory.push({ date, ...regime });
      if (this.regimeHistory.length > 60) this.regimeHistory.shift();
      
      return regime;
    } catch (error) {
      logger.warn('Regime detection failed', { error: error.message });
      return { type: 'unknown', confidence: 0, details: {} };
    }
  }

  async fetchMarketDataForRegime(date) {
    // Fetch Nifty data for the period
    // Would use market data table or API
    return {
      niftyChange: 0, // placeholder
      vix: 15,
      advanceDecline: 1.2,
      fiiNet: 0,
      breadth: 0.55
    };
  }

  classifyRegime(data) {
    // Simplified regime classification
    // In production: use HMM, clustering, or ML model
    
    const { vix, advanceDecline, fiiNet, breadth } = data;
    
    let type = 'neutral', confidence = 0.5, details = {};
    
    if (vix < 12 && advanceDecline > 1.5 && breadth > 0.6) {
      type = 'bull_trending';
      confidence = 0.8;
    } else if (vix > 20 && advanceDecline < 0.7 && breadth < 0.4) {
      type = 'bear_trending';
      confidence = 0.8;
    } else if (vix > 18 && advanceDecline > 0.8 && advanceDecline < 1.2) {
      type = 'volatile_range';
      confidence = 0.7;
    } else if (vix < 15 && advanceDecline > 0.9 && advanceDecline < 1.1) {
      type = 'quiet_range';
      confidence = 0.6;
    } else if (fiiNet > 2000) {
      type = 'fii_driven_bull';
      confidence = 0.65;
    } else if (fiiNet < -2000) {
      type = 'fii_driven_bear';
      confidence = 0.65;
    }
    
    details = { vix, advanceDecline, fiiNet, breadth };
    
    // Check regime persistence
    const recentRegimes = this.regimeHistory.slice(-5).map(r => r.type);
    const sameCount = recentRegimes.filter(r => r === type).length;
    if (sameCount >= 3) confidence = Math.min(confidence + 0.1, 0.95);
    
    return { type, confidence: parseFloat(confidence.toFixed(2)), details };
  }

  analyzeStrategies(trades) {
    const strategyStats = {};
    
    for (const trade of trades) {
      if (trade.status !== 'closed' || trade.pnl === null) continue;
      
      const strategy = trade.strategy || 'unknown';
      if (!strategyStats[strategy]) {
        strategyStats[strategy] = {
          trades: 0, wins: 0, losses: 0, totalPnL: 0,
          avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0,
          winRate: 0, profitFactor: 0, expectancy: 0
        };
      }
      
      const stat = strategyStats[strategy];
      const pnl = parseFloat(trade.pnl);
      
      stat.trades++;
      stat.totalPnL += pnl;
      
      if (pnl > 0) {
        stat.wins++;
        stat.maxWin = Math.max(stat.maxWin, pnl);
      } else {
        stat.losses++;
        stat.maxLoss = Math.min(stat.maxLoss, pnl);
      }
    }
    
    // Calculate derived metrics
    for (const [strategy, stat] of Object.entries(strategyStats)) {
      if (stat.trades > 0) {
        stat.winRate = parseFloat((stat.wins / stat.trades).toFixed(4));
        stat.avgWin = stat.wins > 0 ? parseFloat((stat.totalPnL / stat.wins).toFixed(2)) : 0;
        stat.avgLoss = stat.losses > 0 ? parseFloat((Math.abs(stat.totalPnL) / stat.losses).toFixed(2)) : 0;
        
        const grossProfit = stat.wins * stat.avgWin;
        const grossLoss = stat.losses * stat.avgLoss;
        stat.profitFactor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : 0;
        stat.expectancy = parseFloat(((stat.winRate * stat.avgWin) - ((1 - stat.winRate) * stat.avgLoss)).toFixed(2));
      }
    }
    
    return strategyStats;
  }

  generateInsights(performance, strategyStats, regime) {
    const insights = [];
    
    // Overall performance insights
    if (performance.winRate > 0.6) {
      insights.push({ type: 'positive', category: 'performance', message: `Strong win rate: ${(performance.winRate * 100).toFixed(1)}%` });
    } else if (performance.winRate < 0.4) {
      insights.push({ type: 'negative', category: 'performance', message: `Low win rate: ${(performance.winRate * 100).toFixed(1)}% - review entry criteria` });
    }
    
    if (performance.profitFactor > 2) {
      insights.push({ type: 'positive', category: 'risk', message: `Excellent profit factor: ${performance.profitFactor.toFixed(2)}` });
    } else if (performance.profitFactor < 1.2) {
      insights.push({ type: 'negative', category: 'risk', message: `Weak profit factor: ${performance.profitFactor.toFixed(2)} - improve risk:reward` });
    }
    
    if (performance.maxDrawdown > 5000) {
      insights.push({ type: 'warning', category: 'risk', message: `High drawdown: ₹${performance.maxDrawdown.toFixed(0)} - reduce position sizes` });
    }
    
    // Strategy insights
    const sortedStrategies = Object.entries(strategyStats)
      .filter(([, s]) => s.trades >= 3)
      .sort((a, b) => b[1].expectancy - a[1].expectancy);
    
    if (sortedStrategies.length > 0) {
      const best = sortedStrategies[0];
      insights.push({ type: 'info', category: 'strategy', message: `Best strategy: ${best[0]} (expectancy: ${best[1].expectancy.toFixed(2)})` });
      
      const worst = sortedStrategies[sortedStrategies.length - 1];
      if (worst[1].expectancy < 0) {
        insights.push({ type: 'negative', category: 'strategy', message: `Underperforming: ${worst[0]} (expectancy: ${worst[1].expectancy.toFixed(2)}) - consider disabling` });
      }
    }
    
    // Regime insights
    if (regime.type === 'volatile_range') {
      insights.push({ type: 'info', category: 'regime', message: 'Volatile range detected - favor mean reversion strategies' });
    } else if (regime.type.includes('trending')) {
      insights.push({ type: 'info', category: 'regime', message: `${regime.type} detected - favor momentum strategies` });
    }
    
    return insights;
  }

  calculateParameterUpdates(performance, strategyStats) {
    const updates = {};
    
    // Adjust risk per trade based on recent performance
    if (performance.totalTrades >= 20) {
      if (performance.winRate > 0.55 && performance.profitFactor > 1.5) {
        // Performing well - can slightly increase risk
        updates.maxRiskPerTrade = Math.min(config.trading.maxRiskPerTrade * 1.05, 0.03);
      } else if (performance.winRate < 0.45 || performance.profitFactor < 1.2) {
        // Underperforming - reduce risk
        updates.maxRiskPerTrade = Math.max(config.trading.maxRiskPerTrade * 0.9, 0.01);
      }
    }
    
    // Adjust strategy weights
    const strategyWeights = {};
    for (const [strategy, stat] of Object.entries(strategyStats)) {
      if (stat.trades >= 5) {
        if (stat.expectancy > 0) {
          strategyWeights[strategy] = Math.min(1.5, 1 + stat.expectancy / 1000);
        } else {
          strategyWeights[strategy] = Math.max(0.3, 1 + stat.expectancy / 500);
        }
      }
    }
    updates.strategyWeights = strategyWeights;
    
    // Adjust stop loss multiplier based on volatility regime
    if (this.regimeHistory.length > 0) {
      const recentRegime = this.regimeHistory[this.regimeHistory.length - 1];
      if (recentRegime.type === 'volatile_range') {
        updates.defaultStopLossAtrMult = Math.min(config.trading.defaultStopLossAtrMult * 1.2, 3);
      } else if (recentRegime.type.includes('trending')) {
        updates.defaultStopLossAtrMult = Math.max(config.trading.defaultStopLossAtrMult * 0.9, 1.5);
      }
    }
    
    return updates;
  }

  async saveLearningRecord(date, data) {
    try {
      await database.query(
        `CREATE TABLE IF NOT EXISTS learning_records (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          date DATE UNIQUE NOT NULL,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_learning_date ON learning_records(date);`
      );
      
      await database.query(
        `INSERT INTO learning_records (date, data) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET data = $2, created_at = NOW()`,
        [date, JSON.stringify(data)]
      );
      
      logger.info('Learning record saved', { date });
    } catch (error) {
      logger.error('Save learning record failed', { error: error.message });
    }
  }

  async getLearningHistory(days = 30) {
    try {
      const result = await database.query(
        `SELECT date, data FROM learning_records 
         WHERE date >= $1 ORDER BY date DESC`,
        [moment().subtract(days, 'days').format('YYYY-MM-DD')]
      );
      return result.rows;
    } catch (error) {
      return [];
    }
  }
}

module.exports = new LearningAgent();

// CLI
if (require.main === module) {
  const agent = new LearningAgent();
  agent.runDailyReview()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}