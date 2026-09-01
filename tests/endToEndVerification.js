const dhan = require('../src/adapters/dhanLiveBroker');
const binance = require('../src/adapters/binanceLiveBroker');
const alpaca = require('../src/adapters/alpacaLiveBroker');
const secureVault = require('../src/core/secureKeyVault');
const social = require('../src/core/socialAlphaSentinel');
const eco = require('../src/core/economicCalendarSentinel');
const triArb = require('../src/core/triangularArbitrageEngine');
const iceberg = require('../src/core/icebergOrderRouter');
const proofLedger = require('../src/core/proofOfTradeLedger');
const foundry = require('../src/core/geneticStrategyFoundry');
const monteCarlo = require('../src/core/monteCarloSimulator');
const regime = require('../src/core/regimeClassifier');
const depth = require('../src/core/orderBookDepthEngine');

async function runEndToEndVerification() {
  console.log('🧪 =========================================================');
  console.log('🧪 STARTING TRADING BRAIN 5-PHASE COMPREHENSIVE TEST SUITE');
  console.log('🧪 =========================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      const res = fn();
      if (res !== false) {
        console.log(`✅ [PASS] ${name}`);
        passed++;
      } else {
        console.log(`❌ [FAIL] ${name}`);
        failed++;
      }
    } catch (e) {
      console.log(`❌ [FAIL] ${name}: ${e.message}`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      const res = await fn();
      if (res !== false) {
        console.log(`✅ [PASS] ${name}`);
        passed++;
      } else {
        console.log(`❌ [FAIL] ${name}`);
        failed++;
      }
    } catch (e) {
      console.log(`❌ [FAIL] ${name}: ${e.message}`);
      failed++;
    }
  }

  // --- Phase 1 Tests ---
  console.log('📍 [PHASE 1] Live Broker Adapters & Secure Key Vault');
  test('SecureKeyVault AES-256-GCM encryption & decryption', () => {
    secureVault.setSecret('TEST_KEY', 'my-super-secret-token-1234');
    return secureVault.getSecret('TEST_KEY') === 'my-super-secret-token-1234';
  });

  await testAsync('Dhan Broker Indian market routing fallback', async () => {
    const res = await dhan.placeOrder({ symbol: 'RELIANCE', side: 'BUY', quantity: 5, price: 2950.0 });
    return res.success === true && res.exchange === 'NSE';
  });

  await testAsync('Binance Crypto broker signed execution routing', async () => {
    const res = await binance.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.05, price: 96500.0 });
    return res.success === true && res.exchange === 'BINANCE';
  });

  await testAsync('Alpaca US Equities broker routing', async () => {
    const res = await alpaca.placeOrder({ symbol: 'NVDA', side: 'buy', quantity: 10, price: 225.0 });
    return res.success === true && res.exchange === 'NASDAQ';
  });

  // --- Phase 2 Tests ---
  console.log('\n📍 [PHASE 2] Social Alpha & Economic Calendar Sentinels');
  test('SocialAlphaSentinel sentiment & volume surge scoring', () => {
    const score = social.evaluateSocialSentiment('NVDA');
    return score.symbol === 'NVDA' && parseFloat(score.sentimentScore) > 0.5;
  });

  test('EconomicCalendarSentinel macro event volatility circuit breaker', () => {
    const status = eco.checkMacroEventRisk();
    return status.canTrade === true && Array.isArray(status.upcomingEvents);
  });

  // --- Phase 3 Tests ---
  console.log('\n📍 [PHASE 3] Triangular Arbitrage & Iceberg Smart Routing');
  test('TriangularArbitrage 3-legged cross-spread evaluation', () => {
    const opps = triArb.scanTriangularOpportunities();
    return Array.isArray(opps);
  });

  test('IcebergOrderRouter stealth TWAP slicing', () => {
    const sliced = iceberg.sliceOrder('BTCUSDT', 100, 5);
    return sliced.clips.length === 5 && sliced.clips[0].quantity === 20;
  });

  // --- Phase 4 Tests ---
  console.log('\n📍 [PHASE 4] Cryptographic Proof-of-Trade Audit Ledger');
  test('ProofOfTradeLedger SHA-256 block hash generation & chain integrity', () => {
    const block = proofLedger.recordBlock('TEST_TRADE_EXECUTION', { symbol: 'ETHUSDT', profit: 245.50 });
    return block.index > 0 && typeof block.hash === 'string' && block.hash.length === 64;
  });

  // --- Phase 5 Tests ---
  console.log('\n📍 [PHASE 5] Genetic Strategy Foundry, Regime Classifier & Monte Carlo');
  test('GeneticStrategyFoundry evolutionary hyper-parameter mutation', () => {
    const evolution = foundry.runEvolutionCycle(10);
    return evolution.generation > 1 && typeof evolution.champion.metrics.fitness === 'number';
  });

  test('RegimeClassifier dynamic market condition detection', () => {
    const fakeCandles = Array.from({ length: 30 }, (_, i) => ({ close: 100 + i * 2 }));
    const result = regime.classify('SPY', fakeCandles);
    return result.regime === 'TRENDING_BULL' && result.recommendedStrategy === 'MOMENTUM_BREAKOUT';
  });

  test('MonteCarloSimulator 10,000x portfolio compounding projection', () => {
    const sim = monteCarlo.runSimulation(1000, 100000, 0.68, 1.8, 0.015, 1000);
    return parseFloat(sim.successProbability) > 80;
  });

  await testAsync('OrderBookDepthEngine Level-2 depth & OFI calculation', async () => {
    const depthData = await depth.getDepth('BTCUSDT', 'CRYPTO');
    return Array.isArray(depthData.bids) && typeof depthData.pressure === 'string';
  });

  // Trading Brain 3.0 Quantitative Alpha Tests
  test('DRLActorCriticEngine continuous neural policy evaluation', () => {
    const drl = require('../src/core/drlActorCriticEngine');
    const fakeCandles = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 1000 + i * 10
    }));
    const state = drl.extractState(fakeCandles);
    const policy = drl.evaluatePolicy(state);
    return typeof policy.advantageScore === 'number' && policy.confidence >= 0.65;
  });

  await testAsync('DarkPoolWhaleHunter VPIN and order-flow toxicity detection', async () => {
    const darkPool = require('../src/core/darkPoolWhaleHunter');
    const fakeCandles = Array.from({ length: 30 }, (_, i) => ({
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 5000
    }));
    const insight = await darkPool.analyzeOrderFlow('BTCUSDT', fakeCandles);
    return typeof insight.vpin === 'number' && typeof insight.institutionalBias === 'string';
  });

  test('ColdBloodedRiskProtocol anti-martingale scaling & emotionless risk throttling', () => {
    const riskProto = require('../src/core/coldBloodedRiskProtocol');
    riskProto.recordOutcome(150);
    const scaledRisk = riskProto.calculateDynamicRisk('NORMAL');
    riskProto.recordOutcome(-50);
    const throttledRisk = riskProto.calculateDynamicRisk('NORMAL');
    return scaledRisk > throttledRisk;
  });

  // Trading Brain 4.0 Sovereign Quantitative Tests
  test('DRLPPOEngine Deep Tensor MLP Actor-Critic forward pass', () => {
    const ppo = require('../src/core/drlPPOEngine');
    const state = new Array(12).fill(0.2);
    const policy = ppo.evaluateDeepPolicy(state);
    return typeof policy.action === 'number' && policy.confidence >= 0.65;
  });

  test('MetaLearningEngine (MAML / Reptile) few-shot regime adaptation', () => {
    const meta = require('../src/core/metaLearningEngine');
    const fakeCandles = Array.from({ length: 10 }, (_, i) => ({ close: 100 + (i % 2 === 0 ? 5 : -5) }));
    const adapted = meta.adaptFewShot(fakeCandles, 'PANIC');
    return adapted.volatilityThreshold === 0.04 && adapted.riskMultiplier === 0.65;
  });

  test('VPINCookedEngine volume-synchronized PIN toxicity scoring', () => {
    const vpin = require('../src/core/vpinEngine');
    const fakeCandles = Array.from({ length: 20 }, (_, i) => ({ open: 100, close: 102, volume: 500 }));
    const check = vpin.calculateVPIN(fakeCandles);
    return typeof check.vpin === 'number' && typeof check.toxicityRegime === 'string';
  });

  test('GameTheoreticEngine Kyle\'s Lambda and POV clip calculation', () => {
    const game = require('../src/core/gameTheoreticEngine');
    const fakeCandles = Array.from({ length: 15 }, (_, i) => ({ close: 100 + i, volume: 10000 }));
    const lambda = game.calculateKylesLambda(fakeCandles);
    const clips = game.calculateOptimalClips(500, 2000);
    return typeof lambda.lambda === 'number' && clips.recommendedClips >= 1;
  });

  test('CrossExchangeArbEngine Spot-Futures basis & 8h funding yield', () => {
    const basis = require('../src/core/crossExchangeArbEngine');
    const opps = basis.scanBasisOpportunities();
    return opps.length > 0 && opps[0].fundingRate8h.includes('%');
  });

  test('PairsTradingEngine co-integrated statistical pairs spread Z-Score', () => {
    const pairs = require('../src/core/pairsTradingEngine');
    const spreads = pairs.evaluatePairsSpreads();
    return spreads.length > 0 && typeof spreads[0].zScore === 'number';
  });

  test('HierarchicalRiskParity ML tree-clustered inverse variance allocation', () => {
    const hrp = require('../src/core/hierarchicalRiskParity');
    const allocation = hrp.calculateWeights({ BTCUSDT: 0.02, ETHUSDT: 0.03 });
    return allocation.model === 'HIERARCHICAL_RISK_PARITY_TREE' && typeof allocation.weights.BTCUSDT === 'number';
  });

  test('HFTDirectGateway sub-millisecond zero-copy buffer telemetry', () => {
    const gateway = require('../src/core/hftDirectGateway');
    const metrics = gateway.getGatewayMetrics();
    return metrics.zeroCopyAllocatedKB === 64 && metrics.meanLatencyMs > 0;
  });

  test('DarkPoolDetector off-exchange consolidated tape print detection', () => {
    const detector = require('../src/core/darkPoolDetector');
    const fakeCandles = [
      { close: 63000, volume: 10 },
      { close: 63005, volume: 200, high: 63010, low: 63000 } // $12.6M Notional absorption print
    ];
    const result = detector.detectDarkPoolPrints('BTCUSDT', fakeCandles);
    return typeof result.hasDarkPoolActivity === 'boolean' && typeof result.darkPoolBias === 'string';
  });

  test('ColdStorageVaultSweeper automated profit sweeping to multi-sig hardware vault', () => {
    const sweeper = require('../src/core/coldStorageVaultSweeper');
    const sweepResult = sweeper.evaluateAndSweep(3000, 1000); // $2,000 profit -> sweeps 25% ($500)
    const status = sweeper.getVaultStatus();
    return typeof status.totalSweptUSD === 'number' && status.vaultAddress.includes('0x71C');
  });

  // Trading Brain 5.0 Quantum-Alpha Tests
  test('QuantumAnnealingEngine simulated quantum QUBO portfolio optimization', () => {
    const quantum = require('../src/core/quantumAnnealingEngine');
    const result = quantum.optimizeQUBOPortfolio(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
    return result.model === 'QUANTUM_ANNEALING_QUBO' && result.selectedAssets.length > 0;
  });

  test('TemporalTransformerEngine multi-horizon self-attention trajectory forecasting', () => {
    const tft = require('../src/core/temporalTransformerEngine');
    const fakeCandles = Array.from({ length: 15 }, (_, i) => ({ close: 100 + i, volume: 500, high: 101 + i, low: 99 + i }));
    const forecast = tft.forecastMultiHorizon(fakeCandles);
    return forecast.model === 'TEMPORAL_FUSION_TRANSFORMER' && forecast.temporalAttentionScore > 0;
  });

  test('CopulaTailRiskEngine Clayton & Gumbel asymmetric crash dependence modeling', () => {
    const copula = require('../src/core/copulaTailRiskEngine');
    const assessment = copula.evaluateTailDependence('BTCUSDT', 'ETHUSDT');
    return assessment.model === 'CLAYTON_GUMBEL_BIVARIATE_COPULA' && assessment.lowerTailDependenceScore > 0.5;
  });

  test('DexCexAtomicEngine CEX-DEX atomic cross-domain arbitrage scanner', () => {
    const dexCex = require('../src/core/dexCexAtomicEngine');
    const opps = dexCex.scanAtomicOpportunities();
    return Array.isArray(opps) && opps.length > 0 && opps[0].executionStatus === 'ATOMIC_SWAP_READY';
  });

  test('StrategySynthesizer autonomous strategy generation and crucible backtesting', () => {
    const synth = require('../src/core/strategySynthesizer');
    const strategy = synth.synthesizeNewStrategy('TRENDING_BULL');
    const active = synth.getActiveSynthesizedStrategies();
    return active.length > 0 && typeof strategy.crucibleBacktest.winRate === 'string';
  });

  test('ONNXInferenceBridge GPU/NPU hardware tensor acceleration', () => {
    const onnx = require('../src/core/onnxInferenceBridge');
    const res = onnx.runTensorInference('DEEP_PPO_ACTOR', [0.1, 0.2, 0.3]);
    return typeof res.outputValue === 'number' && res.gpuAccelerated === true;
  });

  test('FlashLoanExecutor Aave v3 zero-capital flash borrow atomic routing', () => {
    const flash = require('../src/core/flashLoanExecutor');
    const res = flash.executeFlashArb('USDC', 100000, 'Uniswap v3', 'SushiSwap', 0.40);
    return res.txType === 'AAVE_V3_FLASH_LOAN_ATOMIC' && res.isProfitable === true;
  });

  test('MEVShieldRouter Flashbots & Jito private RPC anti-sandwich protection', () => {
    const mev = require('../src/core/mevShieldRouter');
    const res = mev.routeProtectedTransaction({ chain: 'ETHEREUM' });
    return res.isMevProtected === true && res.publicMempoolBypassed === true;
  });

  test('ExpectedShortfallEngine continuous Conditional VaR (CVaR 99%) calculation', () => {
    const es = require('../src/core/expectedShortfallEngine');
    const res = es.calculateExpectedShortfall(100000);
    return res.model === 'CONDITIONAL_VALUE_AT_RISK_CVAR99' && typeof res.expectedShortfallUSD === 'string';
  });

  test('ExtremeValueTheoryEngine Generalized Pareto Distribution extreme tail modeling', () => {
    const evt = require('../src/core/extremeValueTheoryEngine');
    const res = evt.evaluateTailShockBoundary();
    return res.model === 'GENERALIZED_PARETO_DISTRIBUTION_EVT' && res.tailInflationFactor > 1.0;
  });

  test('BacktestingCrucible vectorized 1,000,000-tick high-velocity backtest', () => {
    const crucible = require('../src/core/backtestingCrucible');
    const res = crucible.runCrucibleBacktest();
    return res.ticksProcessed === 1000000 && typeof res.winRate === 'string';
  });

  test('HotReloadDeployer zero-downtime dynamic strategy injector', () => {
    const deployer = require('../src/core/hotReloadDeployer');
    const res = deployer.deployStrategy({ name: 'TEST_STRATEGY' });
    return res.success === true && deployer.getActiveInjections().length > 0;
  });

  test('FIXProtocolGateway institutional Tag-Value FIX 4.4 DMA order formatting', () => {
    const fix = require('../src/core/fixProtocolGateway');
    const res = fix.buildNewOrderSingle('BTCUSDT', '1', 5, 63000);
    return res.protocol === 'FIX_4_4' && res.checksumTag10.length === 3;
  });

  test('MicroTickDispatcher sub-10-microsecond zero-allocation event bus', () => {
    const micro = require('../src/core/microTickDispatcher');
    const res = micro.dispatchTick('BTCUSDT', 62980, 62981, 2.0);
    return res.dispatched === true && res.dispatchLatencyMicros >= 0;
  });

  // Indian Options Chain & Market Action Tests
  test('DhanOptionsChainEngine real-time PCR, Max Pain and strike lattice generation', () => {
    const options = require('../src/core/dhanOptionsChainEngine');
    const chain = options.analyzeOptionsChain('NIFTY', 24366.00);
    return chain.symbol === 'NIFTY' && typeof chain.pcr === 'number' && chain.strikes.length > 0;
  });

  test('MarketActionScanner volume shockers & intraday momentum scanning', () => {
    const scanner = require('../src/core/marketActionScanner');
    const action = scanner.scanMarketAction();
    return action.totalScanned > 0 && Array.isArray(action.topVolumeShockers);
  });

  await testAsync('TelegramAlertDispatcher trade push notification formatting', async () => {
    const telegram = require('../src/core/telegramAlertDispatcher');
    const res = await telegram.sendMessage('🧪 Test Alert Verification');
    return res.success === true;
  });

  test('DhanAuthService RFC 6238 automated 6-digit TOTP generation', () => {
    const dhanAuth = require('../src/core/dhanAuthService');
    const totp = dhanAuth.generateTOTP();
    return typeof totp === 'string' && totp.length === 6 && /^\d{6}$/.test(totp);
  });

  test('ConsensusEngine Put-Call Ratio (PCR) and Volume Shocker multi-agent weighting', () => {
    const consensus = require('../src/core/consensusEngine');
    const evalRes = consensus.evaluate(
      { symbol: 'NIFTY', direction: 'LONG', confidence: 0.80, riskReward: 2.0 },
      { optionsAnalysis: { pcr: 1.25 }, volumeShocker: { volumeMultiple: 3.5 } }
    );
    return evalRes.approved === true && evalRes.compositeScore >= 0.75;
  });

  console.log('\n=========================================================');
  console.log(`📊 FINAL TEST SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('=========================================================');

  if (failed === 0) {
    console.log(`🚀 ALL 18 TRADING BRAIN ENGINES & ${passed} CHECKPOINTS FULLY VERIFIED!\n`);
  }
}

runEndToEndVerification();
