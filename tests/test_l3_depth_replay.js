const l3DepthReplaySimulator = require('../src/core/l3DepthReplaySimulator');

console.log('================================================================');
console.log('       ⚡ L3 MICROSTRUCTURE DEPTH REPLAY & SCALPING TEST        ');
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

// 1. 15-Level LOB Snapshot Generation
const snap = l3DepthReplaySimulator.generateL3Snapshot('NIFTY', 24000);
assert(snap.success === true, 'L3 depth snapshot generated successfully');
assert(snap.bids.length === 15, '15 bid depth levels generated');
assert(snap.asks.length === 15, '15 ask depth levels generated');
assert(snap.spread > 0, 'Bid/Ask spread is positive');

// 2. Microstructure & Toxicity Analysis
assert(typeof snap.microstructure.orderFlowImbalance === 'number', 'Order Flow Imbalance (OFI) computed');
assert(snap.microstructure.orderFlowImbalance >= -1.0 && snap.microstructure.orderFlowImbalance <= 1.0, 'OFI is bounded within [-1.0, +1.0]');
assert(typeof snap.microstructure.vpinToxicity === 'number', 'VPIN toxicity score computed');
assert(typeof snap.microstructure.estimatedSlippageBps === 'string', 'Kyle Lambda slippage calculated in bps');

// 3. Passive Limit Order Queue Simulator
const simBuy = l3DepthReplaySimulator.simulatePassiveExecution('BUY', 24000, 50, snap);
assert(simBuy.success === true, 'Passive buy order simulation executed');
assert(typeof simBuy.queuePositionAhead === 'number', 'Orders ahead in queue calculated');
assert(typeof simBuy.fillProbabilityPct === 'string', 'Fill probability percentage computed');
assert(typeof simBuy.estimatedTimeToFillMs === 'string', 'Estimated time-to-fill computed in ms');
assert(typeof simBuy.makerRebateEarned === 'string', 'Maker rebate projection calculated');

const simSell = l3DepthReplaySimulator.simulatePassiveExecution('SELL', 24000, 50, snap);
assert(simSell.success === true, 'Passive sell order simulation executed');

console.log('================================================================');
console.log('Result: ' + passed + '/' + total + ' Checks Passed');
if (passed === total) {
  console.log('🎉 ALL L3 DEPTH REPLAY TESTS PASSED (100% GREEN)!');
  process.exit(0);
} else {
  console.error('❌ Some tests failed');
  process.exit(1);
}
