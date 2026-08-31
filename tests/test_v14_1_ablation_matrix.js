const assert = require('assert');
const hypothesisModule = require('../src/agents/hypothesis/chartContextHypothesisModule');
const momentumAgent = require('../src/agents/signal/momentumAgent');

console.log('================================================================');
console.log('  🔬 CANDIDATE v14.1 SEQUENTIAL FACTOR ABLATION MATRIX STUDY   ');
console.log('================================================================\n');

// 1. Multi-Asset Synthetic Market Feed (500 Bars)
const generateCorpus = () => {
  const corpus = [];
  let price = 50000;
  
  for (let i = 0; i < 500; i++) {
    // Generate realistic regime shifts: Trending -> Ranging -> Mean-Reversion -> Volatile Breakout
    const regimePhase = Math.floor(i / 125);
    let delta = 0;

    if (regimePhase === 0) delta = (Math.sin(i / 8) * 0.005 + 0.003) * price; // Bull trend
    else if (regimePhase === 1) delta = (Math.sin(i / 4) * 0.008) * price;   // Range
    else if (regimePhase === 2) delta = (Math.cos(i / 6) * 0.004 - 0.003) * price; // Bear trend
    else delta = (Math.sin(i / 3) * 0.018 + (i % 5 === 0 ? 0.02 : -0.015)) * price; // Volatile expansion

    price += delta;
    const high = price + Math.abs(delta) * 0.8 + 20;
    const low = price - Math.abs(delta) * 0.8 - 20;
    const open = price - delta * 0.6;
    const close = price;
    const volume = Math.round(2000 + Math.abs(Math.sin(i / 10)) * 6000);

    corpus.push({
      time: 1724666400 + (i * 300),
      timestamp: new Date((1724666400 + (i * 300)) * 1000).toISOString(),
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume
    });
  }
  return corpus;
};

const candles = generateCorpus();

// 2. Simulation Harness for the 6 Ablation Models
const runModelSimulation = (modelName, enabledFactors) => {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let totalPnL = 0;
  const pnlSeries = [];

  // Slide through candles with minimum 30-bar lookback
  for (let i = 30; i < candles.length - 5; i++) {
    const windowCandles = candles.slice(0, i + 1);
    const cur = candles[i];
    const next5 = candles[i + 5]; // 5-bar forward return

    // Base momentum signal trigger
    const momSignal = cur.close > candles[i - 5].close * 1.008 ? 'LONG' : (cur.close < candles[i - 5].close * 0.992 ? 'SHORT' : null);
    if (!momSignal) continue;

    let executeTrade = true;
    let positionSizeMultiplier = 1.0;

    if (enabledFactors) {
      const evalRes = hypothesisModule.evaluateEvidence(
        { symbol: 'BTCUSDT', direction: momSignal, price: cur.close },
        windowCandles,
        'CRYPTO',
        enabledFactors
      );

      // Hypothesis Filter: Only execute if hypothesis approval >= 0.55
      executeTrade = evalRes.hypothesisApproval;
      positionSizeMultiplier = Math.max(0.5, 1.0 + evalRes.confidenceModifier);
    }

    if (executeTrade) {
      trades++;
      const returnPct = momSignal === 'LONG' ? ((next5.close - cur.close) / cur.close) : ((cur.close - next5.close) / cur.close);
      const fee = 0.0015; // 0.15% roundtrip fee
      const netReturnPct = returnPct - fee;
      const tradePnL = (50.0 * 0.25 * positionSizeMultiplier) * netReturnPct; // On $50 capital with 25% allocation

      totalPnL += tradePnL;
      pnlSeries.push(tradePnL);
      if (tradePnL > 0) wins++;
      else losses++;
    }
  }

  const winRate = trades > 0 ? (wins / trades) * 100 : 0;
  const grossWins = pnlSeries.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(pnlSeries.filter(p => p < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLosses > 0 ? (grossWins / grossLosses) : (grossWins > 0 ? 9.99 : 1.0);

  // Compute Sharpe Ratio of trade returns
  const meanPnL = pnlSeries.length > 0 ? totalPnL / pnlSeries.length : 0;
  const variance = pnlSeries.length > 0 ? pnlSeries.reduce((s, p) => s + Math.pow(p - meanPnL, 2), 0) / pnlSeries.length : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanPnL / stdDev) * Math.sqrt(252) : 0;

  return {
    model: modelName,
    trades,
    wins,
    losses,
    winRate: parseFloat(winRate.toFixed(2)),
    totalPnL: parseFloat(totalPnL.toFixed(4)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    sharpe: parseFloat(sharpe.toFixed(2))
  };
};

// 3. Execute the 6 Ablation Configurations
const results = [
  runModelSimulation('Model 0: Baseline v14.0 Pure (No Charts)', null),
  runModelSimulation('Model 1: v14.0 + Session VWAP Filter', { vwap: true, volumeProfile: false, marketStructure: false, rvol: false }),
  runModelSimulation('Model 2: v14.0 + Volume Profile Filter', { vwap: false, volumeProfile: true, marketStructure: false, rvol: false }),
  runModelSimulation('Model 3: v14.0 + Market Structure Filter', { vwap: false, volumeProfile: false, marketStructure: true, rvol: false }),
  runModelSimulation('Model 4: v14.0 + RVOL Volume Filter', { vwap: false, volumeProfile: false, marketStructure: false, rvol: true }),
  runModelSimulation('Model 5: v14.1 Composite Confluence Matrix', { vwap: true, volumeProfile: true, marketStructure: true, rvol: true })
];

console.log('┌─────────────────────────────────────────────────────────────┬────────┬──────────┬────────────┬──────────────┬────────┐');
console.log('│ Model Configuration                                         │ Trades │ Win Rate │ Total PnL  │ ProfitFactor │ Sharpe │');
console.log('├─────────────────────────────────────────────────────────────┼────────┼──────────┼────────────┼──────────────┼────────┤');
results.forEach(r => {
  const padName = r.model.padEnd(59, ' ');
  const padTrades = String(r.trades).padStart(6, ' ');
  const padWinRate = `${r.winRate}%`.padStart(8, ' ');
  const padPnL = `$${r.totalPnL}`.padStart(10, ' ');
  const padPF = String(r.profitFactor).padStart(12, ' ');
  const padSharpe = String(r.sharpe).padStart(6, ' ');
  console.log(`│ ${padName} │ ${padTrades} │ ${padWinRate} │ ${padPnL} │ ${padPF} │ ${padSharpe} │`);
});
console.log('└─────────────────────────────────────────────────────────────┴────────┴──────────┴────────────┴──────────────┴────────┘');

// 4. Assertions & Invariant Verification
const baseline = results[0];
const composite = results[5];

assert(composite.trades > 0, 'Composite executed valid trades');
assert(composite.winRate >= baseline.winRate, 'Composite improved or matched baseline win rate by filtering bad trades');
assert(composite.profitFactor >= baseline.profitFactor, 'Composite improved or matched profit factor');

console.log('\n--- QUANTITATIVE ABLATION SUMMARY ---');
console.log(`✅ Base Trades: ${baseline.trades} -> Filtered High-Conviction Trades: ${composite.trades}`);
console.log(`✅ Win Rate Delta: +${(composite.winRate - baseline.winRate).toFixed(2)}%`);
console.log(`✅ Profit Factor Delta: +${(composite.profitFactor - baseline.profitFactor).toFixed(2)}`);

console.log('\n================================================================');
console.log('🎉 CANDIDATE v14.1 ABLATION MATRIX STUDY COMPLETED WITH SUCCESS!');
console.log('================================================================');
