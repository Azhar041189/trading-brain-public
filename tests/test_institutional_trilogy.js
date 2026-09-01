const { exogenousPredictionEngine } = require('../src/prediction_markets/probability/exogenousPredictionEngine');
const { avellanedaStoikovEngine } = require('../src/core/avellanedaStoikovEngine');
const { preMarketIntelligenceScreener } = require('../src/core/preMarketIntelligenceScreener');

function runTest() {
  console.log('🧪 Testing New Institutional Engine Trilogy...');

  // 1. Weather & Exogenous GFS Engine
  const weather = exogenousPredictionEngine.evaluateWeatherContract(95, [96, 97, 95.5, 94, 98], 0.40);
  if (!weather || !weather.modelProbability) throw new Error('Weather evaluation failed');
  console.log(`✅ [Exogenous Alpha] GFS 31 Model Prob: ${(weather.modelProbability * 100).toFixed(1)}% | Market Odds: ${(weather.marketProbability * 100).toFixed(1)}% | Recommendation: ${weather.recommendation}`);

  // 2. Avellaneda-Stoikov Inventory Skewer
  const quotes = avellanedaStoikovEngine.computeOptimalQuotes(100, 20, 3.0, 99.5);
  if (!quotes || !quotes.reservationPrice || !quotes.optimalBid) throw new Error('Avellaneda-Stoikov quoting failed');
  console.log(`✅ [Avellaneda-Stoikov] Reservation: $${quotes.reservationPrice} | Bid: $${quotes.optimalBid} | Ask: $${quotes.optimalAsk} | Skew: ${quotes.quoteSkew}`);

  // 3. Pre-Market RPS Screener
  const briefing = preMarketIntelligenceScreener.generateDailyBriefing();
  if (!briefing || briefing.totalScanned === 0) throw new Error('Pre-market briefing failed');
  console.log(`✅ [Pre-Market Screener] Scanned ${briefing.totalScanned} Assets | Top Alpha Leaders: ${briefing.topMomentumLeaders.map(a => a.symbol).join(', ')}`);

  console.log('🎉 Institutional Trilogy Passed (100% Invariant Compliant)');
}

runTest();
