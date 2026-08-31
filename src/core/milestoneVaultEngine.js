const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('MilestoneVault');
const sessionStateStore = require('./sessionStateStore');

/**
 * MilestoneVaultEngine - Implements Principal Payback, House Money Compounding,
 * Profit Lock Sweeps, and Defensive Sizing.
 */
class MilestoneVaultEngine {
  constructor(seedCapital = 1000, targetGoal = 100000) {
    this.seedCapital = seedCapital;
    this.targetGoal = targetGoal;
    
    // Restore persistent session state
    const saved = sessionStateStore.getState().milestones || {};
    this.userSavingsVault = saved.userSavingsVault || 0;
    this.agentTradingPool = saved.agentTradingPool || seedCapital;
    this.principalReturned = saved.principalReturned || false;
    this.consecutiveLosses = saved.consecutiveLosses || 0;
    this.consecutiveWins = saved.consecutiveWins || 0;
    
    // Milestone Thresholds (Multipliers of seed)
    this.milestones = [
      { stage: 1, target: seedCapital * 2, name: 'Stage 1: Principal Payback (2x)', achieved: this.principalReturned },
      { stage: 2, target: seedCapital * 5, name: 'Stage 2: Growth Milestone (5x)', achieved: this.agentTradingPool >= seedCapital * 5 },
      { stage: 3, target: seedCapital * 25, name: 'Stage 3: Expansion Milestone (25x)', achieved: this.agentTradingPool >= seedCapital * 25 },
      { stage: 4, target: targetGoal, name: 'Stage 4: Ultimate Scale (100x)', achieved: this.agentTradingPool >= targetGoal }
    ];
  }

  /**
   * Register a trade P&L and check milestone triggers
   */
  recordTrade(pnl) {
    this.agentTradingPool += pnl;

    if (pnl > 0) {
      this.consecutiveWins++;
      this.consecutiveLosses = 0;
    } else if (pnl < 0) {
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
    }

    logger.info(`🏦 [Vault Engine] Trade P&L: ₹${pnl.toFixed(2)} | Active Pool: ₹${this.agentTradingPool.toFixed(2)} | User Vault: ₹${this.userSavingsVault.toFixed(2)}`);

    this._evaluateMilestones();

    // Persist to disk
    sessionStateStore.saveState({
      milestones: {
        userSavingsVault: this.userSavingsVault,
        agentTradingPool: this.agentTradingPool,
        principalReturned: this.principalReturned,
        consecutiveWins: this.consecutiveWins,
        consecutiveLosses: this.consecutiveLosses
      }
    });
  }

  /**
   * Internal Milestone & Sweep Evaluator
   */
  _evaluateMilestones() {
    // 1. Milestone 1: 2x Principal Payback
    const m1 = this.milestones[0];
    if (!m1.achieved && this.agentTradingPool >= m1.target) {
      m1.achieved = true;
      this.principalReturned = true;
      
      // Pay back 100% of seed capital to user savings vault
      this.userSavingsVault += this.seedCapital;
      this.agentTradingPool -= this.seedCapital; // Agents continue trading with remaining profit ("House Money")
      
      logger.info(`🎉 [MILESTONE 1 ACHIEVED] 100% Principal (₹${this.seedCapital}) Returned to User Vault! Agents now trade on 100% House Money.`);
    }

    // 2. Milestone 2: 5x Target (Sweep 20% to Savings Vault)
    const m2 = this.milestones[1];
    if (!m2.achieved && this.agentTradingPool >= m2.target) {
      m2.achieved = true;
      const sweepAmount = this.agentTradingPool * 0.20;
      this.userSavingsVault += sweepAmount;
      this.agentTradingPool -= sweepAmount;
      logger.info(`🏆 [MILESTONE 2 ACHIEVED] 5x Growth reached! Swept 20% (₹${sweepAmount.toFixed(2)}) to User Savings Vault.`);
    }

    // 3. Milestone 3: 25x Target (Sweep 20% to Savings Vault)
    const m3 = this.milestones[2];
    if (!m3.achieved && this.agentTradingPool >= m3.target) {
      m3.achieved = true;
      const sweepAmount = this.agentTradingPool * 0.20;
      this.userSavingsVault += sweepAmount;
      this.agentTradingPool -= sweepAmount;
      logger.info(`🚀 [MILESTONE 3 ACHIEVED] 25x Expansion reached! Swept 20% (₹${sweepAmount.toFixed(2)}) to User Savings Vault.`);
    }

    // 4. Milestone 4: Ultimate Target (Goal Achieved)
    const m4 = this.milestones[3];
    if (!m4.achieved && (this.agentTradingPool + this.userSavingsVault) >= this.targetGoal) {
      m4.achieved = true;
      logger.info(`👑 [ULTIMATE GOAL REACHED] ₹${this.targetGoal.toLocaleString()} Portfolio Target Achieved!`);
    }
  }

  /**
   * Get dynamic position sizing defensive multiplier (Anti-Martingale)
   */
  getDefensiveMultiplier() {
    // If 2 or more consecutive losses, cut size by 50% to defend capital
    if (this.consecutiveLosses >= 2) {
      return 0.50;
    }
    // If on a hot streak (3+ wins), allow 100% optimal size
    return 1.00;
  }

  /**
   * Get complete status report
   */
  getStatus() {
    const totalEquity = this.agentTradingPool + this.userSavingsVault;
    const progressPct = Math.min(100, (totalEquity / this.targetGoal) * 100);

    return {
      seedCapital: this.seedCapital,
      targetGoal: this.targetGoal,
      userSavingsVault: parseFloat(this.userSavingsVault.toFixed(2)),
      agentTradingPool: parseFloat(this.agentTradingPool.toFixed(2)),
      totalEquity: parseFloat(totalEquity.toFixed(2)),
      principalReturned: this.principalReturned,
      consecutiveLosses: this.consecutiveLosses,
      consecutiveWins: this.consecutiveWins,
      defensiveMultiplier: this.getDefensiveMultiplier(),
      progressPct: parseFloat(progressPct.toFixed(2)),
      milestones: this.milestones
    };
  }
}

module.exports = new MilestoneVaultEngine(1000, 100000);
