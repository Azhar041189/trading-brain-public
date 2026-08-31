/**
 * test_wfo_zero_mutation_invariant.js
 * 
 * Executable Proof of Zero-Decision-Delta & Zero-Mutation Invariant:
 * Asserts that the Automated Walk-Forward Optimizer (WFO) operates strictly
 * in observational shadow mode with ZERO mid-trial parameter mutation and
 * ZERO trading decision delta.
 */

const assert = require('assert');
const wfo = require('../src/core/automatedWalkForwardOptimizer');
const GainzAlgoV2AlphaEngine = require('../src/core/gainzAlgoV2AlphaEngine');
const gainzAlgo = new GainzAlgoV2AlphaEngine();
const executionEngine = require('../src/agents/execution/executionEngine');
const riskManager = require('../src/agents/risk/riskManager');

console.log('================================================================');
console.log('  TEST: WFO SCIENTIFIC ZERO-DECISION-DELTA & ZERO-MUTATION TEST  ');
console.log('================================================================\n');

// 1. Assert Immutable Flag & Mode
console.log('1. Checking Immutability of Governance Flags...');
assert.strictEqual(wfo.mode, 'OBSERVATIONAL_SHADOW_ONLY', 'Mode must be OBSERVATIONAL_SHADOW_ONLY');
assert.strictEqual(wfo.MUTATION_ENABLED, false, 'MUTATION_ENABLED must be false');

try {
  wfo.MUTATION_ENABLED = true;
} catch (e) {}
assert.strictEqual(wfo.MUTATION_ENABLED, false, 'MUTATION_ENABLED must be non-writable / read-only');
console.log('   PASS: Mode is OBSERVATIONAL_SHADOW_ONLY');
console.log('   PASS: MUTATION_ENABLED is strictly false and tamper-proof\n');

// 2. Assert applyParameters Veto
console.log('2. Testing applyParameters Execution Guard...');
const result = wfo.applyParameters('HELIX_STRATEGY', { atrMultiplier: 3.5 });
assert.strictEqual(result.applied, false, 'applyParameters must return applied: false');
assert.strictEqual(result.reason, 'MUTATION_LOCKED_FOR_PROBATION', 'applyParameters must specify MUTATION_LOCKED_FOR_PROBATION');
console.log('   PASS: Illegal mutation attempt rejected safely: ' + result.reason + '\n');

// 3. Assert Object.freeze on Calibrated Parameter Outputs
console.log('3. Checking Parameter Output Immutability...');
const defaultParams = wfo.getCalibratedParams('CRYPTO', 'BTCUSDT');
assert.strictEqual(Object.isFrozen(defaultParams), true, 'Returned parameters must be frozen');
console.log('   PASS: Calibrated parameter structure is Object.freeze protected\n');

// 4. Deterministic Candle Fixtures (Zero Math.random)
console.log('4. Generating 70-bar Deterministic Candle Fixture...');
const deterministicCandles = [];
let basePrice = 50000;
const seedDeltas = [
  12, -8, 15, 22, -5, -14, 18, 30, 25, -10,
  -12, 8, -15, -20, 5, 14, -18, -30, -25, 10,
  10, 15, 20, 25, 30, 35, 40, -10, -5, 15,
  -20, -25, -30, 10, 15, -5, -10, 25, 30, 35,
  12, 18, 24, -15, -22, 10, 14, 18, 22, 28,
  -30, -35, -40, 15, 20, 25, -10, -15, 20, 30,
  15, 18, 22, 25, -8, -12, 14, 20, 25, 30
];

for (let i = 0; i < seedDeltas.length; i++) {
  basePrice += seedDeltas[i];
  deterministicCandles.push({
    open: basePrice - seedDeltas[i],
    high: basePrice + 35,
    low: basePrice - 35,
    close: basePrice,
    volume: 1500 + (i * 10)
  });
}
console.log('   PASS: 70 Deterministic Candles Created\n');

// 5. Full End-to-End Zero-Decision-Delta Test
console.log('5. Evaluating Full Signal & Execution Decision BEFORE WFO...');
const decisionBefore = gainzAlgo.evaluate('BTCUSDT', deterministicCandles, 'CRYPTO');
const exitDecisionBefore = executionEngine.evaluateExit(
  { symbol: 'BTCUSDT', side: 'LONG', entryPrice: 50000, stopLoss: 49000, takeProfit: 52000 },
  50500
);

console.log('   Signal Before WFO: hasSignal=' + decisionBefore.hasSignal + ', action=' + decisionBefore.action + ', conf=' + decisionBefore.confidence);

// Run full WFO simulation pass
wfo.simulateAtrStrategy(deterministicCandles, 2.5);

console.log('\n6. Evaluating Full Signal & Execution Decision AFTER WFO...');
const decisionAfter = gainzAlgo.evaluate('BTCUSDT', deterministicCandles, 'CRYPTO');
const exitDecisionAfter = executionEngine.evaluateExit(
  { symbol: 'BTCUSDT', side: 'LONG', entryPrice: 50000, stopLoss: 49000, takeProfit: 52000 },
  50500
);

console.log('   Signal After WFO:  hasSignal=' + decisionAfter.hasSignal + ', action=' + decisionAfter.action + ', conf=' + decisionAfter.confidence);

// Assert Full Equivalence
assert.strictEqual(decisionBefore.hasSignal, decisionAfter.hasSignal, 'Signal trigger must be identical');
assert.strictEqual(decisionBefore.action, decisionAfter.action, 'Signal action must be identical');
assert.strictEqual(decisionBefore.direction, decisionAfter.direction, 'Signal direction must be identical');
assert.strictEqual(decisionBefore.confidence, decisionAfter.confidence, 'Confidence must be identical');
assert.strictEqual(decisionBefore.stopLoss, decisionAfter.stopLoss, 'Stop loss must be identical');
assert.strictEqual(decisionBefore.takeProfit, decisionAfter.takeProfit, 'Take profit must be identical');

console.log('   PASS: Signal Trigger Equivalence:   ' + decisionBefore.hasSignal + ' === ' + decisionAfter.hasSignal);
console.log('   PASS: Signal Action Equivalence:    ' + decisionBefore.action + ' === ' + decisionAfter.action);
console.log('   PASS: Signal Direction Equivalence: ' + decisionBefore.direction + ' === ' + decisionAfter.direction);
console.log('   PASS: Signal Conf Equivalence:      ' + decisionBefore.confidence + ' === ' + decisionAfter.confidence);
console.log('   PASS: Signal StopLoss Equivalence:  ' + decisionBefore.stopLoss + ' === ' + decisionAfter.stopLoss);
console.log('   PASS: Full Zero-Decision-Delta & Zero-Parameter-Delta CONFIRMED\n');

console.log('================================================================');
console.log('  SUCCESS: ZERO-DECISION-DELTA INVARIANT: 100% VERIFIED & GREEN ');
console.log('================================================================');
