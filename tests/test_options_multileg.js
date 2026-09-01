const optionsMultiLegEngine = require('../src/core/optionsMultiLegEngine');

console.log('================================================================');
console.log('       🎯 OPTIONS MULTI-LEG ENGINE & MARGIN OPTIMIZER TEST      ');
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

// 1. Iron Condor Verification
const condor = optionsMultiLegEngine.buildStrategy('IRON_CONDOR', 24000, 24000, 50, 50, '₹');
assert(condor.success === true, 'Iron Condor strategy built successfully');
assert(condor.legs.length === 4, 'Iron Condor contains 4 legs');
assert(condor.metrics.hedgedMarginReq < condor.metrics.nakedMarginReq, 'Hedged margin is strictly lower than naked margin (Broker relief active)');
assert(condor.payoffCurve.length === 25, '25-point Payoff spectrum generated');
assert(typeof condor.metrics.netDelta === 'number', 'Net portfolio delta calculated');
assert(typeof condor.metrics.netThetaDaily === 'string', 'Daily theta decay estimated');

// 2. Bull Put Spread Verification
const bullPut = optionsMultiLegEngine.buildStrategy('BULL_PUT_SPREAD', 24000, 24000, 50, 50, '₹');
assert(bullPut.legs.length === 2, 'Bull Put Spread contains 2 legs');
assert(bullPut.metrics.isCredit === true, 'Bull Put Spread is net credit');
assert(bullPut.metrics.maxProfit > 0, 'Bull Put max profit is positive');

// 3. Bear Call Spread Verification
const bearCall = optionsMultiLegEngine.buildStrategy('BEAR_CALL_SPREAD', 24000, 24000, 50, 50, '₹');
assert(bearCall.legs.length === 2, 'Bear Call Spread contains 2 legs');
assert(bearCall.metrics.isCredit === true, 'Bear Call Spread is net credit');

// 4. Long Straddle Verification
const straddle = optionsMultiLegEngine.buildStrategy('LONG_STRADDLE', 24000, 24000, 50, 50, '₹');
assert(straddle.legs.length === 2, 'Long Straddle contains 2 legs');
assert(straddle.metrics.isCredit === false, 'Long Straddle is net debit');

// 5. Atomic Multi-Leg Order Payload Construction
const payload = optionsMultiLegEngine.buildAtomicOrderPayload(condor);
assert(payload.orderType === 'ATOMIC_MULTI_LEG', 'Atomic order payload type is valid');
assert(payload.legs.length === 4, 'Atomic order payload contains 4 legs');
assert(payload.executionMode === 'DMA_ATOMIC_PARALLEL', 'Execution mode is DMA_ATOMIC_PARALLEL');

console.log('================================================================');
console.log('Result: ' + passed + '/' + total + ' Checks Passed');
if (passed === total) {
  console.log('🎉 ALL OPTIONS MULTI-LEG TESTS PASSED (100% GREEN)!');
  process.exit(0);
} else {
  console.error('❌ Some tests failed');
  process.exit(1);
}
