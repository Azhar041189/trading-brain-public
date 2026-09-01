const axios = require('axios');
const config = require('../../config');
const { createAgentLogger } = require('../../core/logger');
const dhanClient = require('../../tools/dhanClient');

const logger = createAgentLogger('OptionsSignalAgent');

class OptionsSignalAgent {
  constructor() {
    this.name = 'options_flow';
    this.minConfidence = 0.6;
  }

  async generateSignals(marketData, preMarketBriefing) {
    const signals = [];
    
    try {
      // Get option chain data for Nifty and Bank Nifty
      const [niftyOC, bankNiftyOC] = await Promise.allSettled([
        this.fetchOptionChain('NIFTY'),
        this.fetchOptionChain('BANKNIFTY')
      ]);
      
      if (niftyOC.status === 'fulfilled' && niftyOC.value) {
        const niftySignals = this.analyzeOptionChain('NIFTY', niftyOC.value, preMarketBriefing);
        signals.push(...niftySignals);
      }
      
      if (bankNiftyOC.status === 'fulfilled' && bankNiftyOC.value) {
        const bnSignals = this.analyzeOptionChain('BANKNIFTY', bankNiftyOC.value, preMarketBriefing);
        signals.push(...bnSignals);
      }
      
      // Analyze individual stock options if available
      for (const [symbol, data] of Object.entries(marketData)) {
        if (data.segment === 'NSE_EQ' && data.optionable) {
          const stockOC = await this.fetchOptionChain(symbol).catch(() => null);
          if (stockOC) {
            const stockSignals = this.analyzeOptionChain(symbol, stockOC, preMarketBriefing);
            signals.push(...stockSignals);
          }
        }
      }
      
    } catch (error) {
      logger.error('Options signal generation failed', { error: error.message });
    }
    
    return this.filterAndRank(signals, preMarketBriefing);
  }

  async fetchOptionChain(symbol) {
    try {
      // Try DhanHQ first (requires data subscription)
      if (config.dhan.accessToken && config.dhan.accessToken !== 'your_self_token') {
        // Would need security ID mapping
        // For now, use NSE public API
      }
      
      // NSE requires cookies for option chain - use a cookie jar
      const url = symbol.includes('NIFTY') 
        ? `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`
        : `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol}`;
      
      // First get cookies from main page
      const cookieResponse = await axios.get('https://www.nseindia.com', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 10000
      });
      
      const cookies = cookieResponse.headers['set-cookie'] || [];
      const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');
      
      const response = await axios.get(url, { 
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://www.nseindia.com/',
          'Cookie': cookieHeader
        },
        timeout: 15000 
      });
      
