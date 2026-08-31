const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('PreMarketGapScanner');

/**
 * PreMarketGapScanner - Detects >= 2.0% opening price gaps at 09:15 AM IST
 * Triggers high-probability mean-reversion gap-fill execution across Indian equities.
 */
class PreMarketGapScanner {
  constructor() {
    this.minGapThresholdPct = 1.80; // Minimum 1.8% opening gap
    this.monitoredUniverse = [
      'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK',
      'HEROMOTOCO', 'APOLLOHOSP', 'DRREDDY', 'TATACONSUM', 'CIPLA', 'SHRIRAMFIN',
      'HINDALCO', 'EICHERMOT', 'TECHM', 'HDFCLIFE', 'SBILIFE', 'GRASIM', 'INDUSINDBK'
    ];
    this.lastScanResults = [];
  }

  /**
   * Scans market candles for opening gap opportunities
   */
  scanGaps(universeData = {}) {
    const opportunities = [];

    for (const symbol of this.monitoredUniverse) {
      const candles = universeData[symbol] || [];
      if (candles.length < 2) continue;

      const todayOpen = candles[candles.length - 1].open;
      const prevClose = candles[candles.length - 2].close;
      const gapPct = ((todayOpen - prevClose) / prevClose) * 100;

      if (Math.abs(gapPct) >= this.minGapThresholdPct) {
        const isGapUp = gapPct > 0;
        const opp = {
          symbol,
          gapPct: parseFloat(gapPct.toFixed(2)),
          gapType: isGapUp ? 'GAP_UP_OVERBOUGHT' : 'GAP_DOWN_OVERSOLD',
          recommendedAction: isGapUp ? 'SHORT_FADE_GAP' : 'LONG_FILL_GAP',
          openingPrice: todayOpen,
          previousClose: prevClose,
          targetPrice: prevClose, // Gap fill target
          stopLoss: isGapUp ? todayOpen * 1.012 : todayOpen * 0.988,
          confidence: Math.min(0.88, 0.65 + Math.abs(gapPct) * 0.05),
          detectedAt: new Date().toISOString()
        };

        opportunities.push(opp);
        logger.info(`🚨 [Opening Gap Alert] ${symbol} gapped ${gapPct > 0 ? '+' : ''}${gapPct.toFixed(2)}% (Open: ₹${todayOpen} vs PrevClose: ₹${prevClose}) ➔ Action: ${opp.recommendedAction}`);
      }
    }

    this.lastScanResults = opportunities;
    return {
      success: true,
      timestamp: new Date().toISOString(),
      gapsFound: opportunities.length,
      opportunities
    };
  }

  getRecentGaps() {
    return this.lastScanResults;
  }
}

module.exports = new PreMarketGapScanner();
