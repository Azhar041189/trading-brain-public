const { createAgentLogger } = require('./logger');
const nvidiaCloudGateway = require('./nvidiaCloudGateway');
const logger = createAgentLogger('TreeOfThoughts');

/**
 * TreeOfThoughtsReasoning
 * Multi-branch Tree-of-Thoughts (ToT) macro reasoning engine that explores
 * 1st, 2nd, and 3rd-order ripple effects across global financial assets.
 */
class TreeOfThoughtsReasoning {
  constructor() {
    this.cache = new Map();
    this.activeTreeHistory = [];
  }

  async exploreRipples(catalyst, targetMarket = 'CRYPTO') {
    const cleanCatalyst = catalyst || 'Global macroeconomic liquidity expansion';
    const cacheKey = `${cleanCatalyst.slice(0, 50)}_${targetMarket}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    logger.info(`🌳 [Tree-of-Thoughts] Expanding 3-tier ripple tree for: "${cleanCatalyst.slice(0, 60)}..."`);

    const firstOrder = this.evaluateDirectImpact(cleanCatalyst);
    const secondOrder = this.evaluateTransmissionRipples(firstOrder);
    const thirdOrder = this.evaluateSectorShockwaves(secondOrder, targetMarket);

    const compositeScore = (firstOrder.score * 0.4) + (secondOrder.score * 0.35) + (thirdOrder.score * 0.25);
    const conviction = Math.min(98, Math.max(55, Math.round(Math.abs(compositeScore) * 100 + 40)));
    const recommendation = compositeScore > 0.25 ? 'STRONG_BULL_BIAS' : (compositeScore < -0.25 ? 'STRONG_BEAR_HEDGE' : 'DELTA_NEUTRAL');

    const treeResult = {
      timestamp: new Date().toISOString(),
      catalyst: cleanCatalyst,
      targetMarket,
      compositeScore: parseFloat(compositeScore.toFixed(3)),
      conviction,
      recommendation,
      tree: {
        root: cleanCatalyst,
        tier1_direct: firstOrder,
        tier2_transmission: secondOrder,
        tier3_sector_shockwave: thirdOrder
      },
      actionablePlaybook: this.generatePlaybook(recommendation, targetMarket, compositeScore)
    };

    this.cache.set(cacheKey, treeResult);
    this.activeTreeHistory.unshift(treeResult);
    if (this.activeTreeHistory.length > 20) this.activeTreeHistory.pop();

    return treeResult;
  }

  evaluateDirectImpact(catalyst) {
    const text = catalyst.toLowerCase();
    let score = 0;
    let rationale = 'Neutral baseline macro impact.';

    if (text.includes('rate cut') || text.includes('dovish') || text.includes('stimulus') || text.includes('liquidity injection') || text.includes('easing')) {
      score = 0.75;
      rationale = 'Monetary easing inflates risk asset valuations and boosts market liquidity.';
    } else if (text.includes('rate hike') || text.includes('hawkish') || text.includes('inflation surge') || text.includes('tightening')) {
      score = -0.70;
      rationale = 'Higher discount rates compress equity multiples and increase borrowing costs.';
    } else if (text.includes('war') || text.includes('conflict') || text.includes('tariff') || text.includes('sanction') || text.includes('embargo')) {
      score = -0.65;
      rationale = 'Geopolitical friction elevates supply chain risk and crude oil risk premia.';
    } else if (text.includes('record profit') || text.includes('earnings beat') || text.includes('guidance raised') || text.includes('breakthrough')) {
      score = 0.60;
      rationale = 'Corporate cashflow expansion fuels organic capital reinvestment.';
    } else if (text.includes('miss') || text.includes('guidance cut') || text.includes('layoff') || text.includes('investigation')) {
      score = -0.55;
      rationale = 'Demand contraction threatens forward earnings per share.';
    }

    return { tier: 1, name: 'Direct Asset Impact', score, rationale };
  }

  evaluateTransmissionRipples(firstOrder) {
    const directScore = firstOrder.score;
    let transmissionChannel = '';
    let transmissionScore = 0;

    if (directScore > 0) {
      transmissionChannel = 'Yield Curve Flattens ➔ DXY Weakens ➔ Capital Inflows to Emerging Markets & Crypto';
      transmissionScore = directScore * 0.85;
    } else if (directScore < 0) {
      transmissionChannel = 'DXY Spikes (Flight to Safety) ➔ Emerging Market FX Depreciates ➔ High-Beta Risk Off';
      transmissionScore = directScore * 0.90;
    } else {
      transmissionChannel = 'Range-bound volatility regimes across foreign exchange and sovereign yields.';
      transmissionScore = 0;
    }

    return {
      tier: 2,
      name: 'Cross-Market Transmission',
      channel: transmissionChannel,
      score: parseFloat(transmissionScore.toFixed(3)),
      channels: {
        fxDXY: directScore > 0 ? 'BEARISH_DXY' : 'BULLISH_DXY',
        bondsYield: directScore > 0 ? 'YIELDS_FALL' : 'YIELDS_SURGE',
        commodities: directScore > 0 ? 'METALS_OIL_RALLY' : 'DEMAND_DESTRUCTION'
      }
    };
  }

  evaluateSectorShockwaves(secondOrder, targetMarket) {
    const score = secondOrder.score;
    let shockwaveImpact = [];

    if (targetMarket === 'IN') {
      shockwaveImpact = [
        { sector: 'NIFTY IT', impact: score > 0 ? '+1.4% (US Tech spend tailwind)' : '-2.1% (Discretionary spend freeze)' },
        { sector: 'NIFTY BANK', impact: score > 0 ? '+1.8% (Credit growth expansion)' : '-1.2% (NIM pressure)' },
        { sector: 'NIFTY AUTO/OIL', impact: score > 0 ? '+0.9% (Domestic demand)' : '-1.8% (Import cost inflation)' }
      ];
    } else if (targetMarket === 'US') {
      shockwaveImpact = [
        { sector: 'Semiconductors (NVDA/TSM)', impact: score > 0 ? '+2.8% (Hyperscaler CapEx boost)' : '-3.2% (Valuation compression)' },
        { sector: 'Mega-Cap Cloud (MSFT/AMZN)', impact: score > 0 ? '+1.9% (Multiple expansion)' : '-2.0% (Discount rate headwind)' }
      ];
    } else {
      shockwaveImpact = [
        { sector: 'Layer-1 Digital Assets (BTC/ETH)', impact: score > 0 ? '+4.5% (Global M2 liquidity surge)' : '-4.8% (Macro deleveraging)' },
        { sector: 'DeFi & High-Beta Altcoins', impact: score > 0 ? '+7.2% (Risk-on rotation)' : '-8.5% (Liquidity drain)' }
      ];
    }

    return {
      tier: 3,
      name: 'Sector & Microstructure Shockwaves',
      score: parseFloat((score * 0.75).toFixed(3)),
      shockwaves: shockwaveImpact
    };
  }

  generatePlaybook(recommendation, market, score) {
    if (recommendation === 'STRONG_BULL_BIAS') {
      return {
        action: 'LONG_ACCELERATION',
        positionSizing: '1.25x (Conviction Scaling)',
        stopLossStrategy: 'Trailing ATR(1.5)',
        targetAssets: market === 'IN' ? ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS'] : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'NVDA']
      };
    } else if (recommendation === 'STRONG_BEAR_HEDGE') {
      return {
        action: 'DELTA_HEDGE_SHORT',
        positionSizing: '1.10x (Tactical Short / Protective Put)',
        stopLossStrategy: 'Tight Breakeven Lock (+0.5R)',
        targetAssets: market === 'IN' ? ['NIFTY_PUT', 'BANKNIFTY_PUT'] : ['BTCUSDT_SHORT', 'ETHUSDT_SHORT']
      };
    } else {
      return {
        action: 'MEAN_REVERSION_RANGE',
        positionSizing: '0.80x (Preserve Capital)',
        stopLossStrategy: 'Fixed Support/Resistance Bounds',
        targetAssets: ['PAIRS_SPREAD_ARBITRAGE']
      };
    }
  }

  getLatestTree() {
    return this.activeTreeHistory[0] || null;
  }
}

module.exports = new TreeOfThoughtsReasoning();
