/**
 * optionsMultiLegEngine.js - Institutional Multi-Leg Options Strategy Slicer & Margin Optimizer
 * Supports 2-leg and 4-leg institutional templates:
 * - Iron Condor (Delta-Neutral Strangle + Protective Wings)
 * - Bull Put Spread (Credit Spread)
 * - Bear Call Spread (Credit Spread)
 * - Bull Call Spread (Debit Spread)
 * - Long Straddle / Short Strangle
 */

class OptionsMultiLegEngine {
  constructor() {
    this.strategies = [
      'IRON_CONDOR',
      'BULL_PUT_SPREAD',
      'BEAR_CALL_SPREAD',
      'BULL_CALL_SPREAD',
      'LONG_STRADDLE',
      'SHORT_STRANGLE'
    ];
  }

  buildStrategy(type = 'IRON_CONDOR', spotPrice = 24000, atmStrike = 24000, step = 50, lotSize = 50, currency = '₹') {
    const spot = parseFloat(spotPrice) || 24000;
    const atm = parseFloat(atmStrike) || Math.round(spot / step) * step;

    let legs = [];
    let name = '';
    let outlook = '';

    switch ((type || 'IRON_CONDOR').toUpperCase()) {
      case 'IRON_CONDOR':
        name = 'Iron Condor (Delta-Neutral Non-Directional)';
        outlook = 'Range-bound / Low Volatility (Theta Decay Harvesting)';
        legs = [
          { leg: 1, type: 'PE', action: 'BUY', strike: atm - (2 * step), price: 15.5, qty: lotSize, delta: -0.12, iv: 14.2 },
          { leg: 2, type: 'PE', action: 'SELL', strike: atm - step, price: 42.0, qty: lotSize, delta: -0.30, iv: 13.8 },
          { leg: 3, type: 'CE', action: 'SELL', strike: atm + step, price: 45.0, qty: lotSize, delta: 0.30, iv: 13.6 },
          { leg: 4, type: 'CE', action: 'BUY', strike: atm + (2 * step), price: 18.0, qty: lotSize, delta: 0.12, iv: 14.0 }
        ];
        break;

      case 'BULL_PUT_SPREAD':
        name = 'Bull Put Credit Spread';
        outlook = 'Moderately Bullish / Neutral';
        legs = [
          { leg: 1, type: 'PE', action: 'BUY', strike: atm - (2 * step), price: 18.0, qty: lotSize, delta: -0.15, iv: 14.2 },
          { leg: 2, type: 'PE', action: 'SELL', strike: atm - step, price: 48.0, qty: lotSize, delta: -0.35, iv: 13.9 }
        ];
        break;

      case 'BEAR_CALL_SPREAD':
        name = 'Bear Call Credit Spread';
        outlook = 'Moderately Bearish / Neutral';
        legs = [
          { leg: 1, type: 'CE', action: 'SELL', strike: atm + step, price: 52.0, qty: lotSize, delta: 0.35, iv: 13.7 },
          { leg: 2, type: 'CE', action: 'BUY', strike: atm + (2 * step), price: 21.0, qty: lotSize, delta: 0.15, iv: 14.1 }
        ];
        break;

      case 'BULL_CALL_SPREAD':
        name = 'Bull Call Debit Spread';
        outlook = 'Aggressively Bullish';
        legs = [
          { leg: 1, type: 'CE', action: 'BUY', strike: atm, price: 110.0, qty: lotSize, delta: 0.52, iv: 13.5 },
          { leg: 2, type: 'CE', action: 'SELL', strike: atm + (2 * step), price: 38.0, qty: lotSize, delta: 0.22, iv: 13.9 }
        ];
        break;

      case 'LONG_STRADDLE':
        name = 'Long Straddle (Volatility Expansion)';
        outlook = 'High Volatility Breakout (Earnings / Macro Event)';
        legs = [
          { leg: 1, type: 'CE', action: 'BUY', strike: atm, price: 115.0, qty: lotSize, delta: 0.50, iv: 14.5 },
          { leg: 2, type: 'PE', action: 'BUY', strike: atm, price: 108.0, qty: lotSize, delta: -0.50, iv: 14.8 }
        ];
        break;

      case 'SHORT_STRANGLE':
      default:
        name = 'Short Strangle (High Probability Premium Capture)';
        outlook = 'Range-bound (Expecting Low Realized Volatility)';
        legs = [
          { leg: 1, type: 'PE', action: 'SELL', strike: atm - step, price: 45.0, qty: lotSize, delta: -0.28, iv: 14.1 },
          { leg: 2, type: 'CE', action: 'SELL', strike: atm + step, price: 48.0, qty: lotSize, delta: 0.28, iv: 13.9 }
        ];
        break;
    }

    let netPremiumPerShare = 0;
    legs.forEach(leg => {
      if (leg.action === 'SELL') {
        netPremiumPerShare += leg.price;
      } else {
        netPremiumPerShare -= leg.price;
      }
    });

    const isCredit = netPremiumPerShare > 0;
    const totalNetPremium = Math.abs(netPremiumPerShare * lotSize);

    const payoffCurve = [];
    const minPrice = spot - (4 * step);
    const maxPrice = spot + (4 * step);
    const numPoints = 25;
    const stepSize = (maxPrice - minPrice) / (numPoints - 1);

    let maxProfit = -Infinity;
    let maxLoss = Infinity;

    for (let i = 0; i < numPoints; i++) {
      const priceAtExpiry = minPrice + (i * stepSize);
      let pnl = 0;

      legs.forEach(leg => {
        let intrinsic = 0;
        if (leg.type === 'CE') {
          intrinsic = Math.max(0, priceAtExpiry - leg.strike);
        } else {
          intrinsic = Math.max(0, leg.strike - priceAtExpiry);
        }

        if (leg.action === 'BUY') {
          pnl += (intrinsic - leg.price) * lotSize;
        } else {
          pnl += (leg.price - intrinsic) * lotSize;
        }
      });

      if (pnl > maxProfit) maxProfit = pnl;
      if (pnl < maxLoss) maxLoss = pnl;

      payoffCurve.push({
        price: parseFloat(priceAtExpiry.toFixed(1)),
        pnl: parseFloat(pnl.toFixed(2))
      });
    }

    const nakedMarginReq = legs.filter(l => l.action === 'SELL').length * 120000;
    const hedgedMarginReq = Math.max(25000, (Math.abs(maxLoss) + 15000) * (legs.filter(l => l.action === 'SELL').length || 1));
    const marginReliefPct = nakedMarginReq > 0 ? (((nakedMarginReq - hedgedMarginReq) / nakedMarginReq) * 100).toFixed(0) : 0;

    const netDelta = legs.reduce((acc, l) => acc + (l.action === 'BUY' ? l.delta : -l.delta), 0);
    const netTheta = (isCredit ? (totalNetPremium * 0.08) : -(totalNetPremium * 0.08)).toFixed(2);

    return {
      success: true,
      strategyType: type,
      name,
      outlook,
      spotPrice: spot,
      currency,
      lotSize,
      legs,
      metrics: {
        isCredit,
        netPremium: parseFloat(totalNetPremium.toFixed(2)),
        netPremiumPerShare: parseFloat(Math.abs(netPremiumPerShare).toFixed(2)),
        maxProfit: parseFloat(maxProfit.toFixed(2)),
        maxLoss: isFinite(maxLoss) && maxLoss < -1000000 ? 'UNLIMITED' : parseFloat(Math.abs(maxLoss).toFixed(2)),
        riskReward: isFinite(maxLoss) && maxLoss !== 0 ? (maxProfit / Math.abs(maxLoss)).toFixed(2) : '1:N/A',
        nakedMarginReq,
        hedgedMarginReq,
        marginReliefPct: marginReliefPct + '% (Broker Hedge Relief Applied)',
        netDelta: parseFloat(netDelta.toFixed(3)),
        netThetaDaily: currency + netTheta
      },
      payoffCurve
    };
  }

  buildAtomicOrderPayload(strategyData) {
    return {
      orderType: 'ATOMIC_MULTI_LEG',
      strategy: strategyData.name,
      executionMode: 'DMA_ATOMIC_PARALLEL',
      legs: (strategyData.legs || []).map(leg => ({
        legId: leg.leg,
        symbol: leg.strike + '_' + leg.type,
        side: leg.action,
        quantity: leg.qty,
        limitPrice: leg.price,
        orderTag: 'TB_MULTILEG_OPTIMIZED'
      })),
      maxSlippageBps: 15,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new OptionsMultiLegEngine();
