const assert = require('assert');
const volumeProfileEngine = require('../src/core/volumeProfileEngine');

console.log('================================================================');
console.log('       🧪 TESTING INSTITUTIONAL VOLUME PROFILE ENGINE          ');
console.log('================================================================\n');

// 1. Synthetic Candles Fixture
const basePrice = 100;
const syntheticCandles = [];
for (let i = 0; i < 50; i++) {
  const p = basePrice + Math.sin(i / 5) * 10;
  syntheticCandles.push({
    time: 1724666400 + (i * 300),
    timestamp: new Date((1724666400 + (i * 300)) * 1000).toISOString(),
    open: p - 1,
    high: p + 3,
    low: p - 3,
    close: p + 1,
    volume: i >= 20 && i <= 30 ? 5000 : 1000 // Heavy concentration in middle
  });
}

// Test 1: Empty input safety
const emptyProfile = volumeProfileEngine.computeProfile([]);
assert(emptyProfile.poc === 0, 'Empty profile returns 0 POC');
assert(emptyProfile.bins.length === 0, 'Empty profile returns 0 bins');
console.log('✅ [PASS] Gracefully handles empty candle array');

// Test 2: Full Profile Computation
const profile = volumeProfileEngine.computeProfile(syntheticCandles, 40);
assert(typeof profile.poc === 'number' && profile.poc > 0, 'POC is positive number');
assert(typeof profile.vah === 'number' && profile.vah >= profile.poc, 'VAH >= POC');
assert(typeof profile.val === 'number' && profile.val <= profile.poc, 'VAL <= POC');
assert(profile.bins.length === 40, 'Created exactly 40 price bins');
assert(profile.valueAreaCoveragePct >= 65 && profile.valueAreaCoveragePct <= 75, 'Value Area covers ~70% total volume');
console.log(`✅ [PASS] POC: $${profile.poc} | VAH: $${profile.vah} | VAL: $${profile.val} (Coverage: ${profile.valueAreaCoveragePct}%)`);

// Test 3: Price Location Evaluation
const aboveLoc = volumeProfileEngine.evaluatePriceLocation(profile.vah + 5, profile);
assert(aboveLoc.location === 'ABOVE_VALUE_AREA', 'Identified Above Value Area');
assert(aboveLoc.bias === 'BULLISH_EXPANSION', 'Bullish Expansion bias');

const belowLoc = volumeProfileEngine.evaluatePriceLocation(profile.val - 5, profile);
assert(belowLoc.location === 'BELOW_VALUE_AREA', 'Identified Below Value Area');
assert(belowLoc.bias === 'BEARISH_EXPANSION', 'Bearish Expansion bias');

const insideLoc = volumeProfileEngine.evaluatePriceLocation(profile.poc, profile);
assert(insideLoc.location === 'INSIDE_VALUE_AREA', 'Identified Inside Value Area');
console.log('✅ [PASS] Accurate price location and value area bias evaluation');

console.log('\n================================================================');
console.log('🎉 VOLUME PROFILE ENGINE TEST SUITE: ALL TESTS PASSED!');
console.log('================================================================');
