const assert = require('assert');
const vwapEngine = require('../src/core/vwapEngine');

console.log('================================================================');
console.log('       🧪 TESTING INSTITUTIONAL MULTI-ANCHOR VWAP ENGINE        ');
console.log('================================================================\n');

// 1. Synthetic Candles
const syntheticCandles = [];
for (let i = 0; i < 40; i++) {
  const p = 100 + i * 0.5;
  syntheticCandles.push({
    time: 1724666400 + (i * 300),
    timestamp: new Date((1724666400 + (i * 300)) * 1000).toISOString(),
    open: p - 0.2,
    high: p + 1.0,
    low: p - 0.8,
    close: p + 0.4,
    volume: 1000 + (i * 50)
  });
}

// Test 1: Empty input safety
const emptyVWAP = vwapEngine.computeVWAP([]);
assert(emptyVWAP.currentVWAP === 0, 'Empty input returns 0 VWAP');
console.log('✅ [PASS] Gracefully handles empty candle array');

// Test 2: Standard Session VWAP & Bands
const sessionData = vwapEngine.computeVWAP(syntheticCandles);
assert(typeof sessionData.currentVWAP === 'number' && sessionData.currentVWAP > 0, 'VWAP is valid positive number');
assert(sessionData.bands.upper1 > sessionData.currentVWAP, '+1σ is above VWAP');
assert(sessionData.bands.lower1 < sessionData.currentVWAP, '-1σ is below VWAP');
assert(sessionData.bands.upper2 > sessionData.bands.upper1, '+2σ is above +1σ');
assert(sessionData.bands.lower2 < sessionData.bands.lower1, '-2σ is below -1σ');
assert(sessionData.series.length === syntheticCandles.length, 'Series length matches candles');
console.log(`✅ [PASS] VWAP: $${sessionData.currentVWAP} | +1σ: $${sessionData.bands.upper1} | -1σ: $${sessionData.bands.lower1}`);

// Test 3: Anchored VWAP
const avwap = vwapEngine.computeAnchoredVWAP(syntheticCandles, 'SWING_LOW');
assert(avwap.currentVWAP > 0, 'Anchored VWAP computes valid series');
console.log(`✅ [PASS] Anchored VWAP (Swing Low): $${avwap.currentVWAP}`);

console.log('\n================================================================');
console.log('🎉 VWAP ENGINE TEST SUITE: ALL TESTS PASSED!');
console.log('================================================================');
