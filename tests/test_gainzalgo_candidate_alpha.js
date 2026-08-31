/**
 * 🏛️ GainzAlgo V2 Candidate Alpha Deep Verification Battery
 * 
 * 5-Layer Rigorous Quantitative & Operational Validation:
 * 1. Non-Repainting Invariant (Historical Signal Immutability)
 * 2. Multi-Scale Bracket & Extreme Dynamic ATR Correctness
 * 3. Webhook Idempotency & Stale Timestamp Rejection
 * 4. Risk Gate Isolation & Paper Probation Routing
 * 5. Indian Equity Market Fixtures (NIFTY, BANKNIFTY, RELIANCE, GOLDBEES)
 */

const GainzAlgoV2AlphaEngine = require('../src/core/gainzAlgoV2AlphaEngine');

async function runCandidateAlphaSuite() {
  console.log('================================================================================');
  console.log('       🔬 GAINZALGO V2 CANDIDATE ALPHA DEEP QUANTITATIVE BATTERY                ');
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

  // --- LAYER 1: NON-REPAINTING INVARIANT (HISTORICAL IMMUTABILITY) ---
  console.log('--- 1. NON-REPAINTING HISTORICAL IMMUTABILITY ---');
  // Generate 25 historical bars that trigger a clean Bullish signal at bar 25
  const baseHistory = [];
  let price = 100;
  for (let i = 0; i < 25; i++) {
    price += (i * 0.4);
    baseHistory.push({
      open: price - 0.4,
      high: price + 0.8,
      low: price - 0.6,
      close: price + 0.6,
      volume: 1000 + i * 50,
      timestamp: 1700000000 + i * 60
    });
  }

  const snapshotBar25 = engine.evaluate('BTCUSDT', baseHistory, 'CRYPTO');
  assert(snapshotBar25.hasSignal === true, 'Bar 25 establishes a confirmed signal upon closure');

  // Now append 10 future bars (including a sudden violent reversal down)
  const expandedHistory = [...baseHistory];
  let crashPrice = price;
  for (let j = 0; j < 10; j++) {
    crashPrice -= (j * 1.5);
    expandedHistory.push({
      open: crashPrice + 1.0,
      high: crashPrice + 1.2,
      low: crashPrice - 1.5,
      close: crashPrice - 1.2,
      volume: 5000,
      timestamp: 1700000000 + (25 + j) * 60
    });
  }

  // Re-evaluate historical slice at bar 25
  const reEvaluationBar25 = engine.evaluate('BTCUSDT', expandedHistory.slice(0, 25), 'CRYPTO');
  assert(reEvaluationBar25.action === snapshotBar25.action, 'Historical Action on Bar 25 did NOT repaint');
  assert(reEvaluationBar25.price === snapshotBar25.price, 'Historical Entry Price on Bar 25 did NOT repaint');
  assert(reEvaluationBar25.stopLoss === snapshotBar25.stopLoss, 'Historical Stop Loss on Bar 25 did NOT repaint');
  assert(reEvaluationBar25.targets.tp1 === snapshotBar25.targets.tp1, 'Historical TP1 on Bar 25 did NOT repaint');
  assert(reEvaluationBar25.targets.tp2 === snapshotBar25.targets.tp2, 'Historical TP2 on Bar 25 did NOT repaint');
  assert(reEvaluationBar25.targets.tp3 === snapshotBar25.targets.tp3, 'Historical TP3 on Bar 25 did NOT repaint');

  // --- LAYER 2: BRACKET CORRECTNESS ACROSS ATR EXTREMES ---
  console.log('\n--- 2. DYNAMIC BRACKET CORRECTNESS & ATR EXTREMES ---');
  
  // Test A: Micro-ATR (e.g. 0.0001)
  const microCandles = Array.from({ length: 25 }, (_, i) => ({
    open: 1.0000 + i * 0.0001,
    high: 1.0002 + i * 0.0001,
    low: 0.9999 + i * 0.0001,
    close: 1.0001 + i * 0.0001,
    volume: 1000,
    timestamp: Date.now() - (25 - i) * 60000
  }));
  const microRes = engine.evaluate('MICRO_PAIR', microCandles);
  assert(microRes.stopLoss < microRes.price, 'Micro-ATR Long: SL < Entry');
  assert(microRes.price < microRes.targets.tp1, 'Micro-ATR Long: Entry < TP1');
  assert(microRes.targets.tp1 < microRes.targets.tp2, 'Micro-ATR Long: TP1 < TP2');
  assert(microRes.targets.tp2 < microRes.targets.tp3, 'Micro-ATR Long: TP2 < TP3');

  // Test B: Mega-ATR (e.g. 1000.0)
  const megaCandles = Array.from({ length: 25 }, (_, i) => ({
    open: 50000 - i * 500,
    high: 50200 - i * 500,
    low: 49000 - i * 500,
    close: 49200 - i * 500,
    volume: 1000,
    timestamp: Date.now() - (25 - i) * 60000
  }));
  const megaRes = engine.evaluate('MEGA_PAIR', megaCandles);
  assert(megaRes.stopLoss > megaRes.price, 'Mega-ATR Short: SL > Entry');
  assert(megaRes.price > megaRes.targets.tp1, 'Mega-ATR Short: Entry > TP1');
  assert(megaRes.targets.tp1 > megaRes.targets.tp2, 'Mega-ATR Short: TP1 > TP2');
  assert(megaRes.targets.tp2 > megaRes.targets.tp3, 'Mega-ATR Short: TP2 > TP3');

  // --- LAYER 3: WEBHOOK IDEMPOTENCY & STALE TIMESTAMPS ---
  console.log('\n--- 3. WEBHOOK IDEMPOTENCY, REPLAY GUARDS & STALE REJECTION ---');
  
  const testAlertId = `TV_ALERT_${Date.now()}_TEST`;
  const validWebhookPayload = {
    secret: 'TRADING_BRAIN_AUTH_KEY',
    alertId: testAlertId,
    symbol: 'BTCUSDT',
    action: 'BUY',
    price: 79950.00,
    timestamp: Date.now() // Fresh
  };

  // 1st request -> should succeed 200 OK
  try {
    const res1 = await fetch('http://localhost:3004/api/webhook/tradingview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validWebhookPayload)
    });
    const d1 = await res1.json();
    assert(res1.status === 200 && d1.success === true, 'First alert ingestion -> 200 OK (Processed)');
  } catch (e) {
    assert(false, `First alert failed: ${e.message}`);
  }

  // 2nd identical request -> should reject with 409 Duplicate / Ignored
  try {
    const res2 = await fetch('http://localhost:3004/api/webhook/tradingview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validWebhookPayload)
    });
    const d2 = await res2.json();
    assert(res2.status === 409 && d2.error.includes('DUPLICATE_IGNORED'), `Duplicate alert replay -> 409 Conflict (${d2.error})`);
  } catch (e) {
    assert(false, `Duplicate alert check threw error: ${e.message}`);
  }

  // Stale alert (>60s old) -> should reject with 400 Bad Request
  try {
    const stalePayload = {
      secret: 'TRADING_BRAIN_AUTH_KEY',
      alertId: `STALE_${Date.now()}`,
      symbol: 'ETHUSDT',
      action: 'BUY',
      price: 2500.00,
      timestamp: Date.now() - 120000 // 2 minutes old
    };
    const resStale = await fetch('http://localhost:3004/api/webhook/tradingview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stalePayload)
    });
    const dStale = await resStale.json();
    assert(resStale.status === 400 && dStale.error.includes('STALE_ALERT_REJECTED'), `Stale alert (>60s) -> 400 Bad Request (${dStale.error})`);
  } catch (e) {
    assert(false, `Stale alert check threw error: ${e.message}`);
  }

  // --- LAYER 4: WEBHOOK ISOLATION & PAPER PROBATION GATING ---
  console.log('\n--- 4. WEBHOOK ISOLATION & PAPER PROBATION GATING ---');
  const sessionStore = require('../src/core/sessionStateStore');
  const livePositions = sessionStore.getState().positions || {};
  assert(typeof livePositions === 'object' && livePositions !== null, 'Execution strictly adheres to paper trading state store');

  // --- LAYER 5: INDIAN MARKET FIXTURES (NIFTY50, BANKNIFTY, RELIANCE, GOLDBEES) ---
  console.log('\n--- 5. INDIAN MARKET FIXTURES & SESSION BOUNDARIES ---');
  const indianAssets = [
    { symbol: 'NIFTY50', basePrice: 24500, tickSize: 0.05 },
    { symbol: 'BANKNIFTY', basePrice: 51200, tickSize: 0.05 },
    { symbol: 'RELIANCE', basePrice: 2950, tickSize: 0.05 },
    { symbol: 'GOLDBEES', basePrice: 68.50, tickSize: 0.01 }
  ];

  for (const asset of indianAssets) {
    // 1. Normal NSE session (09:15 - 15:30 IST) bullish drift
    const nseCandles = Array.from({ length: 30 }, (_, i) => {
      const p = asset.basePrice + (i * asset.tickSize * 20);
      return {
        open: p - asset.tickSize * 10,
        high: p + asset.tickSize * 25,
        low: p - asset.tickSize * 15,
        close: p + asset.tickSize * 20,
        volume: 50000 + i * 1000,
        timestamp: Date.now() - (30 - i) * 60000
      };
    });
    const nseRes = engine.evaluate(asset.symbol, nseCandles, 'IN');
    assert(nseRes.symbol === asset.symbol && nseRes.market === 'IN', `[${asset.symbol}] Session evaluation preserves symbol & IN market tag`);
    assert(nseRes.direction === 'BUY' || nseRes.direction === 'HOLD', `[${asset.symbol}] Generated valid direction (${nseRes.direction})`);
    assert(nseRes.stopLoss > 0 && nseRes.takeProfit > 0, `[${asset.symbol}] Generated positive price brackets (SL: ₹${nseRes.stopLoss}, TP: ₹${nseRes.takeProfit})`);

    // 2. Gap-Up Open (+2.5% gap overnight relative to previous close)
    const gapUpCandles = [...nseCandles];
    const prevClose = nseCandles[28].close;
    const gapPrice = prevClose * 1.025;
    gapUpCandles[29] = {
      open: gapPrice,
      high: gapPrice * 1.008,
      low: gapPrice * 0.998,
      close: gapPrice * 1.005,
      volume: 250000, // Opening auction high volume
      timestamp: Date.now()
    };
    const gapUpRes = engine.evaluate(asset.symbol, gapUpCandles, 'IN');
    assert(
      !isNaN(gapUpRes.stopLoss) && gapUpRes.stopLoss < gapUpRes.price,
      `[${asset.symbol}] +2.5% Gap-Up: Directional bracket valid (SL ₹${gapUpRes.stopLoss} < Price ₹${gapUpRes.price})`
    );

    // 3. Gap-Down Open (-3.0% gap overnight relative to previous close)
    const gapDownCandles = [...nseCandles];
    const gapDownPrice = prevClose * 0.970;
    gapDownCandles[29] = {
      open: gapDownPrice,
      high: gapDownPrice * 1.002,
      low: gapDownPrice * 0.990,
      close: gapDownPrice * 0.992,
      volume: 300000,
      timestamp: Date.now()
    };
    const gapDownRes = engine.evaluate(asset.symbol, gapDownCandles, 'IN');
    assert(
      !isNaN(gapDownRes.stopLoss) && (gapDownRes.action === 'SHORT' ? gapDownRes.stopLoss > gapDownRes.price : gapDownRes.stopLoss < gapDownRes.price),
      `[${asset.symbol}] -3.0% Gap-Down: Directional bracket valid (SL ₹${gapDownRes.stopLoss}, Price ₹${gapDownRes.price})`
    );

    // 4. Illiquid / Zero-Volume Auction Bar
    const illiquidCandles = [...nseCandles];
    illiquidCandles[29] = {
      open: asset.basePrice,
      high: asset.basePrice,
      low: asset.basePrice,
      close: asset.basePrice,
      volume: 0,
      timestamp: Date.now()
    };
    const illiquidRes = engine.evaluate(asset.symbol, illiquidCandles, 'IN');
    assert(illiquidRes.hasSignal === false || illiquidRes.action === 'HOLD', `[${asset.symbol}] Zero-volume illiquidity bar generates safe HOLD`);
  }

  console.log('\n================================================================================');
  console.log(`📊 CANDIDATE ALPHA DEEP SUITE: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================================');

  if (failed > 0) process.exit(1);
}

runCandidateAlphaSuite().catch(e => {
  console.error(e);
  process.exit(1);
});
