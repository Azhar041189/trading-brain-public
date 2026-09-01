const config = require('../config');
const { createAgentLogger } = require('./logger');
const sessionStateStore = require('./sessionStateStore');
const logger = createAgentLogger('CompoundingEngine');

/**
 * CompoundingEngine - Implements Dynamic Profit Reinvestment and Fractional Kelly Criterion.
 * Automatically compounds realized trading profits into subsequent trade allocations.
 */
class CompoundingEngine {
  constructor(initialCapital = config.trading.initialCapital || 100000) {
    this.initialCapital = initialCapital;
    // Restore persistent session PnL
    const saved = sessionStateStore.getState();
    this.realizedPnL = saved.realizedPnL || 0;
    this.fractionalKellyMultiplier = 0.25; // Quarter-Kelly for conservative, mathematically optimal compounding
  }

  /**
   * Get current dynamic compounded portfolio equity
   */
  getCompoundedEquity(marketKey = 'CRYPTO') {
    const defaultSeed = (marketKey === 'IN') ? 2500 : 50;
    const base = this.initialCapital && this.initialCapital <= 1000 ? this.initialCapital : defaultSeed;
    return Math.max(5, base + this.realizedPnL);
  }

  /**
   * Register realized profit or loss from closed trade
   */
  recordTradePnL(pnl, marketKey = 'IN') {
    this.realizedPnL += pnl;
    const milestoneVault = require('./milestoneVaultEngine');
    milestoneVault.recordTrade(pnl);

    const currentEquity = this.getCompoundedEquity(marketKey);
    const growthMultiple = (currentEquity / ((marketKey === 'IN') ? 2500 : 50)).toFixed(3);

    const curMarketPnL = sessionStateStore.getState().marketPnL || { IN: 0, CRYPTO: 0, US: 0, FOREX: 0, FUTURES: 0 };
    curMarketPnL[marketKey] = (curMarketPnL[marketKey] || 0) + pnl;

    // Save to disk
    sessionStateStore.saveState({
      realizedPnL: this.realizedPnL,
      compoundedEquity: currentEquity,
      marketPnL: curMarketPnL
    });

    logger.info(`💰 [Compounding Engine] Trade P&L: ₹/$${pnl.toFixed(2)} | Market [${marketKey}] | Total Compounded Equity: ₹/$${currentEquity.toFixed(2)} (${growthMultiple}x Initial)`);
  }

  /**
   * Calculate optimal dynamic position size based on Fractional Kelly & Compounded Equity
   * @param {Object} signal - Trade signal with entry, stopLoss, takeProfit
   * @param {Object} stats - Historical performance metrics (winRate, payoffRatio)
   */
  calculateCompoundedAllocation(signal, stats = { winRate: 0.55, payoffRatio: 1.8 }, customEquity = null) {
    const milestoneVault = require('./milestoneVaultEngine');
    const smartRouter = require('./smartRouter');
    const market = signal.market || smartRouter.resolveMarketForSignal(signal);
    const equity = (customEquity && customEquity > 0) ? customEquity : this.getCompoundedEquity(market);
    const defensiveMult = milestoneVault.getDefensiveMultiplier(); // 0.50x if consecutive losses

    const p = Math.max(0.40, Math.min(0.85, stats.winRate || 0.55));
    const b = Math.max(1.0, stats.payoffRatio || (signal.riskReward || 1.8));

    // Full Kelly Formula: f* = (p*b - q) / b where q = 1 - p
    const q = 1 - p;
    let fullKelly = (p * b - q) / b;
    if (fullKelly <= 0) fullKelly = 0.05; // Fallback minimum 5%

    // Apply Fractional Kelly Multiplier & Anti-Martingale defense
    const optimalFraction = Math.min(0.20, Math.max(0.02, fullKelly * this.fractionalKellyMultiplier * defensiveMult));

    // Calculate maximum capital allocated to this trade
    const allocatedCapital = equity * optimalFraction;

    // Calculate trade risk distance per share/unit
    const entryPrice = signal.entryPrice;
    const stopLoss = signal.stopLoss;
    const riskPerUnit = Math.abs(entryPrice - stopLoss) || (entryPrice * 0.02);

    // Maximum risk in cash (1.5% of total compounded equity * defensive multiplier)
    const maxRiskCash = equity * 0.015 * defensiveMult;
    const qtyByRisk = Math.max(1, Math.floor(maxRiskCash / riskPerUnit));
    const qtyByCapital = Math.max(1, Math.floor(allocatedCapital / entryPrice));

    const isCrypto = signal.symbol && (signal.symbol.includes('USDT') || signal.symbol.includes('BTC') || signal.symbol.includes('ETH') || signal.symbol.includes('SOL') || signal.symbol.includes('XRP') || signal.symbol.includes('DOGE') || signal.symbol.includes('ADA'));
    let finalQuantity = 1;
    if (isCrypto) {
      // Allow micro-lot sizing (e.g. 0.001 BTC, 0.01 ETH, 0.1 SOL, 1-5 ADA/XRP)
      const rawQty = Math.min(qtyByRisk, (allocatedCapital / entryPrice));
      if (entryPrice > 500) {
        finalQuantity = parseFloat(Math.max(0.001, rawQty).toFixed(4));
      } else if (entryPrice > 10) {
        finalQuantity = parseFloat(Math.max(0.01, rawQty).toFixed(2));
      } else {
        // Assets like XRP ($0.99), DOGE ($0.15), ADA ($0.35)
        // Hard cap: Maximum $2-$3 notional allocation per trade on $10 account
        const maxNotional = Math.max(1, allocatedCapital);
        const maxUnits = Math.max(1, Math.floor(maxNotional / entryPrice));
        finalQuantity = Math.max(1, Math.min(maxUnits, qtyByRisk));
      }
    } else {
      // Indian equity shares: whole integer shares
      finalQuantity = Math.max(1, Math.min(qtyByRisk, qtyByCapital || 1));
    }

    return {
      compoundedEquity: equity,
      allocatedCapital,
      optimalFraction,
      riskPerUnit,
      quantity: finalQuantity,
      notionalValue: finalQuantity * entryPrice
    };
  }
}

module.exports = new CompoundingEngine();
