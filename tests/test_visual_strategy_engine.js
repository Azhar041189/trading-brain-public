const visualStrategyEngine = require('../src/core/visualStrategyEngine');

console.log('================================================================');
console.log('       🎨 VISUAL STRATEGY STUDIO AST & BACKTESTER TEST          ');
console.log('================================================================');

let passed = 0;
let total = 0;

function assert(condition, name) {
  total++;
  if (condition) {
    console.log('[PASS ' + total + '] ' + name);
    passed++;
  } else {
    console.error('[FAIL ' + total + '] ' + name);
    process.exitCode = 1;
  }
}

// 1. Generate Mock 100-bar Candle Series
const candles = [];
for (let i = 0; i < 100; i++) {
  candles.push({
    close: 100 + Math.sin(i * 0.15) * 8 + (i * 0.1),
    volume: 1000 + (i % 4 === 0 ? 3000 : 600),
    rsi: 30 + (i % 10) * 5,
    ema21: 100 + (i * 0.08),
    gainzConf: 80 + (i % 5) * 3
  });
}

// 2. Single Condition Evaluation Tests
const c = candles[10];
const prev = candles[9];

assert(visualStrategyEngine.evaluateCondition(c, prev, { indicator: 'RSI', operator: '>', threshold: 20 }) === true, 'RSI > 20 evaluation passed');
assert(visualStrategyEngine.evaluateCondition(c, prev, { indicator: 'RSI', operator: '<', threshold: 10 }) === false, 'RSI < 10 evaluation passed');
assert(visualStrategyEngine.evaluateCondition(c, prev, { indicator: 'GAINZALGO_CONF', operator: '>=', threshold: 80 }) === true, 'GainzAlgo Conf evaluation passed');

// 3. Multi-Block Backtest Execution
const strategy = {
  name: 'RSI Reversal + Volume Surge',
  direction: 'LONG',
  entryConditions: [
    { indicator: 'RSI', operator: '<', threshold: 50 },
    { indicator: 'VOLUME_SPIKE', operator: '>', threshold: 1.1 }
  ],
  stopLossPct: 1.5,
  takeProfitPct: 3.5
};

const backtestRes = visualStrategyEngine.backtestVisualStrategy(strategy, candles);
assert(backtestRes.success === true, 'Visual strategy backtest executed');
assert(backtestRes.totalTrades > 0, 'Trades were generated across candle series');
assert(typeof backtestRes.winRate === 'string', 'Win rate formatted as string percentage');
assert(typeof backtestRes.profitFactor === 'string', 'Profit factor calculated');
assert(typeof backtestRes.totalPnlPct === 'string', 'Total P&L % calculated');

// 4. Save to Foundry Store
const saveRes = visualStrategyEngine.saveStrategy('custom_rsi_vol_1', strategy);
assert(saveRes.success === true, 'Custom strategy saved into Foundry store');

console.log('================================================================');
console.log('Result: ' + passed + '/' + total + ' Checks Passed');
if (passed === total) {
  console.log('🎉 ALL VISUAL STRATEGY STUDIO TESTS PASSED (100% GREEN)!');
  process.exit(0);
} else {
  console.error('❌ Some tests failed');
  process.exit(1);
}
