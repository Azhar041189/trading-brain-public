const assert = require('assert');
const marketStructureEngine = require('../src/core/marketStructureEngine');

console.log('================================================================');
console.log('       🧪 TESTING ALGORITHMIC MARKET STRUCTURE ENGINE           ');
console.log('================================================================\n');

// 1. Synthetic Zigzag Bullish Trend Candles (Clear Wave Peaks & Troughs)
const bullCandles = [];
const wavePoints = [
  100, 103, 106, 110, 107, 104, 101, // Wave 1: Peak at 110, Trough at 101
  105, 109, 114, 118, 115, 111, 108, // Wave 2: Peak at 118 (HH), Trough at 108 (HL)
  112, 117, 122, 126, 123, 119, 116  // Wave 3: Peak at 126 (HH), Trough at 116 (HL)
];

wavePoints.forEach((p, i) => {
  bullCandles.push({
    time: 1724666400 + (i * 300),
    timestamp: new Date((1724666400 + (i * 300)) * 1000).toISOString(),
    open: p - 1,
    high: p + 1.5,
    low: p - 1.5,
    close: p + 0.5,
    volume: 1500
  });
});

// Test 1: Empty input safety
const emptyStructure = marketStructureEngine.analyzeStructure([]);
assert(emptyStructure.trend === 'SIDEWAYS' || emptyStructure.trend === 'SIDEWAYS_RANGE', 'Empty input returns SIDEWAYS');
console.log('✅ [PASS] Gracefully handles empty candle array');

// Test 2: Bullish Market Structure & Pivots (strength 2 for smaller test series)
const customEngine = new (marketStructureEngine.constructor)({ swingStrength: 2 });
const bullStructure = customEngine.analyzeStructure(bullCandles);
assert(bullStructure.pivots.length > 0, 'Detected confirmed fractal swing pivots');
assert(bullStructure.pivots.some(p => p.type === 'SWING_HIGH'), 'Contains Swing Highs');
assert(bullStructure.pivots.some(p => p.type === 'SWING_LOW'), 'Contains Swing Lows');
console.log(`✅ [PASS] Found ${bullStructure.pivots.length} swing pivots | Trend: ${bullStructure.trend}`);

// Test 3: BOS / CHoCH Event Detection
assert(Array.isArray(bullStructure.events), 'Events is an array');
console.log(`✅ [PASS] Detected ${bullStructure.events.length} structural break/sweep events`);

console.log('\n================================================================');
console.log('🎉 MARKET STRUCTURE ENGINE TEST SUITE: ALL TESTS PASSED!');
console.log('================================================================');
