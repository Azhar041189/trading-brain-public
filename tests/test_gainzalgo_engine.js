/**
 * GainzAlgo V2 Alpha Engine & Webhook Gateway Verification Suite
 */

const GainzAlgoV2AlphaEngine = require('../src/core/gainzAlgoV2AlphaEngine');

async function runTests() {
  console.log('================================================================================');
  console.log('          🧪 TESTING GAINZALGO V2 ALPHA NATIVE ENGINE & WEBHOOK                 ');
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

  // Test 1: Class initialization & parameter defaults
  assert(engine.name === 'GainzAlgo V2 Alpha', 'Engine initialized with correct name');
  assert(engine.fastEma === 9 && engine.midEma === 21 && engine.slowEma === 50, 'EMA parameters match (9/21/50)');
  assert(engine.atrPeriod === 14 && engine.rsiPeriod === 14, 'ATR and RSI periods match (14)');

  // Test 2: Generate mock candles (Bullish Trend)
  const bullishCandles = [];
  let basePrice = 100;
  for (let i = 0; i < 30; i++) {
    basePrice += (i * 0.5);
    bullishCandles.push({
      open: basePrice - 0.5,
      high: basePrice + 1.0,
      low: basePrice - 0.8,
      close: basePrice + 0.8,
      volume: 1000 + (i * 100),
      timestamp: Date.now() - (30 - i) * 60000
    });
  }

  const bullResult = engine.evaluate('BTCUSDT', bullishCandles, 'CRYPTO');
  assert(bullResult.direction === 'BUY' || bullResult.action === 'LONG', 'Bullish trend generates BUY/LONG direction');
  assert(bullResult.confidence >= 0.78, `Bullish confidence meets threshold (${bullResult.confidence})`);
  assert(bullResult.stopLoss < bullResult.price, 'Stop Loss is below entry price for LONG');
  assert(bullResult.targets.tp1 > bullResult.price, 'TP1 is above entry price for LONG');
  assert(bullResult.targets.tp3 > bullResult.targets.tp2, 'Multi-target ATR expansion ascending (TP3 > TP2 > TP1)');

  // Test 3: Generate mock candles (Bearish Trend)
  const bearishCandles = [];
  basePrice = 200;
  for (let i = 0; i < 30; i++) {
    basePrice -= (i * 0.5);
    bearishCandles.push({
      open: basePrice + 0.5,
      high: basePrice + 0.8,
      low: basePrice - 1.0,
      close: basePrice - 0.8,
      volume: 1000 + (i * 100),
      timestamp: Date.now() - (30 - i) * 60000
    });
  }

  const bearResult = engine.evaluate('ETHUSDT', bearishCandles, 'CRYPTO');
  assert(bearResult.direction === 'SELL' || bearResult.action === 'SHORT', 'Bearish trend generates SELL/SHORT direction');
  assert(bearResult.confidence >= 0.78, `Bearish confidence meets threshold (${bearResult.confidence})`);
  assert(bearResult.stopLoss > bearResult.price, 'Stop Loss is above entry price for SHORT');
  assert(bearResult.targets.tp1 < bearResult.price, 'TP1 is below entry price for SHORT');

  // Test 4: Insufficient candle handling
  const shortCandles = bullishCandles.slice(0, 10);
  const shortResult = engine.evaluate('SOLUSDT', shortCandles, 'CRYPTO');
  assert(shortResult.hasSignal === false, 'Properly rejects signals with insufficient candle history (<20)');

  // Test 5: Test Webhook Endpoint on localhost:3004
  try {
    const webhookPayload = {
      secret: 'TRADING_BRAIN_AUTH_KEY',
      symbol: 'BTCUSDT',
      action: 'BUY',
      price: 79800.50,
      strategy: 'GainzAlgo_V2_Alpha',
      timeframe: '5m',
      sl: 78500.00,
      tp: 81500.00
    };

    const res = await fetch('http://localhost:3004/api/webhook/tradingview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload)
    });

    const data = await res.json();
    assert(res.status === 200 && data.success === true, `Webhook endpoint POST /api/webhook/tradingview responded 200 OK (${data.message})`);
  } catch (e) {
    assert(false, `Webhook endpoint failed: ${e.message}`);
  }

  console.log('\n================================================================================');
  console.log(`📊 SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================================');

  if (failed > 0) process.exit(1);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
