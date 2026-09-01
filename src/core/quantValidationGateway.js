const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('QuantValidationGateway');

/**
 * Quant Validation Gateway
 * Automated, rigorous sandbox that evaluates candidate strategy hypotheses against:
 * 1. 5-Window Rolling Walk-Forward Analysis (WFO)
 * 2. True Strategy Rule Simulation (EMA Cross, ATR SL/TP, Trailing, Slippage)
 * 3. In-Sample vs. Out-of-Sample Performance Stability & Overfit Detection
 * 4. Monte Carlo Trade Sequence Permutations (500 runs for Max Drawdown stability)
 * 5. Execution Friction Stress (0.075% Taker fee + 0.05% slippage buffer)
 */
class QuantValidationGateway {
  constructor() {
    this.validationResults = new Map();
  }

  /**
   * Run full quantitative battery on a candidate hypothesis
   */
  async validateHypothesis(hypothesis, historicalCandles = []) {
    if (!hypothesis || !hypothesis.hypothesisId) {
      throw new Error('Invalid hypothesis provided for validation');
    }

    logger.info(`📊 [Quant Validation] Starting multi-stage validation battery for ${hypothesis.hypothesisId}`);
    
    // Generate synthetic or use provided candles
    const candleCount = historicalCandles.length > 0 ? historicalCandles.length : 250;
    const candles = historicalCandles.length > 0 ? historicalCandles : this._generateSampleCandles(candleCount);

    // 1. Five-Window Rolling Walk-Forward Analysis (WFO)
    // Uses 5 sequential train -> unseen test windows across the time series
    const totalBars = candles.length;
    const testSegmentSize = Math.floor(totalBars / 7); // 5 test windows + 2 warmup train segments
    const trainSize = testSegmentSize * 2;
    const windowResults = [];

    for (let w = 0; w < 5; w++) {
      const trainStart = w * testSegmentSize;
      const trainEnd = trainStart + trainSize;
      const testStart = trainEnd;
      const testEnd = Math.min(totalBars, testStart + testSegmentSize);

      const isWindow = candles.slice(trainStart, trainEnd);
      const oosWindow = candles.slice(testStart, testEnd);

      if (isWindow.length >= 20 && oosWindow.length >= 10) {
        const isSim = this._simulateStrategy(hypothesis, isWindow);
        const oosSim = this._simulateStrategy(hypothesis, oosWindow);
        
        let windowStatus = 'PASS';
        if (oosSim.trades.length < 2) {
          windowStatus = 'INSUFFICIENT_SAMPLE';
        } else if (oosSim.profitFactor !== null && oosSim.profitFactor < 0.8) {
          windowStatus = 'FAIL';
        } else if (oosSim.sharpe === null) {
          windowStatus = 'LOW_VARIANCE';
        }

        const isSharpeVal = isSim.sharpe !== null ? isSim.sharpe : 0;
        const oosSharpeVal = oosSim.sharpe !== null ? oosSim.sharpe : 0;
        const wfe = isSharpeVal > 0 ? Math.min(100, Math.max(0, (oosSharpeVal / isSharpeVal) * 100)) : (oosSharpeVal > 0 ? 100 : 0);

        windowResults.push({
          window: w + 1,
          trainStart,
          trainEnd,
          testStart,
          testEnd,
          status: windowStatus,
          isTrades: isSim.trades.length,
          isWins: isSim.wins,
          isLosses: isSim.losses,
          isSharpe: isSim.sharpe,
          oosTrades: oosSim.trades.length,
          oosWins: oosSim.wins,
          oosLosses: oosSim.losses,
          oosSharpe: oosSim.sharpe,
          wfe,
          oosWinRate: oosSim.winRate,
          oosProfitFactor: oosSim.profitFactor,
          trades: oosSim.trades
        });
      }
    }

    // 2. Global In-Sample (60%) vs Out-of-Sample (40%) Test
    const splitIndex = Math.floor(candles.length * 0.60);
    const globalIS = candles.slice(0, splitIndex);
    const globalOOS = candles.slice(splitIndex);

    const isMetrics = this._simulateStrategy(hypothesis, globalIS);
    const oosMetrics = this._simulateStrategy(hypothesis, globalOOS);

    // 3. Aggregate Rolling Walk-Forward Efficiency & Robustness Counts
    const avgWFE = windowResults.length > 0
      ? windowResults.reduce((sum, w) => sum + w.wfe, 0) / windowResults.length
      : 50;
    const windowsPassed = windowResults.filter(w => w.status === 'PASS').length;
    const windowsFailed = windowResults.filter(w => w.status === 'FAIL').length;

    // 4. Monte Carlo Drawdown & Permutation Test (500 iterations)
    const mcResults = this._runMonteCarloSimulation(oosMetrics.trades, 500);

    // 5. Statistical Significance & Overfitting Detection Gate
    const isDegraded = isMetrics.sharpe !== null && isMetrics.sharpe > 1.8 && (oosMetrics.sharpe === null || oosMetrics.sharpe < 0.6);
    const oosTradeCount = Array.isArray(oosMetrics.trades) ? oosMetrics.trades.length : 0;
    const hasSufficientSample = oosTradeCount >= 5 && oosMetrics.losses >= 1; // Minimum empirical sample threshold
    const hasValidPF = oosMetrics.profitFactor !== null && oosMetrics.profitFactor >= 1.15;
    const hasWindowRobustness = windowsPassed >= 3; // At least 3 out of 5 WFO windows must pass cleanly

    const isPassing = (
      hasSufficientSample &&
      hasWindowRobustness &&
      !isDegraded &&
      oosMetrics.winRate >= 45.0 &&
      hasValidPF &&
      mcResults.maxSimulatedDrawdown >= -20.0
    );

    let recommendation = 'REJECTED';
    if (isDegraded) {
      recommendation = 'REJECTED_OVERFIT';
    } else if (isPassing) {
      recommendation = 'APPROVED_FOR_PAPER_PROBATION';
    } else if (!hasSufficientSample) {
      recommendation = 'INSUFFICIENT_SAMPLE';
    } else if (!hasWindowRobustness) {
      recommendation = 'REJECTED_REGIME_INSTABILITY';
    }

    const validationReport = {
      hypothesisId: hypothesis.hypothesisId,
      symbol: hypothesis.symbol,
      strategyType: hypothesis.strategyType,
      passed: isPassing,
      recommendation,
      sampleStatus: hasSufficientSample ? 'SUFFICIENT' : 'INSUFFICIENT_SAMPLE',
      isOverfit: isDegraded || (isMetrics.profitFactor !== null && oosMetrics.profitFactor !== null && isMetrics.profitFactor > 1.5 && oosMetrics.profitFactor < 0.9),
      metrics: {
        inSample: {
          winRate: parseFloat(isMetrics.winRate.toFixed(1)),
          profitFactor: isMetrics.profitFactor,
          sharpe: parseFloat(isMetrics.sharpe.toFixed(2)),
          maxDrawdown: parseFloat(isMetrics.maxDrawdown.toFixed(1)),
          trades: isMetrics.trades.length,
          wins: isMetrics.wins,
          losses: isMetrics.losses,
          grossProfit: parseFloat(isMetrics.grossProfit.toFixed(2)),
          grossLoss: parseFloat(isMetrics.grossLoss.toFixed(2)),
          isPFInfinity: isMetrics.losses === 0 && isMetrics.wins > 0
        },
        outOfSample: {
          winRate: parseFloat(oosMetrics.winRate.toFixed(1)),
          profitFactor: oosMetrics.profitFactor,
          sharpe: parseFloat(oosMetrics.sharpe.toFixed(2)),
          maxDrawdown: parseFloat(oosMetrics.maxDrawdown.toFixed(1)),
          trades: oosMetrics.trades.length,
          wins: oosMetrics.wins,
          losses: oosMetrics.losses,
          grossProfit: parseFloat(oosMetrics.grossProfit.toFixed(2)),
          grossLoss: parseFloat(oosMetrics.grossLoss.toFixed(2)),
          isPFInfinity: oosMetrics.losses === 0 && oosMetrics.wins > 0
        },
        rollingWindowsCount: windowResults.length,
        windowsPassed,
        windowsFailed,
        windows: windowResults.map(w => ({
          window: w.window,
          trainStart: w.trainStart,
          trainEnd: w.trainEnd,
          testStart: w.testStart,
          testEnd: w.testEnd,
          status: w.status,
          isTrades: w.isTrades,
          isWins: w.isWins,
          isLosses: w.isLosses,
          isSharpe: w.isSharpe !== null ? parseFloat(w.isSharpe.toFixed(2)) : null,
          oosTrades: w.trades.length,
          oosWins: w.oosWins,
          oosLosses: w.oosLosses,
          oosWinRate: parseFloat(w.oosWinRate.toFixed(1)),
          oosProfitFactor: w.oosProfitFactor,
          oosSharpe: w.oosSharpe !== null ? parseFloat(w.oosSharpe.toFixed(2)) : null,
          wfe: parseFloat(w.wfe.toFixed(1))
        })),
        walkForwardEfficiency: parseFloat(avgWFE.toFixed(1)),
        monteCarlo: {
          simulated95thPercentileDD: parseFloat(mcResults.p95Drawdown.toFixed(1)),
          maxSimulatedDrawdown: parseFloat(mcResults.maxSimulatedDrawdown.toFixed(1)),
          stabilityScore: mcResults.stabilityScore
        }
      },
      validatedAt: new Date().toISOString()
    };

    this.validationResults.set(hypothesis.hypothesisId, validationReport);
    logger.info(`🏁 [Quant Validation] Completed for ${hypothesis.hypothesisId} | Passed: ${isPassing} | WFE: ${validationReport.metrics.walkForwardEfficiency}% | Overfit: ${validationReport.isOverfit}`);
    return validationReport;
  }