      return response.data;
    } catch (error) {
      logger.warn(`Option chain fetch failed for ${symbol}`, { error: error.message });
      return null;
    }
  }

  analyzeOptionChain(symbol, data, preMarketBriefing) {
    const signals = [];
    
    if (!data?.records?.data) return signals;
    
    const records = data.records.data;
    const spot = data.records.underlyingValue;
    const expiryDates = data.records.expiryDates || [];
    const currentExpiry = expiryDates[0];
    
    if (!currentExpiry) return signals;
    
    // Filter for current expiry
    const currentExpiryData = records.filter(r => r.expiryDate === currentExpiry);
    
    // 1. PCR Analysis
    const pcrSignal = this.analyzePCR(symbol, currentExpiryData, spot, currentExpiry);
    if (pcrSignal) signals.push(pcrSignal);
    
    // 2. Max Pain Analysis
    const maxPainSignal = this.analyzeMaxPain(symbol, currentExpiryData, spot, currentExpiry);
    if (maxPainSignal) signals.push(maxPainSignal);
    
    // 3. OI Buildup Analysis
    const oiSignals = this.analyzeOIBuildup(symbol, currentExpiryData, spot, currentExpiry);
    signals.push(...oiSignals);
    
    // 4. IV Skew Analysis
    const ivSignal = this.analyzeIVSkew(symbol, currentExpiryData, spot, currentExpiry);
    if (ivSignal) signals.push(ivSignal);
    
    // 5. Straddle/Strangle Analysis
    const straddleSignal = this.analyzeStraddle(symbol, currentExpiryData, spot, currentExpiry);
    if (straddleSignal) signals.push(straddleSignal);
    
    // 6. Unusual Activity
    const unusualSignals = this.detectUnusualActivity(symbol, currentExpiryData, spot, currentExpiry);
    signals.push(...unusualSignals);
    
    return signals;
  }

  analyzePCR(symbol, data, spot, expiry) {
    let totalCEOI = 0, totalPEOI = 0;
    let atmCEOI = 0, atmPEOI = 0;
    const atmStrike = this.findATMStrike(data, spot);
    
    for (const item of data) {
      if (item.CE) totalCEOI += item.CE.openInterest || 0;
      if (item.PE) totalPEOI += item.PE.openInterest || 0;
      if (item.strikePrice === atmStrike) {
        atmCEOI = item.CE?.openInterest || 0;
        atmPEOI = item.PE?.openInterest || 0;
      }
    }
    
    const pcr = totalCEOI > 0 ? totalPEOI / totalCEOI : 0;
    const atmPCR = atmCEOI > 0 ? atmPEOI / atmCEOI : 0;
    
    let direction = null, strength = 0, reason = '';
    
    if (pcr > 1.4 && atmPCR > 1.2) {
      direction = 'LONG';
      strength = 0.75;
      reason = `High PCR: ${pcr.toFixed(2)} (ATM: ${atmPCR.toFixed(2)}). Put writers trapped, upside likely.`;
    } else if (pcr < 0.6 && atmPCR < 0.8) {
      direction = 'SHORT';
      strength = 0.75;
      reason = `Low PCR: ${pcr.toFixed(2)} (ATM: ${atmPCR.toFixed(2)}). Call writers trapped, downside likely.`;
    } else if (pcr > 1.2) {
      direction = 'LONG';
      strength = 0.55;
      reason = `Moderately bullish PCR: ${pcr.toFixed(2)}`;
    } else if (pcr < 0.8) {
      direction = 'SHORT';
      strength = 0.55;
      reason = `Moderately bearish PCR: ${pcr.toFixed(2)}`;
    }
    
    if (!direction) return null;
    
    return this.createOptionSignal(symbol, 'pcr_analysis', direction, spot, expiry, {
      pcr: pcr.toFixed(2),
      atmPCR: atmPCR.toFixed(2),
      totalCEOI: totalCEOI,
      totalPEOI: totalPEOI,
      strength,
      reason
    });
  }

  analyzeMaxPain(symbol, data, spot, expiry) {
    const strikes = [...new Set(data.map(r => r.strikePrice))].sort((a, b) => a - b);
    let minPain = Infinity, maxPainStrike = 0;
    
    for (const strike of strikes) {
      let pain = 0;
      for (const item of data) {
        if (item.CE && item.strikePrice < strike) {
          pain += (item.CE.openInterest || 0) * (strike - item.strikePrice);
        }
        if (item.PE && item.strikePrice > strike) {
          pain += (item.PE.openInterest || 0) * (item.strikePrice - strike);
        }
      }
      if (pain < minPain) {
        minPain = pain;
        maxPainStrike = strike;
      }
    }
    
    const distance = ((maxPainStrike - spot) / spot * 100);
    const distanceAbs = Math.abs(distance);
    
    if (distanceAbs < 1) return null; // Too close to spot
    
    const direction = distance > 0 ? 'LONG' : 'SHORT';
    const strength = Math.min(0.5 + distanceAbs * 0.1, 0.8);
    
    return this.createOptionSignal(symbol, 'max_pain', direction, spot, expiry, {
      maxPain: maxPainStrike,
      spot,
      distancePct: distance.toFixed(2),
      strength,
      reason: `Max pain at ${maxPainStrike} (${distance > 0 ? '+' : ''}${distance.toFixed(2)}% from spot). Magnet effect expected.`
    });
  }

  analyzeOIBuildup(symbol, data, spot, expiry) {
    const signals = [];
    
    for (const item of data) {
      const strike = item.strikePrice;
      const distance = Math.abs((strike - spot) / spot * 100);
      
      // Only analyze strikes within 5% of spot
      if (distance > 5) continue;
      
      const ceOI = item.CE?.openInterest || 0;
      const peOI = item.PE?.openInterest || 0;
      const ceOIChange = item.CE?.changeinOpenInterest || 0;
      const peOIChange = item.PE?.changeinOpenInterest || 0;
      const ceVol = item.CE?.totalTradedVolume || 0;
      const peVol = item.PE?.totalTradedVolume || 0;
      
      // Long buildup: CE OI increase + price up
      if (ceOIChange > 0 && ceVol > 1000) {
        signals.push(this.createOptionSignal(symbol, 'oi_long_buildup', 'LONG', spot, expiry, {
          strike,
          oiChange: ceOIChange,
          volume: ceVol,
          type: 'CE',
          strength: Math.min(0.4 + Math.abs(ceOIChange) / 100000, 0.7),
          reason: `CE Long buildup at ${strike}: OI +${ceOIChange}, Vol ${ceVol}`
        }));
      }
      
      // Short buildup: PE OI increase + price down
      if (peOIChange > 0 && peVol > 1000) {
        signals.push(this.createOptionSignal(symbol, 'oi_short_buildup', 'SHORT', spot, expiry, {
          strike,
          oiChange: peOIChange,
          volume: peVol,
          type: 'PE',
          strength: Math.min(0.4 + Math.abs(peOIChange) / 100000, 0.7),
          reason: `PE Short buildup at ${strike}: OI +${peOIChange}, Vol ${peVol}`
        }));
      }
      
      // Long unwinding: CE OI decrease
      if (ceOIChange < -5000 && ceVol > 500) {
        signals.push(this.createOptionSignal(symbol, 'oi_long_unwinding', 'SHORT', spot, expiry, {
          strike,
          oiChange: ceOIChange,
          volume: ceVol,
          type: 'CE',
          strength: 0.5,
          reason: `CE Long unwinding at ${strike}: OI ${ceOIChange}`
        }));
      }
      
      // Short covering: PE OI decrease
      if (peOIChange < -5000 && peVol > 500) {
        signals.push(this.createOptionSignal(symbol, 'oi_short_covering', 'LONG', spot, expiry, {
          strike,
          oiChange: peOIChange,
          volume: peVol,
          type: 'PE',
          strength: 0.5,
          reason: `PE Short covering at ${strike}: OI ${peOIChange}`
        }));
      }
    }
    
    return signals;
  }

  analyzeIVSkew(symbol, data, spot, expiry) {
    const atmStrike = this.findATMStrike(data, spot);
    const atmItem = data.find(r => r.strikePrice === atmStrike);
    
    if (!atmItem || !atmItem.CE || !atmItem.PE) return null;
    
    const ceIV = atmItem.CE.impliedVolatility || 0;
    const peIV = atmItem.PE.impliedVolatility || 0;
    const ivDiff = peIV - ceIV;
    const ivAvg = (ceIV + peIV) / 2;
    
    // Check skew across strikes
    let putSkew = 0, callSkew = 0;
    for (const item of data) {
      if (item.strikePrice < atmStrike && item.PE?.impliedVolatility) {
        putSkew += item.PE.impliedVolatility - ivAvg;
      }
      if (item.strikePrice > atmStrike && item.CE?.impliedVolatility) {
        callSkew += item.CE.impliedVolatility - ivAvg;
      }
    }
    
    let direction = null, strength = 0, reason = '';
    
    // Put skew high = downside protection demand = bearish sentiment
    if (putSkew > callSkew * 1.5 && ivDiff > 2) {
      direction = 'SHORT';
      strength = 0.6;
      reason = `Put skew elevated: PE IV ${peIV.toFixed(1)}% vs CE IV ${ceIV.toFixed(1)}%. Downside protection demand.`;
    } 
    // Call skew high = upside speculation = bullish sentiment
    else if (callSkew > putSkew * 1.5 && ivDiff < -2) {
      direction = 'LONG';
      strength = 0.6;
      reason = `Call skew elevated: CE IV ${ceIV.toFixed(1)}% vs PE IV ${peIV.toFixed(1)}%. Upside speculation.`;
    }
    
    if (!direction) return null;
    
    return this.createOptionSignal(symbol, 'iv_skew', direction, spot, expiry, {
      atmStrike,
      ceIV: ceIV.toFixed(1),
      peIV: peIV.toFixed(1),
      ivDiff: ivDiff.toFixed(1),
      putSkew: putSkew.toFixed(1),
      callSkew: callSkew.toFixed(1),
      strength,
      reason
    });
  }

  analyzeStraddle(symbol, data, spot, expiry) {
    const atmStrike = this.findATMStrike(data, spot);
    const atmItem = data.find(r => r.strikePrice === atmStrike);
    
    if (!atmItem || !atmItem.CE || !atmItem.PE) return null;
    
    const cePrice = atmItem.CE.lastPrice || 0;
    const pePrice = atmItem.PE.lastPrice || 0;
    const straddlePrice = cePrice + pePrice;
    const straddlePct = (straddlePrice / spot * 100);
    
    // Expected move = straddle price
    const expectedMove = straddlePrice;
    const expectedMovePct = straddlePct;
    
    // If straddle is cheap (low IV), expect breakout
    // If straddle is expensive (high IV), expect range
    const ivPercentile = this.estimateIVPercentile(atmItem.CE.impliedVolatility);
    
    let direction = null, strength = 0, reason = '';
    
    if (ivPercentile < 20 && straddlePct < 1.5) {
      // Low IV, cheap straddle - volatility expansion likely
      direction = 'LONG'; // Could be either way, but we'll use pre-market bias
      strength = 0.55;
      reason = `Cheap straddle: ${straddlePrice.toFixed(2)} (${straddlePct.toFixed(2)}%). IV percentile ${ivPercentile}%. Volatility expansion expected.`;
    } else if (ivPercentile > 80 && straddlePct > 3) {
      // High IV, expensive straddle - mean reversion
      direction = 'NEUTRAL';
      strength = 0.5;
      reason = `Expensive straddle: ${straddlePrice.toFixed(2)} (${straddlePct.toFixed(2)}%). IV percentile ${ivPercentile}%. Range-bound likely.`;
    }
    
    if (!direction) return null;
    
    return this.createOptionSignal(symbol, 'straddle_analysis', direction, spot, expiry, {
      atmStrike,
      straddlePrice: straddlePrice.toFixed(2),
      straddlePct: straddlePct.toFixed(2),
      expectedMove: expectedMove.toFixed(2),
      ivPercentile,
      strength,
      reason
    });
  }

  detectUnusualActivity(symbol, data, spot, expiry) {
    const signals = [];
    
    for (const item of data) {
      const ceOI = item.CE?.openInterest || 0;
      const peOI = item.PE?.openInterest || 0;
      const ceVol = item.CE?.totalTradedVolume || 0;
      const peVol = item.PE?.totalTradedVolume || 0;
      const ceOIChange = item.CE?.changeinOpenInterest || 0;
      const peOIChange = item.PE?.changeinOpenInterest || 0;
      
      // Unusual volume/OI ratio
      const ceVolOIRatio = ceOI > 0 ? ceVol / ceOI : 0;
      const peVolOIRatio = peOI > 0 ? peVol / peOI : 0;
      
      // High volume relative to OI = new positions
      if (ceVolOIRatio > 0.5 && ceVol > 5000) {
        signals.push(this.createOptionSignal(symbol, 'unusual_ce_volume', 'LONG', spot, expiry, {
          strike: item.strikePrice,
          volume: ceVol,
          oi: ceOI,
          volOIRatio: ceVolOIRatio.toFixed(2),
          strength: 0.65,
          reason: `Unusual CE activity at ${item.strikePrice}: Vol/OI ${ceVolOIRatio.toFixed(2)}`
        }));
      }
      
      if (peVolOIRatio > 0.5 && peVol > 5000) {
        signals.push(this.createOptionSignal(symbol, 'unusual_pe_volume', 'SHORT', spot, expiry, {
          strike: item.strikePrice,
          volume: peVol,
          oi: peOI,
          volOIRatio: peVolOIRatio.toFixed(2),
          strength: 0.65,
          reason: `Unusual PE activity at ${item.strikePrice}: Vol/OI ${peVolOIRatio.toFixed(2)}`
        }));
      }
      
      // Large single trade detection (if available)
      // Would need tick data or trade-by-trade data
    }
    
    return signals;
  }

  findATMStrike(data, spot) {
    const strikes = [...new Set(data.map(r => r.strikePrice))].sort((a, b) => a - b);
    return strikes.reduce((prev, curr) => 
      Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev
    );
  }

  estimateIVPercentile(currentIV) {
    // Simplified: would need historical IV data
    // For now, use rough thresholds
    if (currentIV < 12) return 10;
    if (currentIV < 15) return 25;
    if (currentIV < 18) return 50;
    if (currentIV < 22) return 75;
    return 90;
  }

  createOptionSignal(symbol, strategy, direction, spot, expiry, meta) {
    // For options, we'll create a signal that can be used to construct spreads
    const atr = spot * 0.01; // Approximate
    
    // Default stops/targets for directional option trades
    let stopLoss, takeProfit;
    if (direction === 'LONG') {
      stopLoss = spot * 0.985;
      takeProfit = spot * 1.02;
    } else if (direction === 'SHORT') {
      stopLoss = spot * 1.015;
      takeProfit = spot * 0.98;
    } else {
      stopLoss = spot * 0.99;
      takeProfit = spot * 1.01;
    }
    
    const riskReward = Math.abs(takeProfit - spot) / Math.abs(spot - stopLoss);
    
    return {
      symbol,
      strategy: `options_${strategy}`,
      direction: direction === 'NEUTRAL' ? 'LONG' : direction, // Map neutral to long for execution
      entryPrice: spot,
      stopLoss: parseFloat(stopLoss.toFixed(2)),
      takeProfit: parseFloat(takeProfit.toFixed(2)),
      riskReward: parseFloat(riskReward.toFixed(2)),
      confidence: meta.strength,
      reason: meta.reason,
      atr,
      expiry,
      optionMeta: meta,
      timestamp: new Date().toISOString()
    };
  }

  filterAndRank(signals, preMarketBriefing) {
    // Filter by confidence
    let filtered = signals.filter(s => s.confidence >= this.minConfidence);
    
    // Align with pre-market bias
    if (preMarketBriefing?.marketBias) {
      const bias = preMarketBriefing.marketBias.bias;
      const biasDirection = bias.includes('bullish') ? 'LONG' : bias.includes('bearish') ? 'SHORT' : null;
      
      if (biasDirection) {
        filtered = filtered.map(s => ({
          ...s,
          confidence: s.direction === biasDirection ? Math.min(s.confidence + 0.1, 1) : s.confidence * 0.7,
          alignedWithBias: s.direction === biasDirection
        }));
      }
    }
    
    // Sort by confidence
    filtered.sort((a, b) => b.confidence - a.confidence);
    
    // Max 2 option signals per symbol
    const symbolCounts = {};
    filtered = filtered.filter(s => {
      symbolCounts[s.symbol] = (symbolCounts[s.symbol] || 0) + 1;
      return symbolCounts[s.symbol] <= 2;
    });
    
    return filtered.slice(0, 6);
  }
}

module.exports = new OptionsSignalAgent();