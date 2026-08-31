const { EMA, RSI, MACD, BollingerBands, ATR, ADX, Stochastic, VWAP } = require('technicalindicators');
const moment = require('moment-timezone');
const config = require('../../config');
const { createAgentLogger } = require('../../core/logger');
const database = require('../../core/database');
const dhanClient = require('../../tools/dhanClient');

const logger = createAgentLogger('MomentumSignalAgent');

class MomentumSignalAgent {
  constructor() {
    this.name = 'momentum';
    this.minConfidence = 0.80; // High-conviction 80% base confidence floor
  }

  async generateSignals(marketData, preMarketBriefing, marketKey = null) {
    const regimeClassifier = require('../../core/regimeClassifier');
    const marketRegime = marketKey 
      ? regimeClassifier.getRegimeForMarket(marketKey) 
      : regimeClassifier.getCurrentRegime();
    
    let signals = [];
    if (marketRegime === 'TRENDING_BEAR') {
      const shortSignals = this.generateShortTrendSignals(marketData, preMarketBriefing);
      if (shortSignals.length > 0) return shortSignals;
    } else if (marketRegime === 'TRENDING_BULL') {
      const longSignals = this.generateLongTrendSignals(marketData, preMarketBriefing);
      if (longSignals.length > 0) return longSignals;
    }

    const entries = marketData instanceof Map ? Array.from(marketData.entries()) : Object.entries(marketData);
    
    for (const [symbol, data] of entries) {
      if (!data.candles || data.candles.length < 20) continue;
      
      const symbolReg = regimeClassifier.classify(symbol, data.candles);
      
      // If the individual symbol is in a strong bull breakout, generate bullish momentum signal
      if (symbolReg.regime === 'TRENDING_BULL') {
        const singleMap = new Map([[symbol, data]]);
        const bullSig = this.generateLongTrendSignals(singleMap, preMarketBriefing);
        if (bullSig && bullSig.length > 0) signals.push(...bullSig);
        continue;
      }
      
      // If individual symbol is in a breakdown, generate short momentum signal
      if (symbolReg.regime === 'TRENDING_BEAR') {
        const singleMap = new Map([[symbol, data]]);
        const bearSig = this.generateShortTrendSignals(singleMap, preMarketBriefing);
        if (bearSig && bearSig.length > 0) signals.push(...bearSig);
        continue;
      }
      
      const candles = data.candles;
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const volumes = candles.map(c => c.volume);
      
      // Calculate indicators
      const ema9 = EMA.calculate({ period: 9, values: closes });
      const ema21 = EMA.calculate({ period: 21, values: closes });
      const ema50 = EMA.calculate({ period: 50, values: closes });
      const rsi = RSI.calculate({ period: 14, values: closes });
      const macd = MACD.calculate({ 
        values: closes, 
        fastPeriod: 12, 
        slowPeriod: 26, 
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
      });
      const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
      const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
      const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
      const stoch = Stochastic.calculate({ 
        period: 14, 
        signalPeriod: 3,
        high: highs, 
        low: lows, 
        close: closes 
      });
      
      const currentPrice = closes[closes.length - 1];
      const currentVolume = volumes[volumes.length - 1];
      const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      
      // Strategy 1: EMA Crossover + Volume
      const emaSignal = this.checkEMACrossover(ema9, ema21, ema50, currentVolume, avgVolume);
      if (emaSignal) signals.push(this.createSignal(symbol, 'ema_crossover', emaSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 2: VWAP Reclaim
      const vwapSignal = this.checkVWAPReclaim(candles, currentPrice, currentVolume, avgVolume);
      if (vwapSignal) signals.push(this.createSignal(symbol, 'vwap_reclaim', vwapSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 3: Bollinger Band Squeeze + Breakout
      const bbSignal = this.checkBBSqueeze(bb, closes, currentVolume, avgVolume);
      if (bbSignal) signals.push(this.createSignal(symbol, 'bb_squeeze', bbSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 4: RSI Momentum
      const rsiSignal = this.checkRSIMomentum(rsi, closes, macd);
      if (rsiSignal) signals.push(this.createSignal(symbol, 'rsi_momentum', rsiSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 5: MACD Trend
      const macdSignal = this.checkMACDTrend(macd, ema50);
      if (macdSignal) signals.push(this.createSignal(symbol, 'macd_trend', macdSignal, currentPrice, atr[atr.length - 1]));
      
      // Strategy 6: ADX Trend Strength
      const adxSignal = this.checkADXTrend(adx, ema9, ema21);
      if (adxSignal) signals.push(this.createSignal(symbol, 'adx_trend', adxSignal, currentPrice, atr[atr.length - 1]));
    }
    
    // Filter and rank signals
    return this.filterAndRank(signals, preMarketBriefing);
  }

  checkEMACrossover(ema9, ema21, ema50, volume, avgVolume) {
    if (ema9.length < 2 || ema21.length < 2) return null;
    
    const curr9 = ema9[ema9.length - 1];
    const curr21 = ema21[ema21.length - 1];
    const ema50Val = ema50.length > 0 ? ema50[ema50.length - 1] : curr21;
    
    const volumeSpike = volume >= avgVolume * 0.9;
    const above50 = curr9 >= ema50Val * 0.998;
    
    // Bullish trend alignment
    if (curr9 > curr21 && above50 && volumeSpike) {
      return { direction: 'LONG', strength: 0.8, reason: 'EMA 9/21 bullish momentum alignment' };
    }
    
    // Bearish trend alignment
    if (curr9 < curr21 && curr9 <= ema50Val * 1.002 && volumeSpike) {
      return { direction: 'SHORT', strength: 0.8, reason: 'EMA 9/21 bearish momentum alignment' };
    }
    
    return null;
  }

  checkVWAPReclaim(candles, price, volume, avgVolume) {
    // Calculate VWAP for current session
    let cumPV = 0, cumVol = 0;
    for (const c of candles) {
      const typical = (c.high + c.low + c.close) / 3;
      cumPV += typical * c.volume;
      cumVol += c.volume;
    }
    const vwap = cumPV / cumVol;
    
    const prevClose = candles[candles.length - 2].close;
    const volumeSpike = volume > avgVolume * 1.3;
    
    // Price was below VWAP, now reclaiming above with volume
    if (prevClose < vwap && price > vwap && volumeSpike && price > vwap * 1.002) {
      return { direction: 'LONG', strength: 0.75, reason: `VWAP reclaim at ${vwap.toFixed(2)} with volume` };
    }
    
    // Price was above VWAP, now breaking below with volume
    if (prevClose > vwap && price < vwap && volumeSpike && price < vwap * 0.998) {
      return { direction: 'SHORT', strength: 0.75, reason: `VWAP breakdown at ${vwap.toFixed(2)} with volume` };
    }
    
    return null;
  }

  checkBBSqueeze(bb, closes, volume, avgVolume) {
    if (bb.length < 20) return null;
    
    const currentBB = bb[bb.length - 1];
    const prevBB = bb[bb.length - 2];
    const price = closes[closes.length - 1];
    
    // Band width
    const bandwidth = (currentBB.upper - currentBB.lower) / currentBB.middle;
    const prevBandwidth = (prevBB.upper - prevBB.lower) / prevBB.middle;
    
    // Squeeze: bandwidth at 6-month low (simplified: check last 50)
    const isSqueeze = bandwidth < prevBandwidth && bandwidth < 0.05; // ~5% width
    
    if (!isSqueeze) return null;
    
    const volumeSpike = volume > avgVolume * 1.5;
    
    // Breakout above upper band
    if (price > currentBB.upper && volumeSpike) {
      return { direction: 'LONG', strength: 0.85, reason: `BB squeeze breakout above ${currentBB.upper.toFixed(2)}` };
    }
    
    // Breakdown below lower band
    if (price < currentBB.lower && volumeSpike) {
      return { direction: 'SHORT', strength: 0.85, reason: `BB squeeze breakdown below ${currentBB.lower.toFixed(2)}` };
    }
    
    return null;
  }

  checkRSIMomentum(rsi, closes, macd) {
    if (rsi.length < 2 || macd.length < 2) return null;
    
    const currRSI = rsi[rsi.length - 1];
    const prevRSI = rsi[rsi.length - 2];
    const currMACD = macd[macd.length - 1];
    const prevMACD = macd[macd.length - 2];
    
    // RSI momentum shift from oversold
    if (prevRSI < 35 && currRSI > 40 && currMACD.MACD > currMACD.signal) {
      return { direction: 'LONG', strength: 0.7, reason: `RSI momentum from oversold (${prevRSI.toFixed(1)} → ${currRSI.toFixed(1)}) with MACD bullish` };
    }
    
    // RSI momentum shift from overbought
    if (prevRSI > 65 && currRSI < 60 && currMACD.MACD < currMACD.signal) {
      return { direction: 'SHORT', strength: 0.7, reason: `RSI momentum from overbought (${prevRSI.toFixed(1)} → ${currRSI.toFixed(1)}) with MACD bearish` };
    }
    
    return null;
  }

  checkMACDTrend(macd, ema50) {
    if (macd.length < 3 || ema50.length < 1) return null;
    
    const curr = macd[macd.length - 1];
    const prev = macd[macd.length - 2];
    const prev2 = macd[macd.length - 3];
    const ema50Val = ema50[ema50.length - 1];
    
    // MACD bullish crossover with histogram expanding
    const histCurr = curr.MACD - curr.signal;
    const histPrev = prev.MACD - prev.signal;
    const histPrev2 = prev2.MACD - prev2.signal;
    
    if (histPrev <= 0 && histCurr > 0 && histCurr > histPrev && curr.MACD > ema50Val * 0.001) {
      return { direction: 'LONG', strength: 0.75, reason: 'MACD bullish crossover with expanding histogram' };
    }
    
    if (histPrev >= 0 && histCurr < 0 && histCurr < histPrev && curr.MACD < -ema50Val * 0.001) {
      return { direction: 'SHORT', strength: 0.75, reason: 'MACD bearish crossover with expanding histogram' };
    }
    
    return null;
  }

  checkADXTrend(adx, ema9, ema21) {
    if (adx.length < 1 || ema9.length < 1 || ema21.length < 1) return null;
    
    const currADX = adx[adx.length - 1];
    const currEMA9 = ema9[ema9.length - 1];
    const currEMA21 = ema21[ema21.length - 1];
    
    // Strong trend (ADX > 25) with EMA alignment
    if (currADX.adx > 25 && currEMA9 > currEMA21 && currADX.plusDI > currADX.minusDI) {
      return { direction: 'LONG', strength: 0.8, reason: `Strong uptrend: ADX ${currADX.adx.toFixed(1)}, +DI > -DI` };
    }
    
    if (currADX.adx > 25 && currEMA9 < currEMA21 && currADX.plusDI < currADX.minusDI) {
      return { direction: 'SHORT', strength: 0.8, reason: `Strong downtrend: ADX ${currADX.adx.toFixed(1)}, -DI > +DI` };
    }
    
    return null;
  }

  createSignal(symbol, strategy, signalData, price, atr) {
    const atrValue = atr || price * 0.01;
    const slMult = config.trading.defaultStopLossAtrMult;
    const tpMult = config.trading.defaultTakeProfitAtrMult;
    
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
    // Filter by minimum risk:reward
    let filtered = signals.filter(s => s.riskReward >= config.trading.minRiskReward);
    
    // Filter by confidence
    filtered = filtered.filter(s => s.confidence >= this.minConfidence);
    
    // Align with pre-market bias & market regime
    try {
      const regimeClassifier = require('../../core/regimeClassifier');
      filtered = filtered.map(s => {
        const reg = regimeClassifier.classify(s.symbol);
        if (reg.regime === 'TRENDING_BEAR' || reg.regime === 'VOLATILE_CRASH') {
          if (s.direction === 'SHORT') {
            s.confidence = Math.min(0.95, s.confidence * 1.25);
            s.riskReward = Math.max(2.5, s.riskReward);
            s.reason += ` | [${reg.regime} Alpha Short]`;
          } else {
            s.confidence *= 0.5; // Severely penalize longs in bear regimes
          }
        }
        return s;
      });
    } catch (e) {}

    if (preMarketBriefing?.marketBias) {
      const bias = preMarketBriefing.marketBias.bias;
      const biasDirection = bias.includes('bullish') ? 'LONG' : bias.includes('bearish') ? 'SHORT' : null;
      
      if (biasDirection) {
        // Boost signals aligned with bias
        filtered = filtered.map(s => ({
          ...s,
          confidence: s.direction === biasDirection ? Math.min(s.confidence + 0.1, 1) : s.confidence * 0.8,
          alignedWithBias: s.direction === biasDirection
        }));
      }
    }
    
    // Sort by confidence * riskReward
    filtered.sort((a, b) => (b.confidence * b.riskReward) - (a.confidence * a.riskReward));
    
    // Max 3 signals per symbol
    const symbolCounts = {};
    filtered = filtered.filter(s => {
      symbolCounts[s.symbol] = (symbolCounts[s.symbol] || 0) + 1;
      return symbolCounts[s.symbol] <= 3;
    });
    
    return filtered.slice(0, 10); // Max 10 total signals
  }

  generateShortTrendSignals(marketData, preMarketBriefing) {
    const signals = [];
    const entries = marketData instanceof Map ? Array.from(marketData.entries()) : Object.entries(marketData);

    for (const [symbol, data] of entries) {
      if (!data.candles || data.candles.length < 20) continue;
      const candles = data.candles;
      const closes = candles.map(c => c.close);
      const volumes = candles.map(c => c.volume);
      const currentPrice = closes[closes.length - 1];
      const prevPrice = closes[closes.length - 2];
      const currentVolume = volumes[volumes.length - 1] || 0;
      const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 || 1;

      // 1. Data Quality Gate: Require real volume activity and minimum > 0.2% candle volatility range
      const realVolumeBars = volumes.filter(v => v > 0).length;
      if (realVolumeBars < 5 && volumes.length >= 10) {
        // Reject synthetic or zero-liquidity feeds
        continue;
      }

      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const maxHigh = Math.max(...highs.slice(-20));
      const minLow = Math.min(...lows.slice(-20));
      const windowRangePct = (maxHigh - minLow) / currentPrice;
      if (windowRangePct < 0.002) {
        // Less than 0.2% intraday range indicates dead flat micro-chop
        continue;
      }

      // 2. Trend Persistence Check: 3+ of last 5 bars must be below EMA 21
      const ema21 = EMA.calculate({ period: 21, values: closes });
      if (ema21.length < 5) continue;
      const barsBelowEMA = closes.slice(-5).filter((c, i) => c < ema21[ema21.length - 5 + i]).length;
      if (barsBelowEMA < 2) continue; // Skip non-persistent setups

      // 3. Volume & Momentum Confirmation: Disallow low-volume exhaustion breakdowns
      const isVolumeConfirmed = currentVolume >= avgVolume * 0.9;

      // 3. Compute 14-period ATR
      let atrSum = 0;
      for (let i = candles.length - 14; i < candles.length; i++) {
        const c = candles[i];
        const prevC = candles[i - 1] ? candles[i - 1].close : c.open;
        atrSum += Math.max(c.high - c.low, Math.abs(c.high - prevC), Math.abs(c.low - prevC));
      }
      const atr = Math.max(atrSum / 14, currentPrice * 0.015);

      // 4. Institutional Wide Stop Buffer (3.5x ATR) to prevent whipsaw stop-outs in chop
      const stopLoss = parseFloat((currentPrice + (atr * 3.5)).toFixed(4));
      const takeProfit = parseFloat((currentPrice - (atr * 5.0)).toFixed(4));
      const riskReward = Math.abs(currentPrice - takeProfit) / Math.abs(stopLoss - currentPrice);

      signals.push({
        symbol,
        strategy: 'momentum_bear_breakdown_alpha',
        direction: 'SHORT',
        entryPrice: currentPrice,
        stopLoss,
        takeProfit,
        riskReward: parseFloat(riskReward.toFixed(2)),
        confidence: isVolumeConfirmed ? 0.88 : 0.75,
        reason: `Persistent Bear Trend (${barsBelowEMA}/5 bars < EMA21): Wide stop $${stopLoss} (3.5x ATR) + 5x ATR Target`,
        atr,
        timestamp: new Date().toISOString()
      });
    }

    return this.filterAndRank(signals, preMarketBriefing);
  }

  generateLongTrendSignals(marketData, preMarketBriefing) {
    const signals = [];
    const entries = marketData instanceof Map ? Array.from(marketData.entries()) : Object.entries(marketData);

    for (const [symbol, data] of entries) {
      if (!data.candles || data.candles.length < 20) continue;
      const candles = data.candles;
      const closes = candles.map(c => c.close);
      const currentPrice = closes[closes.length - 1];
      const atr = currentPrice * 0.012;

      signals.push({
        symbol,
        strategy: 'momentum_bull_breakout_alpha',
        direction: 'LONG',
        entryPrice: currentPrice,
        stopLoss: parseFloat((currentPrice - (atr * 1.0)).toFixed(4)),
        takeProfit: parseFloat((currentPrice + (atr * 2.5)).toFixed(4)),
        riskReward: 2.5,
        confidence: 0.85,
        reason: `Bull regime breakout momentum: Price advancing above SMA 20`,
        atr,
        timestamp: new Date().toISOString()
      });
    }

    return this.filterAndRank(signals, preMarketBriefing);
  }
}

module.exports = new MomentumSignalAgent();