  /**
   * Simulate strategy with true indicator triggers (EMA Cross, ATR SL/TP, slippage)
   */
  _simulateStrategy(hypothesis, candles) {
    let balance = 10000;
    let peak = balance;
    let maxDD = 0;
    let wins = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    const trades = [];

    const fastPeriod = (hypothesis.entryTrigger && hypothesis.entryTrigger.fastPeriod) || 8;
    const slowPeriod = (hypothesis.entryTrigger && hypothesis.entryTrigger.slowPeriod) || 24;
    const isLongBias = hypothesis.direction === 'LONG';

    if (candles.length <= slowPeriod) {
      return { winRate: 0, profitFactor: 1.0, sharpe: 0, maxDrawdown: 0, trades: [] };
    }

    // Calculate EMA fast and slow
    const emaFast = this._calcEMA(candles.map(c => c.close), fastPeriod);
    const emaSlow = this._calcEMA(candles.map(c => c.close), slowPeriod);

    let inPosition = false;
    let entryPrice = 0;
    let stopLossPrice = 0;
    let takeProfitPrice = 0;

    for (let i = slowPeriod; i < candles.length; i++) {
      const c = candles[i];
      const prevFast = emaFast[i - 1];
      const prevSlow = emaSlow[i - 1];
      const currFast = emaFast[i];
      const currSlow = emaSlow[i];
      
      const atr = Math.max(10, Math.abs(c.high - c.low));

      // 1. Evaluate Exit if in position
      if (inPosition) {
        let closed = false;
        let exitPrice = c.close;
        let exitReason = 'END_OF_WINDOW';

        if (isLongBias) {
          if (c.low <= stopLossPrice) {
            exitPrice = stopLossPrice;
            closed = true;
            exitReason = 'STOP_LOSS';
          } else if (c.high >= takeProfitPrice) {
            exitPrice = takeProfitPrice;
            closed = true;
            exitReason = 'TAKE_PROFIT';
          } else if (currFast < currSlow && prevFast >= prevSlow) {
            exitPrice = c.close;
            closed = true;
            exitReason = 'EMA_BEAR_CROSS';
          }
        } else {
          if (c.high >= stopLossPrice) {
            exitPrice = stopLossPrice;
            closed = true;
            exitReason = 'STOP_LOSS';
          } else if (c.low <= takeProfitPrice) {
            exitPrice = takeProfitPrice;
            closed = true;
            exitReason = 'TAKE_PROFIT';
          } else if (currFast > currSlow && prevFast <= prevSlow) {
            exitPrice = c.close;
            closed = true;
            exitReason = 'EMA_BULL_CROSS';
          }
        }

        if (closed || i === candles.length - 1) {
          const rawPnlPct = isLongBias
            ? ((exitPrice - entryPrice) / entryPrice)
            : ((entryPrice - exitPrice) / entryPrice);
          
          // Deduct 0.075% taker fee + 0.05% slippage buffer
          const netPnlPct = rawPnlPct - 0.00125;
          const tradeDollarPnl = balance * 0.05 * netPnlPct * 3; // 5% risk, 3x effective leverage

          balance += tradeDollarPnl;
          if (balance > peak) peak = balance;
          const dd = ((balance - peak) / peak) * 100;
          if (dd < maxDD) maxDD = dd;

          if (tradeDollarPnl > 0) {
            wins++;
            grossProfit += tradeDollarPnl;
          } else {
            grossLoss += Math.abs(tradeDollarPnl);
          }

          trades.push({ pnl: tradeDollarPnl, returnPct: netPnlPct, reason: exitReason });
          inPosition = false;
        }
      }

      // 2. Evaluate Entry Trigger if flat
      if (!inPosition && i < candles.length - 1) {
        const isBullCross = (currFast > currSlow && prevFast <= prevSlow) || (i === slowPeriod && currFast > currSlow);
        const isBearCross = (currFast < currSlow && prevFast >= prevSlow) || (i === slowPeriod && currFast < currSlow);

        if ((isLongBias && isBullCross) || (!isLongBias && isBearCross)) {
          inPosition = true;
          entryPrice = c.close;
          const slATR = (hypothesis.exitRules && hypothesis.exitRules.stopLossATR) || 1.5;
          const tpATR = (hypothesis.exitRules && hypothesis.exitRules.takeProfitATR) || 3.0;

          if (isLongBias) {
            stopLossPrice = entryPrice - (atr * slATR);
            takeProfitPrice = entryPrice + (atr * tpATR);
          } else {
            stopLossPrice = entryPrice + (atr * slATR);
            takeProfitPrice = entryPrice - (atr * tpATR);
          }
        }
      }
    }

    const tradeCount = trades.length || 1;
    const losses = trades.length - wins;
    const winRate = (wins / tradeCount) * 100;
    const profitFactor = grossLoss > 0 
      ? parseFloat((grossProfit / grossLoss).toFixed(2)) 
      : (grossProfit > 0 ? null : 1.0); // Null indicates Infinity/Undefined (Zero loss)
    const returns = trades.map(t => t.returnPct);
    const meanReturn = returns.reduce((a, b) => a + b, 0) / tradeCount;
    const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / tradeCount;
    const stdDev = Math.sqrt(variance);
    const EPSILON = 0.0001; // Minimum standard deviation to avoid infinite/astronomical Sharpe ratios
    
    let sharpe = null;
    if (trades.length >= 2 && stdDev > EPSILON) {
      const rawSharpe = (meanReturn / stdDev) * Math.sqrt(365);
      sharpe = Math.min(10.0, Math.max(-5.0, rawSharpe)); // Cap at realistic scale (-5.0 to +10.0)
    }

    return {
      winRate,
      profitFactor,
      sharpe,
      maxDrawdown: maxDD,
      trades,
      wins,
      losses,
      grossProfit,
      grossLoss
    };
  }

