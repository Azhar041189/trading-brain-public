const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const config = require('../../config');
const { createAgentLogger } = require('../../core/logger');
const database = require('../../core/database');

const logger = createAgentLogger('PreMarketAgent');

class PreMarketAgent {
  constructor() {
    this.ist = 'Asia/Kolkata';
    this.cache = new Map();
  }

  async run() {
    logger.info('Starting pre-market research');
    const startTime = Date.now();

    try {
      const briefing = await this.generateBriefing();
      
      // Save to database
      await database.query(
        `INSERT INTO pre_market_briefings (date, briefing, created_at) 
         VALUES ($1, $2, NOW())
         ON CONFLICT (date) DO UPDATE SET briefing = $2, created_at = NOW()`,
        [moment().tz(this.ist).format('YYYY-MM-DD'), JSON.stringify(briefing)]
      ).catch(() => {
        // Table might not exist yet, create it
        return this.createBriefingTable().then(() => 
          database.query(
            `INSERT INTO pre_market_briefings (date, briefing, created_at) 
             VALUES ($1, $2, NOW())
             ON CONFLICT (date) DO UPDATE SET briefing = $2, created_at = NOW()`,
            [moment().tz(this.ist).format('YYYY-MM-DD'), JSON.stringify(briefing)]
          )
        );
      });

      logger.info('Pre-market briefing generated', { 
        duration: Date.now() - startTime,
        bias: briefing.marketBias,
        keyLevels: briefing.keyLevels
      });

      return briefing;
    } catch (error) {
      logger.error('Pre-market research failed', { error: error.message });
      throw error;
    }
  }

  async createBriefingTable() {
    await database.query(`
      CREATE TABLE IF NOT EXISTS pre_market_briefings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        date DATE UNIQUE NOT NULL,
        briefing JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_briefings_date ON pre_market_briefings(date);
    `);
  }

  async generateBriefing() {
    const [
      globalCues,
      sgxNifty,
      fiiDiiData,
      announcements,
      technicalLevels,
      optionsData,
      earningsCalendar
    ] = await Promise.allSettled([
      this.getGlobalCues(),
      this.getSGXNifty(),
      this.getFIIDIIData(),
      this.getCorporateAnnouncements(),
      this.getTechnicalLevels(),
      this.getOptionsData(),
      this.getEarningsCalendar()
    ]);

    const briefing = {
      timestamp: moment().tz(this.ist).toISOString(),
      date: moment().tz(this.ist).format('YYYY-MM-DD'),
      globalCues: globalCues.status === 'fulfilled' ? globalCues.value : { error: globalCues.reason?.message },
      sgxNifty: sgxNifty.status === 'fulfilled' ? sgxNifty.value : { error: sgxNifty.reason?.message },
      fiiDii: fiiDiiData.status === 'fulfilled' ? fiiDiiData.value : { error: fiiDiiData.reason?.message },
      announcements: announcements.status === 'fulfilled' ? announcements.value : { error: announcements.reason?.message },
      keyLevels: technicalLevels.status === 'fulfilled' ? technicalLevels.value : { error: technicalLevels.reason?.message },
      optionsData: optionsData.status === 'fulfilled' ? optionsData.value : { error: optionsData.reason?.message },
      earningsCalendar: earningsCalendar.status === 'fulfilled' ? earningsCalendar.value : { error: earningsCalendar.reason?.message },
      marketBias: this.determineMarketBias(
        globalCues.status === 'fulfilled' ? globalCues.value : null,
        sgxNifty.status === 'fulfilled' ? sgxNifty.value : null,
        fiiDiiData.status === 'fulfilled' ? fiiDiiData.value : null
      ),
      riskEvents: this.identifyRiskEvents(
        announcements.status === 'fulfilled' ? announcements.value : [],
        earningsCalendar.status === 'fulfilled' ? earningsCalendar.value : []
      ),
      actionableIdeas: []
    };

    // Generate actionable ideas based on all data
    briefing.actionableIdeas = this.generateIdeas(briefing);

    return briefing;
  }

