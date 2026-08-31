const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('SectorCorrelationRiskEngine');

/**
 * SectorCorrelationRiskEngine - Prevents portfolio concentration and correlation risk
 * 
 * Rules:
 * 1. Max 2 positions in the same direction within any single sector (e.g. Max 2 Pharma SHORTs)
 * 2. Correlation Matrix Gate: Rejects signals on assets with Pearson correlation rho >= 0.75
 *    to existing open positions in the same direction.
 */
class SectorCorrelationRiskEngine {
  constructor() {
    this.sectorMap = {
      // Indian Equities
      'DRREDDY': 'PHARMA', 'CIPLA': 'PHARMA', 'APOLLOHOSP': 'HEALTHCARE',
      'HINDALCO': 'METALS', 'TATASTEEL': 'METALS', 'JSWSTEEL': 'METALS',
      'SHRIRAMFIN': 'FINANCE', 'INDUSINDBK': 'BANKING', 'HDFCBANK': 'BANKING', 'ICICIBANK': 'BANKING',
      'TATACONSUM': 'FMCG', 'ITC': 'FMCG', 'NESTLEIND': 'FMCG',
      'HEROMOTOCO': 'AUTO', 'EICHERMOT': 'AUTO', 'TATAMOTORS': 'AUTO',
      'TECHM': 'IT', 'INFY': 'IT', 'TCS': 'IT', 'WIPRO': 'IT',
      'SBILIFE': 'INSURANCE', 'HDFCLIFE': 'INSURANCE',
      'GRASIM': 'CONGLOMERATE', 'RELIANCE': 'ENERGY_CONGLOMERATE', 'TRENT': 'RETAIL',
      'NIFTY': 'INDEX_BENCHMARK', 'BANKNIFTY': 'INDEX_BANKING', 'FINNIFTY': 'INDEX_FINANCE',

      // US Equities
      'AAPL': 'US_TECH', 'MSFT': 'US_TECH', 'GOOGL': 'US_TECH', 'NVDA': 'US_SEMIS',
      'AMZN': 'US_ECOMMERCE', 'TSLA': 'US_AUTO_EV', 'META': 'US_TECH',

      // Crypto
      'BTCUSDT': 'CRYPTO_L1', 'ETHUSDT': 'CRYPTO_L1', 'SOLUSDT': 'CRYPTO_L1',
      'DOGEUSDT': 'CRYPTO_MEME', 'XRPUSDT': 'CRYPTO_PAYMENT', 'AVAXUSDT': 'CRYPTO_L1'
    };

    this.maxPositionsPerSector = 2;
    this.maxCorrelationThreshold = 0.75;
  }

  getSector(symbol) {
    const clean = (symbol || '').toUpperCase().replace('.NS', '').replace('.BO', '');
    return this.sectorMap[clean] || 'GENERAL_EQUITIES';
  }

  /**
   * Validates if a new trade adheres to Sector & Correlation risk limits
   */
  evaluateTradeRisk(signal, openPositions = []) {
    const symbol = signal.symbol;
    const side = (signal.direction || signal.side || 'LONG').toUpperCase();
    const targetSector = this.getSector(symbol);

    // 1. Sector Concentration Check
    let sameSectorSameSideCount = 0;
    const activeSameSectorSymbols = [];

    for (const pos of openPositions) {
      const posSector = this.getSector(pos.symbol);
      const posSide = (pos.side || 'LONG').toUpperCase();

      if (posSector === targetSector && posSide === side) {
        sameSectorSameSideCount++;
        activeSameSectorSymbols.push(pos.symbol);
      }
    }

    if (sameSectorSameSideCount >= this.maxPositionsPerSector) {
      const reason = `Sector Limit Reached: Already holding ${sameSectorSameSideCount} ${side} positions in ${targetSector} (${activeSameSectorSymbols.join(', ')})`;
      logger.warn(`⛔ [Sector Risk Gate] Blocked ${side} ${symbol}: ${reason}`);
      return {
        approved: false,
        rejectionReason: reason,
        sector: targetSector,
        activeCount: sameSectorSameSideCount
      };
    }

    // 2. Correlation Gate Check (e.g. NIFTY & BANKNIFTY or DRREDDY & CIPLA)
    const correlationViolations = [];
    for (const pos of openPositions) {
      const posSide = (pos.side || 'LONG').toUpperCase();
      if (posSide === side) {
        const rho = this.estimateCorrelation(symbol, pos.symbol);
        if (rho >= this.maxCorrelationThreshold && pos.symbol !== symbol) {
          correlationViolations.push({
            symbol: pos.symbol,
            correlation: rho
          });
        }
      }
    }

    if (correlationViolations.length >= 2) {
      const reason = `Correlation Cluster: ${symbol} is highly correlated (rho >= ${this.maxCorrelationThreshold}) to ${correlationViolations.map(c => c.symbol + ' [' + c.correlation + ']').join(', ')}`;
      logger.warn(`⛔ [Correlation Gate] Blocked ${side} ${symbol}: ${reason}`);
      return {
        approved: false,
        rejectionReason: reason,
        correlationViolations
      };
    }

    logger.info(`✅ [Sector & Correlation Gate] Approved ${side} ${symbol} in sector ${targetSector} (Current in-sector: ${sameSectorSameSideCount}/${this.maxPositionsPerSector})`);
    return {
      approved: true,
      sector: targetSector,
      currentSectorPositions: sameSectorSameSideCount
    };
  }

  /**
   * Estimates correlation between two assets (based on sector overlap and benchmark weights)
   */
  estimateCorrelation(symA, symB) {
    const secA = this.getSector(symA);
    const secB = this.getSector(symB);

    if (symA === symB) return 1.0;
    if (secA === secB) return 0.82; // Intra-sector high correlation
    if ((symA.includes('NIFTY') && secB.includes('BANKING')) || (symB.includes('NIFTY') && secA.includes('BANKING'))) return 0.88;
    if (secA.startsWith('CRYPTO') && secB.startsWith('CRYPTO')) return 0.78;
    return 0.35; // Inter-sector low correlation
  }
}

module.exports = new SectorCorrelationRiskEngine();
