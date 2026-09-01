const fs = require('fs');
const path = require('path');
const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('StrategyHealthSentinel');

class StrategyHealthSentinel {
  constructor() {
    this.storagePath = path.join(__dirname, '../../data/strategy_health_registry.json');
    this.strategies = [
      {
        id: 'ARES_TREND_ALPHA',
        name: 'ARES Trend Breakout Alpha',
        author: 'Ares (Aggressive Lead)',
        type: 'MOMENTUM_BREAKOUT',
        lifecycleStage: 'LIVE_ACTIVE',
        targetRegime: 'TRENDING_BULL',
        compatibleRegimes: ['TRENDING_BULL', 'TRENDING_BEAR', 'HIGH_VOLATILITY_EXPANSION'],
        incompatibleRegimes: ['LOW_VOL_CHOP', 'SIDEWAYS_RANGE'],
        allocationPct: 22.0,
        allocationAction: 'MAINTAIN',
        answers: {
          trades: 'High-momentum trending breakouts, multi-TF EMA cross, high volume shocks',
          whenTrades: 'NY AM Peak (08:30-12:00 NY), London Open, 5m/1h trend agreement',
          whenNotTrades: 'Asia consolidation, NY Lunch chop, RSI > 78 divergence',
          bestRegime: 'Trending Bullish & Strong Volatility Expansions',
          capitalAllocated: '22% of Riskable Capital (.20 /  base)',
          healthScore: 92,
          recommendation: 'INCREASE_ON_PULLBACK'
        },
        metrics: {
          winRate: 71.4,
          profitFactor: 2.14,
          sharpe: 1.88,
          maxDrawdown: -6.8,
          walkForwardScore: 89,
          regimeFit: 94,
          executionQuality: 96,
          tradeCount: 142
        }
      },
      {
        id: 'SMC_ORDER_BLOCK_ALPHA',
        name: 'Smart Money FVG & Order Block Hunter',
        author: 'Thoth (Quantitative Quant)',
        type: 'INSTITUTIONAL_LIQUIDITY',
        lifecycleStage: 'LIVE_ACTIVE',
        targetRegime: 'LIQUIDITY_SWEEP',
        compatibleRegimes: ['TRENDING_BULL', 'TRENDING_BEAR', 'LIQUIDITY_SWEEP', 'SIDEWAYS_RANGE'],
        incompatibleRegimes: ['EVENT_VOLATILITY_SPIKE'],
        allocationPct: 25.0,
        allocationAction: 'MAINTAIN',
        answers: {
          trades: 'Fair Value Gaps (FVG), mitigation pools, institutional order blocks',
          whenTrades: 'Overnight liquidity sweeps, London/NY session open retests',
          whenNotTrades: 'Binary macro news releases (CPI/FOMC spikes), zero volume hours',
          bestRegime: 'Liquidity sweep & structural retests',
          capitalAllocated: '25% of Riskable Capital (.50 /  base)',
          healthScore: 88,
          recommendation: 'MAINTAIN'
        },
        metrics: {
          winRate: 68.2,
          profitFactor: 1.95,
          sharpe: 1.74,
          maxDrawdown: -7.5,
          walkForwardScore: 86,
          regimeFit: 91,
          executionQuality: 94,
          tradeCount: 198
        }
      },
      {
        id: 'BASIS_FUNDING_ARB',
        name: 'Delta-Neutral Basis Funding Arbitrage',
        author: 'Athena (Risk Sentinel)',
        type: 'DELTA_NEUTRAL',
        lifecycleStage: 'LIVE_ACTIVE',
        targetRegime: 'LOW_VOL_CHOP',
        compatibleRegimes: ['LOW_VOL_CHOP', 'SIDEWAYS_RANGE', 'TRENDING_BULL'],
        incompatibleRegimes: ['EXTREME_FLASH_CRASH'],
        allocationPct: 20.0,
        allocationAction: 'INCREASE',
        answers: {
          trades: 'Spot-Futures annual funding yield spreads (CEX-DEX & Perp-Spot)',
          whenTrades: 'Positive funding rate divergence > 12% APR',
          whenNotTrades: 'Funding rates < 3% APR, high withdrawal fee congestion',
          bestRegime: 'Low-volatility consolidation & high market open interest',
          capitalAllocated: '20% of Riskable Capital (.00 /  base)',
          healthScore: 94,
          recommendation: 'INCREASE_CAPITAL'
        },
        metrics: {
          winRate: 92.5,
          profitFactor: 3.40,
          sharpe: 2.65,
          maxDrawdown: -1.8,
          walkForwardScore: 95,
          regimeFit: 96,
          executionQuality: 98,
          tradeCount: 88
        }
      },
      {
        id: 'PAIRS_COINTEGRATION_STATARB',
        name: 'Statistical Cointegration Pairs Slicer',
        author: 'Thoth (Quantitative Quant)',
        type: 'STATISTICAL_ARBITRAGE',
        lifecycleStage: 'LIVE_ACTIVE',
        targetRegime: 'SIDEWAYS_RANGE',
        compatibleRegimes: ['SIDEWAYS_RANGE', 'LOW_VOL_CHOP'],
        incompatibleRegimes: ['MACRO_DECOUPLING_TREND'],
        allocationPct: 15.0,
        allocationAction: 'MAINTAIN',
        answers: {
          trades: 'Cointegrated Z-score spread deviations (e.g. BTC/ETH, SOL/AVAX)',
          whenTrades: 'Z-score spread exceeds ±2.0 standard deviations',
          whenNotTrades: 'Earnings divergence, single-asset structural protocol failure',
          bestRegime: 'Mean-reverting rangebound markets',
          capitalAllocated: '15% of Riskable Capital (.50 /  base)',
          healthScore: 82,
          recommendation: 'MAINTAIN'
        },
        metrics: {
          winRate: 74.1,
          profitFactor: 1.82,
          sharpe: 1.61,
          maxDrawdown: -8.4,
          walkForwardScore: 81,
          regimeFit: 84,
          executionQuality: 92,
          tradeCount: 65
        }
      },
      {
        id: 'MEAN_REVERSION_SCALPER',
        name: 'RSI-2 Bollinger Band Mean Reversion',
        author: 'Anubis (Execution Sentinel)',
        type: 'MEAN_REVERSION',
        lifecycleStage: 'PAUSED_REGIME_MISFIT',
        targetRegime: 'SIDEWAYS_RANGE',
        compatibleRegimes: ['SIDEWAYS_RANGE', 'LOW_VOL_CHOP'],
        incompatibleRegimes: ['TRENDING_BULL', 'TRENDING_BEAR', 'HIGH_VOLATILITY_EXPANSION'],
        allocationPct: 8.0,
        allocationAction: 'REDUCE_OR_PAUSE',
        answers: {
          trades: 'Extreme 2-period RSI oversold/overbought rebounds at 3σ outer bands',
          whenTrades: 'Low-ADX range conditions (< 20 ADX)',
          whenNotTrades: 'Runaway momentum expansions, breakout trend bars',
          bestRegime: 'Strict sideways ranging channels',
          capitalAllocated: '8% (Currently Paused due to Active Bull Momentum Regime)',
          healthScore: 61,
          recommendation: 'PAUSE_IN_TREND'
        },
        metrics: {
          winRate: 59.2,
          profitFactor: 1.25,
          sharpe: 1.12,
          maxDrawdown: -14.2,
          walkForwardScore: 64,
          regimeFit: 42,
          executionQuality: 88,
          tradeCount: 110
        }
      },
      {
        id: 'GENETIC_CANDIDATE_GEN4_ALPHA',
        name: 'Genetic Foundry Champion (Gen-4 / EMA 8-24)',
        author: 'Genetic Foundry Evolver',
        type: 'EVOLVED_GENETIC',
        lifecycleStage: 'WALK_FORWARD_VALIDATION',
        targetRegime: 'TRENDING_BULL',
        compatibleRegimes: ['TRENDING_BULL', 'HIGH_VOLATILITY_EXPANSION'],
        incompatibleRegimes: ['LOW_VOL_CHOP'],
        allocationPct: 0.0,
        allocationAction: 'PAPER_VALIDATION',
        answers: {
          trades: 'Multi-mutation EMA 8/24 crossover with dynamic Kelly fraction sizing',
          whenTrades: 'Validated across 30-day walk-forward out-of-sample candles',
          whenNotTrades: 'Drawdown > 5% in testing phase',
          bestRegime: 'High-volatility trend acceleration',
          capitalAllocated: '0% (Paper Testing Phase)',
          healthScore: 84,
          recommendation: 'PROCEED_TO_PAPER'
        },
        metrics: {
          winRate: 66.7,
          profitFactor: 2.05,
          sharpe: 1.92,
          maxDrawdown: -7.1,
          walkForwardScore: 88,
          regimeFit: 89,
          executionQuality: 91,
          tradeCount: 48
        }
      }
    ];

    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
        if (Array.isArray(raw.strategies) && raw.strategies.length > 0) {
          this.strategies = raw.strategies;
        }
      }
    } catch (e) {
      logger.warn(`Could not load strategy health registry: ${e.message}`);
    }
  }

  saveState() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify({
        updatedAt: new Date().toISOString(),
        strategyCount: this.strategies.length,
        strategies: this.strategies
      }, null, 2));
    } catch (e) {
      logger.error(`Failed to save strategy health registry: ${e.message}`);
    }
  }

  calculateCompositeHealth(strategy, currentMarketRegime = 'TRENDING_BULL') {
    const m = strategy.metrics || {};
    
    // 1. Performance (25% weight)
    const winRateScore = Math.min(100, Math.max(0, (m.winRate || 50) * 1.25));
    const profitFactorScore = Math.min(100, Math.max(0, ((m.profitFactor || 1.0) / 2.5) * 100));
    const perfScore = (winRateScore * 0.5) + (profitFactorScore * 0.5);

    // 2. Robustness (20% weight) - Walk-Forward Score
    const robustScore = m.walkForwardScore || 75;

    // 3. Drawdown Safety (15% weight)
    const dd = Math.abs(m.maxDrawdown || 10);
    const ddScore = Math.min(100, Math.max(0, 100 - (dd * 4.5)));

    // 4. Regime Fit (20% weight) - Fail Closed on REGIME_UNKNOWN
    let regimeScore = 50;
    if (currentMarketRegime === 'REGIME_UNKNOWN') {
      regimeScore = 0; // Immediate hard zero for unclassified / failed markets
    } else if (strategy.targetRegime === currentMarketRegime) {
      regimeScore = 95;
    } else if (strategy.compatibleRegimes.includes(currentMarketRegime)) {
      regimeScore = 78;
    } else if (strategy.incompatibleRegimes.includes(currentMarketRegime)) {
      regimeScore = 25;
    }

    // 5. Execution Quality (10% weight)
    const execScore = m.executionQuality || 90;

    // 6. Statistical Confidence (10% weight)
    const count = m.tradeCount || 10;
    const confidenceScore = Math.min(100, Math.max(20, (count / 100) * 100));

    // Baseline Historical Health (assuming optimal regime fit)
    const baselineHistoricalHealth = Math.round(
      (perfScore * 0.25) +
      (robustScore * 0.20) +
      (ddScore * 0.15) +
      (95 * 0.20) + // Optimal regime baseline
      (execScore * 0.10) +
      (confidenceScore * 0.10)
    );

    // Current-Regime Adjusted Dynamic Health (0-100)
    const currentRegimeHealth = (currentMarketRegime === 'REGIME_UNKNOWN') ? 0 : Math.round(
      (perfScore * 0.25) +
      (robustScore * 0.20) +
      (ddScore * 0.15) +
      (regimeScore * 0.20) +
      (execScore * 0.10) +
      (confidenceScore * 0.10)
    );

    let allocationAction = 'MAINTAIN';
    let lifecycleStage = strategy.lifecycleStage;

    if (currentMarketRegime === 'REGIME_UNKNOWN') {
      allocationAction = 'PAUSE_OR_PAPER';
      lifecycleStage = 'PAUSED_REGIME_MISFIT';
    } else if (currentRegimeHealth >= 90) {
      allocationAction = 'INCREASE';
      if (lifecycleStage === 'PAUSED_REGIME_MISFIT') lifecycleStage = 'LIVE_ACTIVE';
    } else if (currentRegimeHealth >= 75) {
      allocationAction = 'MAINTAIN';
      if (lifecycleStage === 'PAUSED_REGIME_MISFIT') lifecycleStage = 'LIVE_ACTIVE';
    } else if (currentRegimeHealth >= 60) {
      allocationAction = 'REDUCE_50_PCT';
    } else if (currentRegimeHealth >= 40) {
      allocationAction = 'PAUSE_OR_PAPER';
      lifecycleStage = 'PAUSED_REGIME_MISFIT';
    } else {
      allocationAction = 'RETIRE_CANDIDATE';
      lifecycleStage = 'RETIRED';
    }

    return {
      healthScore: currentRegimeHealth,
      baselineHistoricalHealth,
      currentRegimeHealth,
      allocationAction,
      lifecycleStage,
      breakdown: {
        performance: Math.round(perfScore),
        robustness: Math.round(robustScore),
        drawdownSafety: Math.round(ddScore),
        regimeFit: Math.round(regimeScore),
        execution: Math.round(execScore),
        confidence: Math.round(confidenceScore)
      }
    };
  }

  evaluateAllStrategies(currentMarketRegime = null) {
    // Dynamic regime resolution from live regime classifier (Fail-Closed to REGIME_UNKNOWN)
    let activeRegime = currentMarketRegime;
    if (!activeRegime || activeRegime === 'AUTO') {
      try {
        const regimeClassifier = require('./regimeClassifier');
        const live = regimeClassifier.classify('BTCUSDT');
        activeRegime = live?.regime || 'REGIME_UNKNOWN';
      } catch (e) {
        logger.error(`Regime classifier failure, failing closed to REGIME_UNKNOWN: ${e.message}`);
        activeRegime = 'REGIME_UNKNOWN';
      }
    }

    this.strategies = this.strategies.map(strat => {
      const evaluation = this.calculateCompositeHealth(strat, activeRegime);
      return {
        ...strat,
        healthScore: evaluation.healthScore,
        baselineHistoricalHealth: evaluation.baselineHistoricalHealth,
        currentRegimeHealth: evaluation.currentRegimeHealth,
        allocationAction: evaluation.allocationAction,
        lifecycleStage: evaluation.lifecycleStage,
        healthBreakdown: evaluation.breakdown,
        lastEvaluatedAt: new Date().toISOString()
      };
    });

    this.saveState();
    return this.getStrategySummary(activeRegime);
  }

  filterApprovedStrategiesForRegime(regime = 'TRENDING_BULL') {
    return this.strategies.filter(s => {
      const isLive = s.lifecycleStage === 'LIVE_ACTIVE';
      const isFit = !s.incompatibleRegimes.includes(regime);
      const isHealthy = (s.healthScore || 80) >= 60;
      return isLive && isFit && isHealthy;
    });
  }

  getStrategySummary(currentRegime = 'TRENDING_BULL') {
    const active = this.strategies.filter(s => s.lifecycleStage === 'LIVE_ACTIVE').length;
    const paused = this.strategies.filter(s => s.lifecycleStage.includes('PAUSED')).length;
    const candidates = this.strategies.filter(s => s.lifecycleStage === 'WALK_FORWARD_VALIDATION' || s.lifecycleStage === 'GENERATED').length;
    const retired = this.strategies.filter(s => s.lifecycleStage === 'RETIRED').length;

    // Calculate dynamic capital allocation totals
    const totalAllocatedPct = this.strategies.reduce((acc, s) => {
      // Only count live active strategies towards active riskable capital allocation
      return s.lifecycleStage === 'LIVE_ACTIVE' ? acc + (s.allocationPct || 0) : acc;
    }, 0);
    const reserveCapitalPct = Math.max(0, 100 - totalAllocatedPct);

    // Calculate Average Health across active strategies
    const activeStrategies = this.strategies.filter(s => s.lifecycleStage === 'LIVE_ACTIVE');
    const avgHealth = activeStrategies.length > 0
      ? Math.round(activeStrategies.reduce((acc, s) => acc + (s.healthScore || 80), 0) / activeStrategies.length)
      : 80;

    // Explicit Formula Weight Documentation
    const formulaWeights = {
      performance: { weight: '25%', metric: 'Win Rate (50%) + Profit Factor (50%)' },
      robustness: { weight: '20%', metric: '30-Day Walk-Forward Stability Score' },
      drawdownSafety: { weight: '15%', metric: 'Max Drawdown Recovery & Tail Margin' },
      regimeFit: { weight: '20%', metric: 'DNA Match vs Active Market Volatility' },
      execution: { weight: '10%', metric: 'Slippage & Fee Drag Efficiency' },
      confidence: { weight: '10%', metric: 'Sample Size (N >= 100 Trades)' }
    };

    // Global Regime Compatibility Matrix
    const regimeMatrix = this.strategies.map(s => ({
      id: s.id,
      name: s.name,
      bull: s.compatibleRegimes.includes('TRENDING_BULL') ? '🟢 FIT' : s.incompatibleRegimes.includes('TRENDING_BULL') ? '🔴 BLOCKED' : '⚪ NEUTRAL',
      bear: s.compatibleRegimes.includes('TRENDING_BEAR') ? '🟢 FIT' : s.incompatibleRegimes.includes('TRENDING_BEAR') ? '🔴 BLOCKED' : '⚪ NEUTRAL',
      range: s.compatibleRegimes.includes('SIDEWAYS_RANGE') || s.compatibleRegimes.includes('LOW_VOL_CHOP') ? '🟢 FIT' : s.incompatibleRegimes.includes('SIDEWAYS_RANGE') ? '🔴 BLOCKED' : '⚪ NEUTRAL',
      highVol: s.compatibleRegimes.includes('HIGH_VOLATILITY_EXPANSION') ? '🟢 FIT' : s.incompatibleRegimes.includes('HIGH_VOLATILITY_EXPANSION') ? '🔴 BLOCKED' : '⚪ NEUTRAL',
      currentRegimeFitScore: s.healthBreakdown?.regimeFit || 80
    }));

    return {
      activeCount: active,
      pausedCount: paused,
      candidateCount: candidates,
      retiredCount: retired,
      totalCount: this.strategies.length,
      averageHealth: avgHealth,
      totalAllocatedPct,
      reserveCapitalPct,
      currentRegime,
      formulaWeights,
      regimeMatrix,
      strategies: this.strategies
    };
  }
}

module.exports = new StrategyHealthSentinel();
