const { satyAtrEngine } = require('../src/core/satyAtrEngine');

function runTest() {
  console.log('🧪 Testing Saty ATR Levels & Volatility Engine...');

  const prevClose = 24350;
  const currentPrice = 24460;
  const atr = 180;

  const result = satyAtrEngine.calculateLevels(prevClose, currentPrice, atr);

  if (!result) throw new Error('Failed to calculate levels');
  if (result.triggerCloud.longTrigger !== parseFloat((prevClose + 0.236 * atr).toFixed(2))) {
    throw new Error('Trigger cloud math mismatch');
  }
  if (result.targets.longMid !== parseFloat((prevClose + 0.618 * atr).toFixed(2))) {
    throw new Error('Golden ratio mid-target mismatch');
  }

  console.log(`✅ Prev Close: ${result.prevClose} | ATR: ${result.atr}`);
  console.log(`✅ Long Breakout Trigger: ${result.triggerCloud.longTrigger}`);
  console.log(`✅ 61.8% Golden Ratio Target: ${result.targets.longMid}`);
  console.log(`✅ 100% Full ATR Target: ${result.targets.longFullAtr}`);
  console.log(`✅ Range Utilization: ${result.rangeUtilizationPct}% (${result.activeZone})`);
  console.log('🎉 Saty ATR Engine Unit Test Passed (100% Invariant Compliant)');
}

runTest();
