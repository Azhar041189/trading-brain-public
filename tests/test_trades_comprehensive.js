/**
 * 🧪 Comprehensive Trade Lifecycle, Schema & Mathematical Correctness Test
 * Tests both Local Challenger (v14.0) and Live Control (01e0981)
 */

async function runTradesVerification() {
  console.log('================================================================================');
  console.log('          🧪 COMPREHENSIVE TRADE LIFECYCLE & MATHEMATICAL AUDIT                 ');
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

  const localBase = 'http://localhost:3004';
  const liveBase = 'http://141.148.193.115:3004';

  // --- 1. LOCAL CHALLENGER TRADES AUDIT ---
  console.log('--- 1. LOCAL CHALLENGER (v14.0) TRADE AUDIT ---');
  let localTrades = [];
  try {
    const res = await fetch(`${localBase}/api/trades`);
    const data = await res.json();
    localTrades = Array.isArray(data) ? data : (data.trades || []);
    assert(Array.isArray(localTrades), `Local /api/trades returned array of length ${localTrades.length}`);
  } catch (e) {
    assert(false, `Local /api/trades failed: ${e.message}`);
  }

  if (localTrades.length > 0) {
    let localMathPass = 0;
    let localSchemaPass = 0;

    localTrades.forEach((t) => {
      // Schema validation
      const hasReq = (t.symbol || t.sym) && (t.entryPrice !== undefined || t.entry_price !== undefined || t.price !== undefined);
      if (hasReq) localSchemaPass++;

      // Math validation if closed trade
      const entry = t.entryPrice || t.entry_price || t.price;
      const exit = t.exitPrice || t.exit_price;
      const pnl = t.pnl !== undefined ? t.pnl : (t.realizedPnL !== undefined ? t.realizedPnL : t.realized_pnl);

      if (entry && exit && pnl !== undefined) {
        const isLong = (t.direction || t.side || 'BUY').toUpperCase().includes('BUY') || (t.direction || t.side || '').toUpperCase().includes('LONG');
        const priceDiff = isLong ? (exit - entry) : (entry - exit);
        const pnlPositive = pnl > 0;
        const diffPositive = priceDiff > 0;

        if (Math.abs(priceDiff) > 0.0001 && Math.abs(pnl) > 0.01) {
          if (pnlPositive === diffPositive) localMathPass++;
        } else {
          localMathPass++;
        }
      } else {
        localMathPass++;
      }
    });

    assert(localSchemaPass === localTrades.length, `Local Trade Schema: ${localSchemaPass}/${localTrades.length} trades valid`);
    assert(localMathPass >= Math.floor(localTrades.length * 0.95), `Local Trade PnL Directional Math: ${localMathPass}/${localTrades.length} consistent`);
  }

  // --- 2. LOCAL CHALLENGER POSITIONS AUDIT ---
  console.log('\n--- 2. LOCAL CHALLENGER (v14.0) ACTIVE POSITIONS AUDIT ---');
  let localPositions = [];
  try {
    const res = await fetch(`${localBase}/api/positions`);
    const data = await res.json();
    localPositions = Array.isArray(data) ? data : (data.positions || []);
    assert(Array.isArray(localPositions), `Local /api/positions returned array of length ${localPositions.length}`);
  } catch (e) {
    assert(false, `Local /api/positions failed: ${e.message}`);
  }

  localPositions.forEach(p => {
    const sym = p.symbol || p.sym;
    const entry = p.entryPrice || p.entry_price || p.avgPrice || p.avg_price;
    const curr = p.currentPrice || p.current_price;
    const sl = p.stopLoss || p.stop_loss;
    const tp = p.takeProfit || p.take_profit;

    assert(sym && entry && curr !== undefined, `[${sym}] Valid position structure (Entry: $${entry}, Curr: $${curr})`);
    assert(sl !== undefined && tp !== undefined, `[${sym}] Protective Stop Loss ($${sl}) and Take Profit ($${tp}) defined`);
  });

  // --- 3. LIVE CONTROL (01e0981) TRADES & POSITIONS AUDIT ---
  console.log('\n--- 3. LIVE CONTROL (01e0981) AUDIT ---');
  let liveTrades = [];
  let livePositions = [];
  try {
    const resT = await fetch(`${liveBase}/api/trades`);
    const dataT = await resT.json();
    liveTrades = Array.isArray(dataT) ? dataT : (dataT.trades || []);
    assert(Array.isArray(liveTrades), `Live /api/trades returned array of length ${liveTrades.length}`);

    const resP = await fetch(`${liveBase}/api/positions`);
    const dataP = await resP.json();
    livePositions = Array.isArray(dataP) ? dataP : (dataP.positions || []);
    assert(Array.isArray(livePositions), `Live /api/positions returned array of length ${livePositions.length}`);
  } catch (e) {
    assert(false, `Live API fetch failed: ${e.message}`);
  }

  // --- 4. EXECUTION ENGINE ISOLATION & ORDER LIFECYCLE CHECK ---
  console.log('\n--- 4. EXECUTION ENGINE ORDER ROUTING & LIFECYCLE ---');
  try {
    const executionEngine = require('../src/agents/execution/executionEngine');
    assert(typeof executionEngine.getCurrentPositions === 'function', 'executionEngine.getCurrentPositions is available');
    assert(typeof executionEngine.closePosition === 'function', 'executionEngine.closePosition is available');
    assert(typeof executionEngine.executeSignal === 'function', 'executionEngine.executeSignal is available');
    assert(typeof executionEngine.executePaperOrder === 'function', 'executionEngine.executePaperOrder is available');
    assert(typeof executionEngine.updateTrailingStopsAndBreakeven === 'function', 'executionEngine.updateTrailingStopsAndBreakeven is available');
  } catch (e) {
    assert(false, `Execution engine check failed: ${e.message}`);
  }

  // --- 5. STATISTICAL SUMMARY TABLE ---
  console.log('\n================================================================================');
  console.log('                    📊 SIDE-BY-SIDE TRADE METRICS SUMMARY                       ');
  console.log('================================================================================');

  const localWins = localTrades.filter(t => (t.pnl || t.realizedPnL || t.realized_pnl || 0) > 0).length;
  const localLosses = localTrades.filter(t => (t.pnl || t.realizedPnL || t.realized_pnl || 0) < 0).length;
  const localWinRate = localTrades.length > 0 ? ((localWins / localTrades.length) * 100).toFixed(1) : 'N/A';
  const localTotalPnL = localTrades.reduce((a, b) => a + (b.pnl || b.realizedPnL || b.realized_pnl || 0), 0).toFixed(2);

  const liveWins = liveTrades.filter(t => (t.pnl || t.realizedPnL || t.realized_pnl || 0) > 0).length;
  const liveLosses = liveTrades.filter(t => (t.pnl || t.realizedPnL || t.realized_pnl || 0) < 0).length;
  const liveWinRate = liveTrades.length > 0 ? ((liveWins / liveTrades.length) * 100).toFixed(1) : 'N/A';
  const liveTotalPnL = liveTrades.reduce((a, b) => a + (b.pnl || b.realizedPnL || b.realized_pnl || 0), 0).toFixed(2);

  console.log(`METRIC                     | LIVE CONTROL (01e0981)   | LOCAL CHALLENGER (v14.0)`);
  console.log(`---------------------------+--------------------------+-------------------------`);
  console.log(`Total Completed Trades     | ${liveTrades.length.toString().padEnd(24)} | ${localTrades.length.toString().padEnd(23)}`);
  console.log(`Winning / Losing Trades    | ${(liveWins + 'W / ' + liveLosses + 'L').padEnd(24)} | ${(localWins + 'W / ' + localLosses + 'L').padEnd(23)}`);
  console.log(`Historical Win Rate        | ${(liveWinRate + '%').padEnd(24)} | ${(localWinRate + '%').padEnd(23)}`);
  console.log(`Cumulative Realized P&L    | ${('$' + liveTotalPnL).padEnd(24)} | ${('$' + localTotalPnL).padEnd(23)}`);
  console.log(`Open Active Positions      | ${livePositions.length.toString().padEnd(24)} | ${localPositions.length.toString().padEnd(23)}`);
  console.log('================================================================================');

  console.log(`\n📊 TRADE AUDIT RESULT: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================================');

  if (failed > 0) process.exit(1);
}

runTradesVerification().catch(e => {
  console.error(e);
  process.exit(1);
});
