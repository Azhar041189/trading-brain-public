const { RSI, BollingerBands, Stochastic, CCI, WilliamsR, ATR } = require('technicalindicators');
const config = require('../../config');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('MeanReversionSignalAgent');

class MeanReversionSignalAgent {
  constructor() {
    this.name = 'mean_reversion';
    this.minConfidence = 0.80; // High-conviction 80% confidence floor
  }

  async generateSignals(marketData, preMarketBriefing, marketKey = null) {
    // Top-Level Market Regime Guard: If overall market is in a sustained BEAR or CRASH regime, prevent long dip-buying
    let marketRegime = 'RANGING_CHOPPY';
    try {
      const regimeClassifier = require('../../core/regimeClassifier');
      marketRegime = marketKey ? regimeClassifier.getRegimeForMarket(marketKey) : regimeClassifier.getCurrentRegime();
      if (marketRegime === 'VOLATILE_CRASH') {
        logger.info(`🛡️ [MeanRev Guard] DISABLED in ${marketRegime} regime - Market crash halted`);
        return [];
      }
    } catch (e) {}

    const signals = [];
    const entries = marketData instanceof Map ? Array.from(marketData.entries()) : Object.entries(marketData);
    
    for (const [symbol, data] of entries) {
      if (!data.candles || data.candles.length < 20) continue;

      // Symbol-level regime gate
      let symbolRegime = marketRegime;
      try {
        const regimeClassifier = require('../../core/regimeClassifier');
        const reg = regimeClassifier.classify(symbol, data.candles);
        symbolRegime = reg.regime;
        if (symbolRegime === 'TRENDING_BEAR' || symbolRegime === 'VOLATILE_CRASH') {
          continue; // Skip symbol in bear regime
        }
      } catch (e) {}
      
      const candles = data.candles;
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const volumes = candles.map(c => c.volume);
      
      const currentPrice = closes[closes.length - 1];
      const currentVolume = volumes[volumes.length - 1];
      const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      
      // Calculate indicators
      const rsi = RSI.calculate({ period: 14, values: closes });
      const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
      const stoch = Stochastic.calculate({ 
        period: 14, 
        signalPeriod: 3,
        high: highs, 
        low: lows, 
        close: closes 
      });
      const cci = CCI.calculate({ period: 20, high: highs, low: lows, close: closes });
      const wr = WilliamsR.calculate({ period: 14, high: highs, low: lows, close: closes });
      const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
      
      const rawSignals = [];

      // Strategy 1: RSI Mean Reversion
      const rsiSignal = this.checkRSIReversion(rsi, bb, stoch, currentPrice, currentVolume, avgVolume);
      if (rsiSignal) rawSignals.push(this.createSignal(symbol, 'rsi_reversion', rsiSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 2: Bollinger Band Mean Reversion
      const bbSignal = this.checkBBReversion(bb, rsi, closes, currentVolume, avgVolume, stoch);
      if (bbSignal) rawSignals.push(this.createSignal(symbol, 'bb_reversion', bbSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 3: Stochastic Reversal
      const stochSignal = this.checkStochReversal(stoch, rsi, currentVolume, avgVolume);
      if (stochSignal) rawSignals.push(this.createSignal(symbol, 'stoch_reversal', stochSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 4: CCI Extreme Reversion
      const cciSignal = this.checkCCIReversion(cci, bb, currentVolume, avgVolume);
      if (cciSignal) rawSignals.push(this.createSignal(symbol, 'cci_reversion', cciSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 5: Williams %R Extreme
      const wrSignal = this.checkWRReversion(wr, rsi, currentVolume, avgVolume);
      if (wrSignal) rawSignals.push(this.createSignal(symbol, 'wr_reversion', wrSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 6: Gap Fill (overnight gaps)
      const gapSignal = this.checkGapFill(candles, currentVolume, avgVolume);
      if (gapSignal) rawSignals.push(this.createSignal(symbol, 'gap_fill', gapSignal, currentPrice, atr[atr.length - 1]));

      // Range Boundary Validation for RANGING_CHOPPY Regime
      const recentHighs = highs.slice(-20);
      const recentLows = lows.slice(-20);
      const rangeHigh = Math.max(...recentHighs);
      const rangeLow = Math.min(...recentLows);
      const currBB = bb && bb.length > 0 ? bb[bb.length - 1] : null;
      const currRSI = rsi && rsi.length > 0 ? rsi[rsi.length - 1] : 50;

      for (const sig of rawSignals) {
        // In RANGING_CHOPPY regime, strictly enforce Range Extreme boundaries
        if (marketRegime === 'RANGING_CHOPPY' || symbolRegime === 'RANGING_CHOPPY') {
          if (sig.direction === 'SHORT') {
            const isNearRangeHigh = currentPrice >= (rangeHigh * 0.99) || (currBB && currentPrice >= currBB.upper * 0.995);
            if (!isNearRangeHigh || currRSI < 55) {
              // Block mid-range shorts to prevent bleeding in slow upward drift
              continue;
            }
          } else if (sig.direction === 'LONG') {
            const isNearRangeLow = currentPrice <= (rangeLow * 1.01) || (currBB && currentPrice <= currBB.lower * 1.005);
            if (!isNearRangeLow || currRSI > 45) {
              // Block mid-range longs to prevent bleeding in slow downward drift
              continue;
            }
          }
        }

        // Apply TRENDING_BULL Regime Guard: Block counter-trend SHORTs and throttle LONG dip-buy confidence
        if (symbolRegime === 'TRENDING_BULL' || marketRegime === 'TRENDING_BULL') {
          if (sig.direction === 'SHORT') {
            logger.info(`🛡️ [MeanRev Bull Guard] Blocked counter-trend SHORT on ${symbol} in ${symbolRegime}`);
            continue; // Do NOT short an explosive bull market
          } else if (sig.direction === 'LONG') {
            // Dip-buying in bull is allowed with conservative confidence
            sig.confidence = Math.min(sig.confidence * 0.90, 0.75);
          }
        }
        signals.push(sig);
      }
    }
    
    return this.filterAndRank(signals, preMarketBriefing);
  }

  checkRSIReversion(rsi, bb, stoch, currentPrice, volume, avgVolume) {
    if (rsi.length < 2 || bb.length < 1) return null;
    
    const currRSI = rsi[rsi.length - 1];
    const prevRSI = rsi[rsi.length - 2];
    const currBB = bb[bb.length - 1];
    const currStoch = stoch ? stoch[stoch.length - 1] : null;
    const volumeOK = volume >= avgVolume * 0.9;
    
    // Oversold bounce
    if (prevRSI < 35 && currRSI > prevRSI && currRSI < 48) {
      const atBBLower = currBB && currentPrice < currBB.lower * 1.015;
      const stochOversold = currStoch && currStoch.k < 30;
      
      if ((atBBLower || stochOversold || currRSI < 32) && volumeOK) {
        return { 
          direction: 'LONG', 
          strength: 0.78, 
          reason: `RSI oversold bounce: ${prevRSI.toFixed(1)} → ${currRSI.toFixed(1)}${atBBLower ? ' at BB lower' : ''}${stochOversold ? ' + Stoch oversold' : ''}` 
        };
      }
    }
    
    // Overbought fade
    if (prevRSI > 65 && currRSI < prevRSI && currRSI > 52) {
      const atBBUpper = currBB && currentPrice > currBB.upper * 0.985;
      const stochOverbought = currStoch && currStoch.k > 70;
      
      if ((atBBUpper || stochOverbought || currRSI > 68) && volumeOK) {
        return { 
          direction: 'SHORT', 
          strength: 0.78, 
          reason: `RSI overbought fade: ${prevRSI.toFixed(1)} → ${currRSI.toFixed(1)}${atBBUpper ? ' at BB upper' : ''}${stochOverbought ? ' + Stoch overbought' : ''}` 
        };
      }
    }
    
    return null;
  }

  checkBBReversion(bb, rsi, closes, volume, avgVolume, stoch) {
    if (bb.length < 2 || rsi.length < 1) return null;
    
    const price = closes[closes.length - 1];
    const currBB = bb[bb.length - 1];
    const currRSI = rsi[rsi.length - 1];
    const currStoch = stoch ? stoch[stoch.length - 1] : null;
    const volumeOK = volume >= avgVolume * 0.9;
    
    // Oversold lower band touch with Stochastic or RSI confirmation
    if (price <= currBB.lower * 1.008 && currRSI <= 38 && (!currStoch || currStoch.k < 35) && volumeOK) {
      return { 
        direction: 'LONG', 
        strength: 0.85, 
        reason: `High-Conviction BB lower band bounce (${currBB.lower.toFixed(2)}) + RSI ${currRSI.toFixed(1)} + Stoch oversold` 
      };
    }
    
    // Overbought upper band fade with Stochastic or RSI confirmation
    if (price >= currBB.upper * 0.992 && currRSI >= 62 && (!currStoch || currStoch.k > 65) && volumeOK) {
      return { 
        direction: 'SHORT', 
        strength: 0.85, 
        reason: `High-Conviction BB upper band fade (${currBB.upper.toFixed(2)}) + RSI ${currRSI.toFixed(1)} + Stoch overbought` 
      };
    }
    
    return null;
  }

  checkStochReversal(stoch, rsi, volume, avgVolume) {
    if (stoch.length < 2 || rsi.length < 1) return null;
    
    const currK = stoch[stoch.length - 1].k;
    const prevK = stoch[stoch.length - 2].k;
    const currD = stoch[stoch.length - 1].d;
    const prevD = stoch[stoch.length - 2].d;
    const currRSI = rsi[rsi.length - 1];
    const volumeOK = volume >= avgVolume * 0.85;
    
    // Bullish stochastic crossover from oversold
    if (prevK < 30 && currK > prevK && prevK <= prevD && currK >= currD) {
      return { 
        direction: 'LONG', 
        strength: 0.76, 
        reason: `Stochastic bullish crossover from oversold (%K: ${prevK.toFixed(1)} ➔ ${currK.toFixed(1)})` 
      };
    }
    
    // Bearish stochastic crossover from overbought
    if (prevK > 70 && currK < prevK && prevK >= prevD && currK <= currD) {
      return { 
        direction: 'SHORT', 
        strength: 0.76, 
        reason: `Stochastic bearish crossover from overbought (%K: ${prevK.toFixed(1)} ➔ ${currK.toFixed(1)})` 
      };
    }
    
    return null;
  }

  checkCCIReversion(cci, bb, volume, avgVolume) {
    if (cci.length < 2 || bb.length < 1) return null;
    
    const currCCI = cci[cci.length - 1];
    const prevCCI = cci[cci.length - 2];
    const volumeOK = volume >= avgVolume * 0.85;
    
    // CCI extreme low
    if (prevCCI < -150 && currCCI > prevCCI && currCCI < -80 && volumeOK) {
      return { 
        direction: 'LONG', 
        strength: 0.75, 
        reason: `CCI extreme reversion (${prevCCI.toFixed(1)} ➔ ${currCCI.toFixed(1)})` 
      };
    }
    
    // CCI extreme high
    if (prevCCI > 150 && currCCI < prevCCI && currCCI > 80 && volumeOK) {
      return { 
        direction: 'SHORT', 
        strength: 0.75, 
        reason: `CCI extreme reversion: ${prevCCI.toFixed(1)} → ${currCCI.toFixed(1)}` 
      };
    }
    
    return null;
  }

  checkWRReversion(wr, rsi, volume, avgVolume) {
    if (wr.length < 2 || rsi.length < 1) return null;
    
    const currWR = wr[wr.length - 1];
    const prevWR = wr[wr.length - 2];
    const currRSI = rsi[rsi.length - 1];
    const volumeOK = volume >= avgVolume * 0.85;
    
    // Williams %R oversold bounce
    if (prevWR < -70 && currWR > prevWR && currWR < -35 && volumeOK) {
      return { 
        direction: 'LONG', 
        strength: 0.74, 
        reason: `Williams %R oversold bounce (${prevWR.toFixed(1)} ➔ ${currWR.toFixed(1)})` 
      };
    }
    
    // Williams %R overbought fade
    if (prevWR > -30 && currWR < prevWR && currWR > -65 && volumeOK) {
      return { 
        direction: 'SHORT', 
        strength: 0.74, 
        reason: `Williams %R overbought fade (${prevWR.toFixed(1)} ➔ ${currWR.toFixed(1)})` 
      };
    }
    
    return null;
  }

  checkGapFill(candles, volume, avgVolume) {
    if (candles.length < 2) return null;
    
    const prevClose = candles[candles.length - 2].close;
    const currOpen = candles[candles.length - 1].open;
    const currPrice = candles[candles.length - 1].close;
    const gapPct = ((currOpen - prevClose) / prevClose) * 100;
    const volumeOK = volume >= avgVolume * 1.1;
    
    // Gap up - look for fill
    if (gapPct > 0.5 && currPrice < currOpen && currPrice > prevClose && volumeOK) {
      const fillProgress = ((currOpen - currPrice) / (currOpen - prevClose) * 100).toFixed(0);
      return { 
        direction: 'SHORT', 
        strength: 0.78, 
        reason: `Gap up ${gapPct.toFixed(2)}% fill in progress (${fillProgress}%)` 
      };
    }
    
    // Gap down - look for fill
    if (gapPct < -0.5 && currPrice > currOpen && currPrice < prevClose && volumeOK) {
      const fillProgress = ((currPrice - currOpen) / (prevClose - currOpen) * 100).toFixed(0);
      return { 
        direction: 'LONG', 
        strength: 0.78, 
        reason: `Gap down ${gapPct.toFixed(2)}% fill in progress (${fillProgress}%)` 
      };
    }
    
    return null;
  }

  createSignal(symbol, strategy, signalData, price, atr) {
    const atrValue = atr || price * 0.01;
    const slMult = config.trading.defaultStopLossAtrMult * 0.7; // Tighter stop loss for mean reversion
    const tpMult = config.trading.defaultTakeProfitAtrMult * 0.8; // Mean reversion target
    
    let stopLoss, takeProfit;
    if (signalData.direction === 'LONG') {
      stopLoss = price - (atrValue * slMult);
      takeProfit = price + (atrValue * tpMult);
    } else {
      stopLoss = price + (atrValue * slMult);
      takeProfit = price - (atrValue * tpMult);
    }
    
    const riskReward = Math.abs(takeProfit - price) / Math.abs(price - stopLoss);
    
    return {
      symbol,
      strategy: `${this.name}_${strategy}`,
      direction: signalData.direction,
      entryPrice: price,
      stopLoss: parseFloat(stopLoss.toFixed(2)),
      takeProfit: parseFloat(takeProfit.toFixed(2)),
      riskReward: parseFloat(riskReward.toFixed(2)),
      confidence: signalData.strength,
      reason: signalData.reason,
      atr: atrValue,
      timestamp: new Date().toISOString()
    };
  }

  filterAndRank(signals, preMarketBriefing) {
    // Filter by minimum risk:reward (lower for mean reversion)
    let filtered = signals.filter(s => s.riskReward >= config.trading.minRiskReward * 0.7);
    
    // Filter by confidence
    filtered = signals.filter(s => s.confidence >= this.minConfidence);
    
    // Mean reversion works better in range-bound markets
    if (preMarketBriefing?.marketBias) {
      const bias = preMarketBriefing.marketBias.bias;
      if (bias === 'neutral') {
        filtered = filtered.map(s => ({ ...s, confidence: s.confidence * 1.1 }));
      } else {
        // Reduce confidence in trending markets
        filtered = filtered.map(s => ({ ...s, confidence: s.confidence * 0.85 }));
      }
    }
    
    // Sort by confidence * riskReward
    filtered.sort((a, b) => (b.confidence * b.riskReward) - (a.confidence * a.riskReward));
    
    // Max 2 signals per symbol
    const symbolCounts = {};
    filtered = filtered.filter(s => {
      symbolCounts[s.symbol] = (symbolCounts[s.symbol] || 0) + 1;
      return symbolCounts[s.symbol] <= 2;
    });
    
    return filtered.slice(0, 8);
  }
}

module.exports = new MeanReversionSignalAgent();