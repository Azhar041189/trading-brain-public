const http = require('http');
const fs = require('fs');

console.log('================================================================================');
console.log('       🏛️ TRADING BRAIN 360° FULL-SPECTRUM INTEGRATION & API QA SUITE          ');
console.log('================================================================================\n');

let passed = 0;
let total = 0;
const errors = [];

function assert(condition, name, details = '') {
  total++;
  if (condition) {
    console.log(`✅ [CHECK ${total.toString().padStart(2, '0')}] PASS - ${name}`);
    passed++;
  } else {
    console.error(`❌ [CHECK ${total.toString().padStart(2, '0')}] FAIL - ${name} | ${details}`);
    errors.push({ name, details });
    process.exitCode = 1;
  }
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3004' + path, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = http.request('http://localhost:3004' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runFullSpectrumQA() {
  console.log('--- SECTION 1: CORE REST APIS & HEALTH SENTINELS ---');
  
  // 1. Health / Status
  const st = await getJson('/api/status?market=CRYPTO');
  assert(st.status === 200, 'GET /api/status returns HTTP 200 OK');
  assert(st.data.autonomousActive !== undefined, 'Status payload contains active trading state (autonomousActive: ' + st.data.autonomousActive + ')');

  // 2. Candles / Market Ingestion
  const cd = await getJson('/api/candles?symbol=BTCUSDT&interval=5m&market=CRYPTO');
  assert(cd.status === 200 && Array.isArray(cd.data.candles) && cd.data.candles.length > 0, 'GET /api/candles returns candlestick array');

  // 3. Trade History & Tearsheet
  const tr = await getJson('/api/trades');
  assert(tr.status === 200 && Array.isArray(tr.data), 'GET /api/trades returns historical trade logs');

  // 4. Signals & Consensus Feed
  const sig = await getJson('/api/signals');
  assert(sig.status === 200 && Array.isArray(sig.data), 'GET /api/signals returns active AI alpha signals');

  // 5. AI Hermes Debates
  const deb = await getJson('/api/debates');
  assert(deb.status === 200 && (Array.isArray(deb.data) || deb.data.debates !== undefined), 'GET /api/debates returns multi-agent debate consensus');

  console.log('\n--- SECTION 2: INSTITUTIONAL TRIO REST APIS ---');
  
  // 6. Options Multi-Leg Strategy Endpoint (Iron Condor)
  const optCondor = await getJson('/api/options/multileg/strategy?type=IRON_CONDOR&spotPrice=79304&currency=%24');
  assert(optCondor.status === 200 && optCondor.data.success === true, 'GET /api/options/multileg/strategy (Iron Condor)');
  assert(optCondor.data.legs.length === 4, 'Iron Condor contains 4 atomic legs');
  assert(optCondor.data.payoffCurve.length === 25, 'Payoff curve contains 25 calculated price points');
  assert(typeof optCondor.data.metrics.marginReliefPct === 'string', 'Broker margin relief calculated');

  // 7. Options Multi-Leg Strategy Endpoint (Bull Put Spread)
  const optSpread = await getJson('/api/options/multileg/strategy?type=BULL_PUT_SPREAD&spotPrice=24000&currency=%E2%82%B9');
  assert(optSpread.status === 200 && optSpread.data.legs.length === 2, 'GET /api/options/multileg/strategy (Bull Put Spread 2 legs)');

  // 8. Options Multi-Leg Atomic Execution Dispatch
  const optExec = await postJson('/api/options/multileg/execute', { name: 'IRON_CONDOR' });
  assert(optExec.status === 200 && optExec.data.success === true, 'POST /api/options/multileg/execute (Atomic Order Placed)');

  // 9. Visual Strategy Studio Backtest API
  const studioRes = await postJson('/api/strategy-studio/backtest', {
    strategy: {
      name: 'QA Full Spectrum Test Strategy',
      direction: 'LONG',
      entryConditions: [
        { indicator: 'RSI', operator: '<', threshold: 40 },
        { indicator: 'VOLUME_SPIKE', operator: '>', threshold: 1.1 }
      ],
      stopLossPct: 1.2,
      takeProfitPct: 2.8
    },
    candles: []
  });
  assert(studioRes.status === 200 && studioRes.data.success === true, 'POST /api/strategy-studio/backtest executes backtest');
  assert(typeof studioRes.data.winRate === 'string', 'Studio backtest returns Win Rate %');
  assert(typeof studioRes.data.profitFactor === 'string', 'Studio backtest returns Profit Factor');
  assert(typeof studioRes.data.totalPnlPct === 'string', 'Studio backtest returns Total PnL %');

  // 10. L3 Microstructure Depth Replay Snapshot
  const l3Snap = await getJson('/api/l3-depth/snapshot?symbol=BTCUSDT&midPrice=79304');
  assert(l3Snap.status === 200 && l3Snap.data.success === true, 'GET /api/l3-depth/snapshot returns 15-level reconstructed book');
  assert(l3Snap.data.bids.length === 15 && l3Snap.data.asks.length === 15, 'L3 Depth snapshot has 15 bid/ask levels');
  assert(typeof l3Snap.data.microstructure.orderFlowImbalance === 'number', 'L3 Depth computes Order Flow Imbalance (OFI)');
  assert(typeof l3Snap.data.microstructure.vpinToxicity === 'number', 'L3 Depth computes VPIN Toxicity');

  // 11. L3 Microstructure Order Simulation
  const l3Sim = await postJson('/api/l3-depth/simulate-order', {
    side: 'BUY',
    limitPrice: 79304,
    quantity: 5
  });
  assert(l3Sim.status === 200 && l3Sim.data.success === true, 'POST /api/l3-depth/simulate-order estimates queue priority');
  assert(typeof l3Sim.data.fillProbabilityPct === 'string', 'L3 order simulation calculates Fill Probability %');
  assert(typeof l3Sim.data.estimatedTimeToFillMs === 'string', 'L3 order simulation calculates Time-to-Fill ms');

  console.log('\n--- SECTION 3: FRONTEND STATIC ASSETS & HTML INTEGRITY ---');
  
  // 12. index.html serving
  const indexHtml = fs.readFileSync('src/dashboard/public/index.html', 'utf8');
  assert(indexHtml.includes('tabContentStrategyStudio'), 'index.html contains tabContentStrategyStudio DOM node');
  assert(indexHtml.includes('tabContentOptions'), 'index.html contains tabContentOptions DOM node');
  assert(indexHtml.includes('tabContentOrderBook'), 'index.html contains tabContentOrderBook DOM node');
  assert(indexHtml.includes('runVisualStudioBacktest'), 'index.html contains runVisualStudioBacktest function');
  assert(indexHtml.includes('simulateL3Order'), 'index.html contains simulateL3Order function');
  assert(indexHtml.includes('executeAtomicMultiLeg'), 'index.html contains executeAtomicMultiLeg function');

  // 13. dashboard_improvements.js sync
  const improvJs = fs.readFileSync('src/dashboard/public/dashboard_improvements.js', 'utf8');
  assert(improvJs.includes("strategystudio: 'tabContentStrategyStudio'"), 'dashboard_improvements.js contains strategystudio in contentMap');
  assert(improvJs.includes('loadStrategyStudio'), 'dashboard_improvements.js triggers loadStrategyStudio data fetcher');

  // 14. Autonomous Mesh Integration
  const meshCode = fs.readFileSync('src/core/autonomousMesh.js', 'utf8');
  assert(meshCode.includes('visualStrategyEngine'), 'autonomousMesh.js integrates visualStrategyEngine');
  assert(meshCode.includes('optionsMultiLegEngine'), 'autonomousMesh.js integrates optionsMultiLegEngine');
  assert(meshCode.includes('l3Simulator') || meshCode.includes('l3DepthReplaySimulator'), 'autonomousMesh.js integrates l3 simulator');

  console.log('\n================================================================================');
  console.log(`                      📊 QA SCORECARD: ${passed}/${total} CHECKS PASSED                      `);
  console.log('================================================================================');
  
  if (passed === total) {
    console.log('🎉 FULL 360° SUITE PASSED WITH 100% GREEN (FRONTEND + BACKEND + APIS VERIFIED)!');
    process.exit(0);
  } else {
    console.error(`❌ QA FAILED: ${errors.length} failed checks.`);
    process.exit(1);
  }
}

runFullSpectrumQA().catch(e => {
  console.error('Fatal QA script error:', e);
  process.exit(1);
});
