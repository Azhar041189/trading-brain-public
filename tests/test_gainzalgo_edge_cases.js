/**
 * Comprehensive Edge Case & Adversarial Stress Suite for GainzAlgo V2 Alpha
 */

const GainzAlgoV2AlphaEngine = require('../src/core/gainzAlgoV2AlphaEngine');

async function runEdgeCaseBattery() {
  console.log('================================================================================');
  console.log('       🛡️ GAINZALGO V2 ALPHA ADVERSARIAL EDGE CASE & STRESS BATTERY             ');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      failed++;
    }
  }

  const engine = new GainzAlgoV2AlphaEngine();

  // --- 1. NULL / UNDEFINED / MALFORMED INPUTS ---
  console.log('--- 1. NULL, UNDEFINED & MALFORMED INPUT GUARDS ---');
  assert(engine.evaluate(null, null).hasSignal === false, 'Handles evaluate(null, null) gracefully');
  assert(engine.evaluate('BTC', undefined).hasSignal === false, 'Handles evaluate(sym, undefined) gracefully');
  assert(engine.evaluate(undefined, []).hasSignal === false, 'Handles evaluate(undefined, []) gracefully');
  assert(engine.calculateEMA(null, 14).length === 0, 'calculateEMA(null) returns []');
  assert(engine.calculateEMA([], 14).length === 0, 'calculateEMA([]) returns []');
  assert(engine.calculateRSI(null, 14) === 50, 'calculateRSI(null) returns 50 (neutral)');
  assert(engine.calculateRSI([], 14) === 50, 'calculateRSI([]) returns 50 (neutral)');
  assert(engine.calculateATR(null, 14) === 1.0, 'calculateATR(null) returns fallback > 0');
  assert(engine.calculateATR([], 14) === 1.0, 'calculateATR([]) returns fallback > 0');

  // --- 2. BOUNDARY CANDLE SIZES (0 to 21 bars) ---
  console.log('\n--- 2. BOUNDARY CANDLE LENGTHS ---');
  for (let count of [0, 1, 2, 5, 13, 14, 19]) {
    const candles = Array.from({ length: count }, (_, i) => ({
      open: 100, high: 101, low: 99, close: 100, volume: 100, timestamp: Date.now() - i * 60000
    }));
    const res = engine.evaluate('TEST', candles);
    assert(res.hasSignal === false, `Bars count = ${count}: rejected safely (hasSignal = false)`);
  }

  // Exactly 20 bars (threshold)
  const exact20Bars = Array.from({ length: 20 }, (_, i) => ({
    open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1000, timestamp: Date.now() - (20 - i) * 60000
  }));
  const res20 = engine.evaluate('TEST', exact20Bars);
  assert(res20 !== null && typeof res20 === 'object', 'Exact 20 bars evaluates without throwing');

  // --- 3. ZERO VOLATILITY / FLATLINE MARKET ---
  console.log('\n--- 3. ZERO VOLATILITY & FLATLINE MARKET ---');
  const flatCandles = Array.from({ length: 30 }, (_, i) => ({
    open: 100, high: 100, low: 100, close: 100, volume: 0, timestamp: Date.now() - (30 - i) * 60000
  }));
  const flatRes = engine.evaluate('FLAT_COIN', flatCandles);
  assert(flatRes.hasSignal === false || flatRes.action === 'HOLD', 'Flatline market (zero movement, zero volume) does not trigger signals');
  assert(!isNaN(flatRes.atr) && !isNaN(flatRes.rsi), 'Flatline calculations produce valid non-NaN numbers');

  // --- 4. FLASH CRASH & 1000% PUMP STRESS ---
  console.log('\n--- 4. EXTREME PRICE ANOMALIES & VOLATILITY SHOCKS ---');
  const flashCrashCandles = Array.from({ length: 25 }, (_, i) => ({
    open: 1000, high: 1010, low: 990, close: 1000, volume: 500, timestamp: Date.now() - (25 - i) * 60000
  }));
  flashCrashCandles[24] = { open: 1000, high: 1000, low: 50, close: 50, volume: 50000, timestamp: Date.now() };
  const crashRes = engine.evaluate('CRASH_ASSET', flashCrashCandles);
  assert(!isNaN(crashRes.stopLoss) && crashRes.stopLoss > crashRes.price, 'Flash crash short Stop Loss remains strictly above entry price');
  assert(crashRes.targets.tp1 < crashRes.price, 'Flash crash short TP1 remains strictly below entry price');

  // Extreme Pump
  const flashPumpCandles = Array.from({ length: 25 }, (_, i) => ({
    open: 100, high: 105, low: 95, close: 100, volume: 500, timestamp: Date.now() - (25 - i) * 60000
  }));
  flashPumpCandles[24] = { open: 100, high: 1000, low: 100, close: 1000, volume: 50000, timestamp: Date.now() };
  const pumpRes = engine.evaluate('PUMP_ASSET', flashPumpCandles);
  assert(!isNaN(pumpRes.stopLoss) && pumpRes.stopLoss < pumpRes.price, 'Flash pump long Stop Loss remains strictly below entry price');
  assert(pumpRes.targets.tp3 > pumpRes.targets.tp2 && pumpRes.targets.tp2 > pumpRes.targets.tp1, 'Flash pump target brackets scale ascendingly (TP3 > TP2 > TP1)');

  // --- 5. RSI EDGE VALUES (100, 0, 50) ---
  console.log('\n--- 5. RSI EDGE BEHAVIOR ---');
  const allUpCandles = Array.from({ length: 30 }, (_, i) => ({
    open: 10 + i, high: 12 + i, low: 10 + i, close: 11 + i, volume: 100, timestamp: Date.now() - i * 60000
  }));
  const rsi100 = engine.calculateRSI(allUpCandles);
  assert(rsi100 >= 85, `All up-candles yield saturated high RSI (${rsi100.toFixed(1)})`);

  const allDownCandles = Array.from({ length: 30 }, (_, i) => ({
    open: 100 - i, high: 100 - i, low: 98 - i, close: 99 - i, volume: 100, timestamp: Date.now() - i * 60000
  }));
  const rsi0 = engine.calculateRSI(allDownCandles);
  assert(rsi0 <= 15, `All down-candles yield saturated low RSI (${rsi0.toFixed(1)})`);

  // --- 6. WEBHOOK ADVERSARIAL SECURITY & PAYLOAD VALIDATION ---
  console.log('\n--- 6. WEBHOOK ADVERSARIAL & SECURITY TESTS ---');

  // Case A: Unauthorized secret
  try {
    const unauthRes = await fetch('http://localhost:3004/api/webhook/tradingview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'BAD_KEY_123', symbol: 'BTCUSDT', action: 'BUY' })
    });
    assert(unauthRes.status === 401, `Rejects invalid secret with 401 Unauthorized (${unauthRes.status})`);
  } catch (e) {
    assert(false, `Unauthorized check threw unexpected network error: ${e.message}`);
  }

  // Case B: Missing symbol
  try {
    const noSymRes = await fetch('http://localhost:3004/api/webhook/tradingview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'TRADING_BRAIN_AUTH_KEY', action: 'BUY' })
    });
    assert(noSymRes.status === 400, `Rejects missing symbol with 400 Bad Request (${noSymRes.status})`);
  } catch (e) {
    assert(false, `Missing symbol check threw unexpected error: ${e.message}`);
  }

  // Case C: Missing action
  try {
    const noActRes = await fetch('http://localhost:3004/api/webhook/tradingview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'TRADING_BRAIN_AUTH_KEY', symbol: 'ETHUSDT' })
    });
    assert(noActRes.status === 400, `Rejects missing action with 400 Bad Request (${noActRes.status})`);
  } catch (e) {
    assert(false, `Missing action check threw unexpected error: ${e.message}`);
  }

  // Case D: Case-insensitive action formatting ("buy", "long", "sell", "short")
  for (let act of ['buy', 'BUY', 'Long', 'sell', 'SHORT', 'Sell_Limit']) {
    try {
      const actRes = await fetch('http://localhost:3004/api/webhook/tradingview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'TRADING_BRAIN_AUTH_KEY', symbol: 'SOLUSDT', action: act, price: 95.50 })
      });
      const data = await actRes.json();
      assert(actRes.status === 200 && data.success === true, `Successfully normalizes action variant "${act}" -> 200 OK`);
    } catch (e) {
      assert(false, `Action normalizer check threw error on "${act}": ${e.message}`);
    }
  }

  // Case E: String prices with ticker suffix (e.g. "BTCUSDT.P")
  try {
    const suffixRes = await fetch('http://localhost:3004/api/webhook/tradingview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: 'TRADING_BRAIN_AUTH_KEY',
        symbol: 'BTCUSDT.P',
        action: 'BUY',
        price: "79500.25",
        sl: "78200.00",
        tp: "81500.00"
      })
    });
    const data = await suffixRes.json();
    assert(suffixRes.status === 200 && data.message.includes('BTCUSDT'), `Strips perp suffix "BTCUSDT.P" -> "BTCUSDT" (${data.message})`);
  } catch (e) {
    assert(false, `Perp suffix check threw error: ${e.message}`);
  }

  console.log('\n================================================================================');
  console.log(`📊 ADVERSARIAL EDGE CASE SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================================');

  if (failed > 0) process.exit(1);
}

runEdgeCaseBattery().catch(e => {
  console.error(e);
  process.exit(1);
});
