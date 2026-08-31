const optionsMultiLegEngine = require('../src/core/optionsMultiLegEngine');
const visualStrategyEngine = require('../src/core/visualStrategyEngine');
const l3DepthReplaySimulator = require('../src/core/l3DepthReplaySimulator');

console.log('================================================================');
console.log('       🏛️ INSTITUTIONAL TRIO COMPREHENSIVE TEST BATTERY         ');
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

// 1. Test Options Multi-Leg Engine
console.log('\n--- 1. Testing Options Multi-Leg Strategy Slicer & Margin Optimizer ---');
const condor = optionsMultiLegEngine.buildStrategy('IRON_CONDOR', 24000, 24000, 50, 50, '₹');
assert(condor.success === true, 'Iron Condor strategy built successfully');
assert(condor.legs.length === 4, 'Iron Condor contains 4 legs');
assert(condor.metrics.hedgedMarginReq < condor.metrics.nakedMarginReq, 'Hedged margin is strictly less than naked margin (Margin relief verified)');
assert(condor.payoffCurve.length === 25, '25-point Payoff curve generated');

const bullPut = optionsMultiLegEngine.buildStrategy('BULL_PUT_SPREAD', 24000, 24000, 50, 50, '₹');
assert(bullPut.legs.length === 2, 'Bull Put Spread contains 2 legs');
assert(bullPut.metrics.isCredit === true, 'Bull Put Spread is net credit');

const atomicPayload = optionsMultiLegEngine.buildAtomicOrderPayload(condor);
assert(atomicPayload.orderType === 'ATOMIC_MULTI_LEG', 'Atomic order payload generated');
assert(atomicPayload.legs.length === 4, 'Atomic payload contains 4 executable legs');

// 2. Test Visual Strategy Engine (No-Code Studio)
console.log('\n--- 2. Testing Visual Strategy Studio AST & Backtester ---');
const mockCandles = [];
for (let i = 0; i < 50; i++) {
  mockCandles.push({
    close: 100 + Math.sin(i * 0.2) * 10,
    volume: 1000 + (i % 5 === 0 ? 2500 : 500),
    rsi: 30 + (i % 8) * 6,
    ema21: 100
  });
}

const mockStrategy = {
  name: 'RSI Oversold + Volume Breakout',
  direction: 'LONG',
  entryConditions: [
    { indicator: 'RSI', operator: '<', threshold: 45 },
    { indicator: 'VOLUME_SPIKE', operator: '>', threshold: 1.2 }
  ],
  stopLossPct: 1.5,
  takeProfitPct: 3.5
};

const backtestRes = visualStrategyEngine.backtestVisualStrategy(mockStrategy, mockCandles);
assert(backtestRes.success === true, 'Visual strategy backtest executed successfully');
assert(backtestRes.totalTrades > 0, 'Visual strategy generated trades on candle history');
assert(typeof backtestRes.winRate === 'string', 'Win rate calculated and formatted');

// 3. Test L3 Depth Replay Simulator
console.log('\n--- 3. Testing L3 Depth Replay & Passive Scalping Simulator ---');
const l3Snap = l3DepthReplaySimulator.generateL3Snapshot('NIFTY', 24000);
assert(l3Snap.success === true, 'L3 depth snapshot generated');
assert(l3Snap.bids.length === 15 && l3Snap.asks.length === 15, '15-level reconstructed L2/L3 order book verified');
assert(typeof l3Snap.microstructure.orderFlowImbalance === 'number', 'Order Flow Imbalance (OFI) computed');
assert(typeof l3Snap.microstructure.vpinToxicity === 'number', 'VPIN toxicity score computed');

const simOrder = l3DepthReplaySimulator.simulatePassiveExecution('BUY', 24000, 50, l3Snap);
assert(simOrder.success === true, 'Passive order queue simulation executed');
assert(typeof simOrder.queuePositionAhead === 'number', 'Queue position ahead computed');
assert(typeof simOrder.fillProbabilityPct === 'string', 'Fill probability % calculated');

console.log('================================================================');
console.log('Result: ' + passed + '/' + total + ' Checks Passed');
if (passed === total) {
  console.log('🎉 ALL INSTITUTIONAL TRIO TESTS PASSED (100% GREEN)!');
  process.exit(0);
} else {
  console.error('❌ Some tests failed');
  process.exit(1);
}