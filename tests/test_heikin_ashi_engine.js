const assert = require('assert');
const heikinAshiEngine = require('../src/core/heikinAshiEngine');

console.log('================================================================');
console.log('       🧪 TESTING HEIKIN-ASHI TRANSFORMATION ENGINE             ');
console.log('================================================================\n');

const candles = [
  { time: 1000, open: 100, high: 105, low: 95, close: 102, volume: 100 },
  { time: 1060, open: 102, high: 108, low: 101, close: 106, volume: 150 },
  { time: 1120, open: 106, high: 110, low: 104, close: 109, volume: 120 }
];

// Test 1: Empty input
assert(heikinAshiEngine.transform([]).length === 0, 'Empty input returns empty array');
console.log('✅ [PASS] Gracefully handles empty candle array');

// Test 2: Transformation
const ha = heikinAshiEngine.transform(candles);
assert(ha.length === candles.length, 'Output length matches input length');

// Check first candle formula
const expectedClose0 = (100 + 105 + 95 + 102) / 4; // 100.5
const expectedOpen0 = (100 + 102) / 2; // 101
assert.strictEqual(ha[0].close, expectedClose0, 'First HA close matches formula');
assert.strictEqual(ha[0].open, expectedOpen0, 'First HA open matches formula');
console.log(`✅ [PASS] HA Bar 0: Open=${ha[0].open}, High=${ha[0].high}, Low=${ha[0].low}, Close=${ha[0].close}`);

// Check second candle formula
const expectedOpen1 = (expectedOpen0 + expectedClose0) / 2; // 100.75
assert.strictEqual(ha[1].open, expectedOpen1, 'Second HA open uses previous HA midpoint');
console.log(`✅ [PASS] HA Bar 1: Open=${ha[1].open}, High=${ha[1].high}, Low=${ha[1].low}, Close=${ha[1].close}`);

console.log('\n================================================================');
console.log('🎉 HEIKIN-ASHI ENGINE TEST SUITE: ALL TESTS PASSED!');
console.log('================================================================');