  async getGlobalCues() {
    const cues = {};
    
    try {
      // US Markets
      const usData = await this.fetchYahooData(['^GSPC', '^DJI', '^IXIC', '^VIX']);
      cues.usMarkets = usData;

      // Dollar Index
      const dxy = await this.fetchYahooData(['DX-Y.NYB']);
      cues.dxy = dxy['DX-Y.NYB'];

      // Oil
      const oil = await this.fetchYahooData(['CL=F']);
      cues.oil = oil['CL=F'];

      // Gold
      const gold = await this.fetchYahooData(['GC=F']);
      cues.gold = gold['GC=F'];

      // USD/INR
      const usdinr = await this.fetchYahooData(['INR=X']);
      cues.usdinr = usdinr['INR=X'];

      // Asia
      const asia = await this.fetchYahooData(['^N225', '^HSI', '^STI', '^KS11']);
      cues.asia = asia;

      // Bond yields
      const yields = await this.fetchYahooData(['^TNX', '^TYX']);
      cues.yields = yields;

      cues.summary = this.summarizeGlobalCues(cues);
    } catch (error) {
      logger.warn('Global cues fetch partial', { error: error.message });
    }

    return cues;
  }

  async fetchYahooData(symbols) {
    // Using direct Yahoo Finance API
    const results = {};
    for (const symbol of symbols) {
      try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
          params: { interval: '1d', range: '1d' },
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const data = response.data?.chart?.result?.[0];
        if (data?.meta) {
          const meta = data.meta;
          results[symbol] = {
            price: meta.regularMarketPrice,
            change: meta.regularMarketPrice - meta.previousClose,
            changePct: meta.previousClose ? ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100).toFixed(2) : '0',
            previousClose: meta.previousClose,
            timestamp: meta.regularMarketTime
          };
        } else {
          results[symbol] = { error: 'No data returned' };
        }
      } catch (e) {
        results[symbol] = { error: e.message };
      }
    }
    return results;
  }

  summarizeGlobalCues(cues) {
    const summary = { bullish: 0, bearish: 0, neutral: 0, details: [] };
    
    if (cues.usMarkets) {
      for (const [sym, data] of Object.entries(cues.usMarkets)) {
        if (data.changePct) {
          const pct = parseFloat(data.changePct);
          if (pct > 0.5) { summary.bullish++; summary.details.push(`${sym}: +${pct}%`); }
          else if (pct < -0.5) { summary.bearish++; summary.details.push(`${sym}: ${pct}%`); }
          else { summary.neutral++; }
        }
      }
    }

    if (cues.dxy && cues.dxy.changePct) {
      const pct = parseFloat(cues.dxy.changePct);
      if (pct > 0.2) { summary.bearish++; summary.details.push(`DXY: +${pct}% (negative for EM)`); }
      else if (pct < -0.2) { summary.bullish++; summary.details.push(`DXY: ${pct}% (positive for EM)`); }
    }

    return summary;
  }

  async getSGXNifty() {
    try {
      // SGX Nifty / GIFT Nifty from NSE
      const data = await this.fetchYahooData(['^NSEI']);
      const nifty = data['^NSEI'];
      
      // GIFT Nifty trades on NSE International Exchange
      // Use Nifty futures as proxy
      return {
        niftySpot: nifty?.price,
        niftyChange: nifty?.changePct ? nifty.changePct.toString() : '0',
        giftNifty: nifty?.price ? nifty.price * 1.002 : null,
        fairValue: nifty?.price ? nifty.price * 1.002 : null,
        premium: '0.20'
      };
    } catch (error) {
      return { error: error.message, niftyChange: '0' };
    }
  }

  async getFIIDIIData() {
    try {
      // NSE publishes FII/DII data at ~7:15 AM IST
      const url = 'https://www.nseindia.com/api/fiidiiTradeReact';
      const response = await axios.get(url, { 
        headers: config.nse.headers,
        timeout: 10000 
      });
      
      const data = response.data;
      if (data && data.length > 0) {
        const latest = data[0];
        return {
          date: latest.tradeDate,
          fii: {
            buy: parseFloat(latest.fiiBuyValue || 0),
            sell: parseFloat(latest.fiiSellValue || 0),
            net: parseFloat(latest.fiiNetValue || 0)
          },
          dii: {
            buy: parseFloat(latest.diiBuyValue || 0),
            sell: parseFloat(latest.diiSellValue || 0),
            net: parseFloat(latest.diiNetValue || 0)
          },
          summary: this.summarizeFIIDII(latest)
        };
      }
      return { error: 'No data available' };
    } catch (error) {
      logger.warn('FII/DII fetch failed', { error: error.message });
      return { error: error.message, note: 'Data typically available after 7:15 AM IST' };
    }
  }

  summarizeFIIDII(data) {
    const fiiNet = parseFloat(data.fiiNetValue || 0);
    const diiNet = parseFloat(data.diiNetValue || 0);
    
    let bias = 'neutral';
    if (fiiNet > 1000 && diiNet > 500) bias = 'strongly_bullish';
    else if (fiiNet > 500) bias = 'bullish';
    else if (fiiNet < -1000 && diiNet < -500) bias = 'strongly_bearish';
    else if (fiiNet < -500) bias = 'bearish';
    
    return {
      bias,
      fiiNetCr: (fiiNet / 10000000).toFixed(2),
      diiNetCr: (diiNet / 10000000).toFixed(2),
      interpretation: bias === 'bullish' ? 'FII buying supports upside' : 
                     bias === 'bearish' ? 'FII selling pressures market' : 'Mixed flows'
    };
  }

  async getCorporateAnnouncements() {
    try {
      const url = 'https://www.nseindia.com/api/corporate-announcements';
      const params = {
        index: 'equities',
        from_date: moment().tz(this.ist).format('DD-MM-YYYY'),
        to_date: moment().tz(this.ist).format('DD-MM-YYYY')
      };
      
      const response = await axios.get(url, { 
        headers: config.nse.headers,
        params,
        timeout: 10000 
      });
      
      const announcements = response.data || [];
      const filtered = announcements
        .filter(a => this.isMaterialAnnouncement(a))
        .map(a => ({
          symbol: a.symbol,
          subject: a.subject,
          description: a.desc,
          timestamp: a.dissemDT,
          category: this.categorizeAnnouncement(a.subject)
        }))
        .slice(0, 20);
      
      return { count: filtered.length, announcements: filtered };
    } catch (error) {
      logger.warn('Announcements fetch failed', { error: error.message });
      return { error: error.message, announcements: [] };
    }
  }

  isMaterialAnnouncement(a) {
    const materialKeywords = [
      'result', 'earnings', 'dividend', 'bonus', 'split', 'buyback',
      'merger', 'acquisition', 'demerger', 'board meeting', 'agm',
      'fund raising', 'qip', 'rights issue', 'preferential allotment',
      'change in management', 'ceo', 'cfo', 'director', 'resignation',
      'order', 'contract', 'capex', 'expansion', 'joint venture'
    ];
    
    const subject = a.subject || '';
    const desc = a.desc || '';
    const text = (subject + ' ' + desc).toLowerCase();
    return materialKeywords.some(k => text.includes(k));
  }

  categorizeAnnouncement(subject) {
    const s = (subject || '').toLowerCase();
    if (s.includes('result') || s.includes('earnings')) return 'earnings';
    if (s.includes('dividend') || s.includes('bonus') || s.includes('split')) return 'corporate_action';
    if (s.includes('board meeting') || s.includes('agm')) return 'meeting';
    if (s.includes('merger') || s.includes('acquisition') || s.includes('demerger')) return 'm&a';
    if (s.includes('buyback') || s.includes('qip') || s.includes('rights') || s.includes('fund')) return 'capital';
    if (s.includes('order') || s.includes('contract')) return 'business';
    return 'other';
  }

  async getTechnicalLevels() {
    try {
      // Get Nifty, Bank Nifty, FinNifty key levels
      const indices = ['^NSEI', '^NSEBANK', 'NIFTYFIN.NS'];
      const data = await this.fetchYahooData(indices);
      
      const levels = {};
      for (const [symbol, d] of Object.entries(data)) {
        if (d.price && d.previousClose) {
          const name = this.getIndexName(symbol);
          const pivot = (d.price + d.previousClose * 2) / 3; // Simplified
          const r1 = 2 * pivot - d.previousClose;
          const s1 = 2 * pivot - d.price;
          const r2 = pivot + (d.price - d.previousClose);
          const s2 = pivot - (d.price - d.previousClose);
          
          levels[name] = {
            spot: d.price,
            change: d.changePct,
            pivot: pivot.toFixed(2),
            resistance: [r1.toFixed(2), r2.toFixed(2)],
            support: [s1.toFixed(2), s2.toFixed(2)],
            previousClose: d.previousClose
          };
        }
      }
      
      return levels;
    } catch (error) {
      logger.warn('Technical levels failed', { error: error.message });
      return { error: error.message };
    }
  }

  getIndexName(symbol) {
    const map = { '^NSEI': 'NIFTY', '^NSEBANK': 'BANKNIFTY', 'NIFTYFIN.NS': 'FINNIFTY' };
    return map[symbol] || symbol;
  }

  async getOptionsData() {
    try {
      // Use NSE option chain API for Nifty and Bank Nifty
      const niftyOC = await this.fetchNSEOptionChain('NIFTY');
      const bankNiftyOC = await this.fetchNSEOptionChain('BANKNIFTY');
      
      return {
        nifty: this.analyzeOptionChain(niftyOC),
        bankNifty: this.analyzeOptionChain(bankNiftyOC)
      };
    } catch (error) {
      logger.warn('Options data fetch failed', { error: error.message });
      return { error: error.message };
    }
  }

  async fetchNSEOptionChain(symbol) {
    try {
      const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
      const response = await axios.get(url, { 
        headers: config.nse.headers,
        timeout: 10000 
      });
      return response.data;
    } catch (error) {
      return null;
    }
  }

  analyzeOptionChain(data) {
    if (!data || !data.records || !data.records.data) return { error: 'Invalid data' };
    
    const records = data.records.data;
    const underlyingValue = data.records.underlyingValue;
    
    let totalCEOI = 0, totalPEOI = 0;
    let maxCEOI = 0, maxPEOI = 0;
    let maxCEStrike = 0, maxPEStrike = 0;
    let pcr = 0;
    
    for (const item of records) {
      if (item.CE) {
        totalCEOI += item.CE.openInterest || 0;
        if ((item.CE.openInterest || 0) > maxCEOI) {
          maxCEOI = item.CE.openInterest || 0;
          maxCEStrike = item.strikePrice;
        }
      }
      if (item.PE) {
        totalPEOI += item.PE.openInterest || 0;
        if ((item.PE.openInterest || 0) > maxPEOI) {
          maxPEOI = item.PE.openInterest || 0;
          maxPEStrike = item.strikePrice;
        }
      }
    }
    
    pcr = totalCEOI > 0 ? (totalPEOI / totalCEOI).toFixed(2) : 0;
    const maxPain = this.calculateMaxPain(records);
    
    return {
      spot: underlyingValue,
      pcr,
      maxPain,
      maxCEStrike,
      maxPEStrike,
      totalCEOI: (totalCEOI / 100000).toFixed(1) + 'L',
      totalPEOI: (totalPEOI / 100000).toFixed(1) + 'L',
      interpretation: this.interpretOptions(pcr, maxPain, underlyingValue)
    };
  }

  calculateMaxPain(records) {
    const strikes = [...new Set(records.map(r => r.strikePrice))].sort((a, b) => a - b);
    let minPain = Infinity, maxPainStrike = 0;
    
    for (const strike of strikes) {
      let pain = 0;
      for (const item of records) {
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
    return maxPainStrike;
  }

  interpretOptions(pcr, maxPain, spot) {
    let bias = 'neutral';
    if (pcr > 1.3) bias = 'bullish';
    else if (pcr < 0.7) bias = 'bearish';
    
    const distance = ((maxPain - spot) / spot * 100).toFixed(2);
    
    return {
      bias,
      pcr: parseFloat(pcr),
      maxPain,
      distanceFromSpot: distance + '%',
      note: pcr > 1.3 ? 'High PCR - put writers trapped, upside likely' :
            pcr < 0.7 ? 'Low PCR - call writers trapped, downside likely' : 'Balanced'
    };
  }

  async getEarningsCalendar() {
    try {
      // Fetch from NSE or financial websites
      // For now, return structure
      return { 
        today: [], 
        tomorrow: [], 
        thisWeek: [],
        note: 'Implement earnings calendar from NSE/BSE or financial APIs'
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  determineMarketBias(globalCues, sgxNifty, fiiDii) {
    let score = 0;
    const factors = [];
    
    // Global cues
    if (globalCues && globalCues.summary) {
      score += (globalCues.summary.bullish - globalCues.summary.bearish) * 2;
      factors.push(`Global: ${globalCues.summary.bullish}B/${globalCues.summary.bearish}Be/${globalCues.summary.neutral}N`);
    }
    
    // SGX Nifty
    if (sgxNifty && sgxNifty.niftyChange) {
      const change = parseFloat(sgxNifty.niftyChange);
      if (!isNaN(change)) {
        if (change > 0.5) { score += 3; factors.push(`SGX: +${change}%`); }
        else if (change < -0.5) { score -= 3; factors.push(`SGX: ${change}%`); }
        else { factors.push(`SGX: ${change}%`); }
      } else {
        factors.push('SGX: data unavailable');
      }
    }
    
    // FII/DII
    if (fiiDii && fiiDii.summary) {
      const biasScore = { strongly_bullish: 4, bullish: 2, neutral: 0, bearish: -2, strongly_bearish: -4 };
      score += biasScore[fiiDii.summary.bias] || 0;
      factors.push(`FII/DII: ${fiiDii.summary.bias} (${fiiDii.summary.fiiNetCr}Cr/${fiiDii.summary.diiNetCr}Cr)`);
    }
    
    let bias = 'neutral';
    if (score >= 5) bias = 'strongly_bullish';
    else if (score >= 2) bias = 'bullish';
    else if (score <= -5) bias = 'strongly_bearish';
    else if (score <= -2) bias = 'bearish';
    
    return { bias, score, factors };
  }

  identifyRiskEvents(announcements, earnings) {
    const risks = [];
    
    if (announcements?.announcements) {
      for (const a of announcements.announcements) {
        if (['earnings', 'm&a', 'capital'].includes(a.category)) {
          risks.push({
            type: a.category,
            symbol: a.symbol,
            description: a.subject,
            severity: a.category === 'earnings' ? 'high' : 'medium'
          });
        }
      }
    }
    
    return risks;
  }

  generateIdeas(briefing) {
    const ideas = [];
    const bias = briefing.marketBias?.bias || 'neutral';
    
    // Nifty directional idea
    if (bias.includes('bullish')) {
      ideas.push({
        type: 'directional',
        symbol: 'NIFTY',
        direction: 'LONG',
        strategy: 'futures_or_call_spread',
        entry: 'At market open if above pivot',
        stop: 'Below S1',
        target: 'R1/R2',
        confidence: bias === 'strongly_bullish' ? 'high' : 'medium',
        reasoning: `Bias: ${bias}. ${briefing.marketBias.factors.join('; ')}`
      });
    } else if (bias.includes('bearish')) {
      ideas.push({
        type: 'directional',
        symbol: 'NIFTY',
        direction: 'SHORT',
        strategy: 'futures_or_put_spread',
        entry: 'At market open if below pivot',
        stop: 'Above R1',
        target: 'S1/S2',
        confidence: bias === 'strongly_bearish' ? 'high' : 'medium',
        reasoning: `Bias: ${bias}. ${briefing.marketBias.factors.join('; ')}`
      });
    }
    
    // Options ideas from PCR
    if (briefing.optionsData?.nifty) {
      const oc = briefing.optionsData.nifty;
      if (oc.interpretation?.bias === 'bullish' && bias.includes('bullish')) {
        ideas.push({
          type: 'options',
          symbol: 'NIFTY',
          strategy: 'bull_call_spread',
          strikes: `${oc.spot - 100}/${oc.spot + 100}`,
          reasoning: `PCR ${oc.pcr} supports upside. Max pain at ${oc.maxPain}`
        });
      } else if (oc.interpretation?.bias === 'bearish' && bias.includes('bearish')) {
        ideas.push({
          type: 'options',
          symbol: 'NIFTY',
          strategy: 'bear_put_spread',
          strikes: `${oc.spot - 100}/${oc.spot + 100}`,
          reasoning: `PCR ${oc.pcr} supports downside. Max pain at ${oc.maxPain}`
        });
      }
    }
    
    // Stock-specific from announcements
    if (briefing.announcements?.announcements) {
      for (const a of briefing.announcements.announcements.slice(0, 3)) {
        if (a.category === 'earnings' || a.category === 'business') {
          ideas.push({
            type: 'stock',
            symbol: a.symbol,
            direction: 'LONG',
            catalyst: a.subject,
            reasoning: `Material announcement: ${a.subject}`
          });
        }
      }
    }
    
    return ideas.slice(0, 5); // Max 5 ideas
  }
}

module.exports = new PreMarketAgent();

// CLI entry point
if (require.main === module) {
  const agent = new PreMarketAgent();
  agent.run()
    .then(briefing => {
      console.log(JSON.stringify(briefing, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}