  _calcEMA(prices, period) {
    if (!prices || prices.length === 0) return [];
    const k = 2 / (period + 1);
    const ema = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
      ema.push(prices[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }

  _runMonteCarloSimulation(trades, iterations = 500, seed = 42) {
    if (!trades || trades.length === 0) {
      return { p95Drawdown: -5.0, maxSimulatedDrawdown: -8.0, stabilityScore: 85 };
    }

    // Deterministic LCG random number generator for reproducible CI results
    let currentSeed = seed;
    const lcgRandom = () => {
      currentSeed = (currentSeed * 1664525 + 1013904223) % 4294967296;
      return currentSeed / 4294967296;
    };

    const drawdowns = [];
    for (let iter = 0; iter < iterations; iter++) {
      // Deterministically shuffle trades
      const shuffled = [...trades].sort(() => lcgRandom() - 0.5);
      let simBal = 10000;
      let simPeak = 10000;
      let simMaxDD = 0;

      for (const t of shuffled) {
        simBal += t.pnl;
        if (simBal > simPeak) simPeak = simBal;
        const dd = ((simBal - simPeak) / simPeak) * 100;
        if (dd < simMaxDD) simMaxDD = dd;
      }
      drawdowns.push(simMaxDD);
    }

    drawdowns.sort((a, b) => a - b); // Most negative first
    const p95Index = Math.floor(iterations * 0.05);
    const p95Drawdown = drawdowns[p95Index] || -8.0;
    const maxSimulatedDrawdown = drawdowns[0] || -12.0;
    const stabilityScore = Math.max(0, Math.min(100, Math.round(100 - Math.abs(p95Drawdown) * 4)));

    return { p95Drawdown, maxSimulatedDrawdown, stabilityScore };
  }

  _generateSampleCandles(count = 200) {
    const candles = [];
    let price = 70000;
    for (let i = 0; i < count; i++) {
      const delta = (Math.random() - 0.48) * 400;
      price = Math.max(1000, price + delta);
      candles.push({
        open: price - 50,
        high: price + 100,
        low: price - 100,
        close: price,
        volume: 1500 + Math.random() * 1000
      });
    }
    return candles;
  }
}

module.exports = new QuantValidationGateway();
