const marketRegistry = require('./marketRegistry');
const consensusEngine = require('./consensusEngine');
const momentumAgent = require('../agents/signal/momentumAgent');
const meanReversionAgent = require('../agents/signal/meanReversionAgent');
const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('BacktestEngine');

/**
 * BacktestEngine - Simulates multi-market quantitative strategies across historical candle bars.
 */
class BacktestEngine {
  constructor(initialCapital = 100000) {
    this.initialCapital = initialCapital;
  }

  async run({ marketKey = 'CRYPTO', symbol = 'BTCUSDT', interval = '5m', range = '30d' }) {
    logger.info(`🔬 Starting Backtest on [${marketKey}:${symbol}] (${interval}, ${range})...`);

    const market = marketRegistry.getMarket(marketKey);
    const candles = await market.dataProvider.fetchCandles(symbol, interval, range);

    if (!candles || candles.length < 50) {
      throw new Error(`Insufficient historical candles for backtesting (${candles?.length || 0} bars found)`);
    }

    let capital = this.initialCapital;
    let peakCapital = capital;
    let maxDrawdown = 0;
    const trades = [];
    let openTrade = null;

    // Rolling window simulation across history
    const lookback = 30;
    for (let i = lookback; i < candles.length; i++) {
      const currentBar = candles[i];
      const historicalSlice = candles.slice(0, i + 1);

      // 1. Check open position stop/target hits
      if (openTrade) {
        let closed = false;
        let exitPrice = currentBar.close;
        let exitReason = '';

        if (openTrade.direction === 'LONG') {
          if (currentBar.low <= openTrade.stopLoss) {
            exitPrice = openTrade.stopLoss;
            exitReason = 'STOP_LOSS';
            closed = true;
          } else if (currentBar.high >= openTrade.takeProfit) {
            exitPrice = openTrade.takeProfit;
            exitReason = 'TAKE_PROFIT';
            closed = true;
          }
        } else {
          if (currentBar.high >= openTrade.stopLoss) {
            exitPrice = openTrade.stopLoss;
            exitReason = 'STOP_LOSS';
            closed = true;
          } else if (currentBar.low <= openTrade.takeProfit) {
            exitPrice = openTrade.takeProfit;
            exitReason = 'TAKE_PROFIT';
            closed = true;
          }
        }

        if (closed) {
          const pnl = openTrade.direction === 'LONG'
            ? (exitPrice - openTrade.entryPrice) * openTrade.quantity
            : (openTrade.entryPrice - exitPrice) * openTrade.quantity;

          capital += pnl;
          peakCapital = Math.max(peakCapital, capital);
          const dd = ((peakCapital - capital) / peakCapital) * 100;
          maxDrawdown = Math.max(maxDrawdown, dd);

          trades.push({
            symbol,
            direction: openTrade.direction,
            strategy: openTrade.strategy,
            entryTime: openTrade.entryTime,
            exitTime: currentBar.timestamp,
            entryPrice: openTrade.entryPrice,
            exitPrice,
            pnl: parseFloat(pnl.toFixed(2)),
            returnPct: parseFloat(((pnl / openTrade.cost) * 100).toFixed(2)),
            reason: exitReason
          });

          openTrade = null;
        }
      }

      // 2. Generate Signals for bar if no open trade
      if (!openTrade && i < candles.length - 1) {
        const marketData = new Map([[symbol, { symbol, candles: historicalSlice }]]);

        const [mom, mr] = await Promise.all([
          momentumAgent.generateSignals(marketData),
          meanReversionAgent.generateSignals(marketData)
        ]);

        const rawSignals = [...(mom || []), ...(mr || [])];

        for (const sig of rawSignals) {
          const consensus = consensusEngine.evaluate(sig, { htfCandles: historicalSlice });
          if (consensus.approved) {
            // Allocate 10% equity per trade
            const tradeSize = capital * 0.10;
            const qty = Math.max(1, Math.floor(tradeSize / currentBar.close));
            
            openTrade = {
              symbol,
              direction: sig.direction,
              strategy: sig.strategy,
              entryTime: currentBar.timestamp,
              entryPrice: currentBar.close,
              stopLoss: sig.stopLoss,
              takeProfit: sig.takeProfit,
              quantity: qty,
              cost: qty * currentBar.close
            };
            break;
          }
        }
      }
    }

    // Performance Metrics Calculation
    const totalTrades = trades.length;
    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl <= 0);
    const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
    
    const grossProfit = winningTrades.reduce((acc, t) => acc + t.pnl, 0);
    const grossLoss = Math.abs(losingTrades.reduce((acc, t) => acc + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.9 : 0);
    const netProfit = capital - this.initialCapital;
    const netReturnPct = (netProfit / this.initialCapital) * 100;

    const report = {
      market: marketKey,
      symbol,
      interval,
      barsAnalyzed: candles.length,
      initialCapital: this.initialCapital,
      endingCapital: parseFloat(capital.toFixed(2)),
      netProfit: parseFloat(netProfit.toFixed(2)),
      netReturnPct: parseFloat(netReturnPct.toFixed(2)),
      totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: parseFloat(winRate.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      maxDrawdownPct: parseFloat(maxDrawdown.toFixed(2)),
      trades
    };

    logger.info(`✅ Backtest Complete for ${symbol}: Win Rate: ${report.winRate}%, Net Profit: $${report.netProfit}, Profit Factor: ${report.profitFactor}`);
    return report;
  }
}

module.exports = BacktestEngine;
