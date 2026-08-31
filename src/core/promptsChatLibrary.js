const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('PromptsChatLibrary');

/**
 * PromptsChatLibrary — Live integration with prompts.chat community prompt library.
 * 
 * Provides:
 *  1. LRU Cache (50-prompt, 30-min TTL) to avoid rate limits
 *  2. Market-Aware Prompt Selection — auto-selects best prompt per market
 *  3. Variable Template Engine — fills ${var} with live system values
 *  4. Rate-Limit Retry — auto-retries with 30s backoff on 429
 *  5. Pre-loaded Best Prompt IDs for instant access
 *  6. Graceful Degradation — returns fallback if API unreachable
 */
class PromptsChatLibrary {
  constructor() {
    // LRU Cache: Map<cacheKey, { data, timestamp }>
    this.cache = new Map();
    this.MAX_CACHE = 50;
    this.CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

    // Stats tracking
    this.stats = { hits: 0, misses: 0, errors: 0, totalFetches: 0 };

    // Pre-discovered best prompt IDs from testing
    this.BEST_PROMPTS = {
      SIMMERDEEP_QUANT: 'cmr6eqhk4000cjv04upxiyx9i',
      SIGREX_KITCHEN_SINK: 'cmp1s3fhy0004js04p0er6i4y',
      SIGREX_RSI_MACD: 'cmp1hf04k000fjs04gd82p7bj',
      SIGREX_FEAR_GREED: 'cmp1s12gl0003kz04yp1l3rlk',
      SUPER_TRADER: 'cmjzruajn000al4047satebyb',
      CRYPTO_CONTRACT: 'cmjgpv55n0004lb04khmz8s9j',
      BIG_4_REPORT: 'cmlxzddh00006jx042xw25s0h',
      ALFA2_INSTITUTIONAL: 'cmr6d5ze9000gjx04xc4vwuvx',
      CRYPTO_OUTLOOK: 'cmjfs8fqm0001ky04upwuwdoj'
    };

    // Market → Best Prompt mapping
    this.MARKET_PROMPTS = {
      CRYPTO:   [this.BEST_PROMPTS.SIMMERDEEP_QUANT, this.BEST_PROMPTS.CRYPTO_CONTRACT, this.BEST_PROMPTS.CRYPTO_OUTLOOK],
      IN:       [this.BEST_PROMPTS.SUPER_TRADER, this.BEST_PROMPTS.BIG_4_REPORT],
      US:       [this.BEST_PROMPTS.BIG_4_REPORT, this.BEST_PROMPTS.ALFA2_INSTITUTIONAL, this.BEST_PROMPTS.SUPER_TRADER],
      FOREX:    [this.BEST_PROMPTS.SUPER_TRADER, this.BEST_PROMPTS.SIGREX_KITCHEN_SINK],
      FUTURES:  [this.BEST_PROMPTS.CRYPTO_CONTRACT, this.BEST_PROMPTS.SIGREX_RSI_MACD]
    };

    // Debate persona rotation index
    this.debatePersonaIndex = 0;
    this.DEBATE_PERSONAS = [
      this.BEST_PROMPTS.SIMMERDEEP_QUANT,
      this.BEST_PROMPTS.ALFA2_INSTITUTIONAL,
      this.BEST_PROMPTS.CRYPTO_OUTLOOK
    ];

    // Signal template IDs
    this.SIGNAL_TEMPLATES = [
      this.BEST_PROMPTS.SIGREX_KITCHEN_SINK,
      this.BEST_PROMPTS.SIGREX_RSI_MACD,
      this.BEST_PROMPTS.SIGREX_FEAR_GREED
    ];

    logger.info('📚 [PromptsChatLibrary] Initialized with 9 pre-loaded prompt IDs, 5-market mapping, LRU cache (50/30min)');
  }

  // ============ CACHE LAYER ============

  _cacheGet(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    this.stats.hits++;
    return entry.data;
  }

  _cacheSet(key, data) {
    if (this.cache.size >= this.MAX_CACHE) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  // ============ HTTP LAYER ============

  async searchPrompts(query) {
    const cacheKey = `search:${query}`;
    const cached = this._cacheGet(cacheKey);
    if (cached) return cached;

    this.stats.misses++;
    this.stats.totalFetches++;

    try {
      const response = await this._fetchWithRetry(
        `https://prompts.chat/api/prompts/search?q=${encodeURIComponent(query)}&limit=10`
      );
      const results = response.prompts || response || [];
      this._cacheSet(cacheKey, results);
      logger.info(`📚 [PromptsChatLibrary] Search "${query}" → ${results.length} results`);
      return results;
    } catch (err) {
      this.stats.errors++;
      logger.warn(`📚 [PromptsChatLibrary] Search failed for "${query}": ${err.message}`);
      return this._getFallbackSearchResults(query);
    }
  }

  async getPrompt(id) {
    const cacheKey = `prompt:${id}`;
    const cached = this._cacheGet(cacheKey);
    if (cached) return cached;

    this.stats.misses++;
    this.stats.totalFetches++;

    try {
      const response = await this._fetchWithRetry(
        `https://prompts.chat/api/prompts/${id}`
      );
      this._cacheSet(cacheKey, response);
      logger.info(`📚 [PromptsChatLibrary] Fetched prompt: "${response.title || id}"`);
      return response;
    } catch (err) {
      this.stats.errors++;
      logger.warn(`📚 [PromptsChatLibrary] Failed to fetch prompt ${id}: ${err.message}`);
      return this._getFallbackPrompt(id);
    }
  }

  async _fetchWithRetry(url, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const https = require('https');
        const response = await new Promise((resolve, reject) => {
          const req = https.get(url, { timeout: 10000 }, (res) => {
            if (res.statusCode === 429) {
              reject(new Error('RATE_LIMITED'));
              return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(data)); }
              catch (e) { reject(new Error('Invalid JSON from prompts.chat')); }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
        return response;
      } catch (err) {
        if (err.message === 'RATE_LIMITED' && attempt < retries) {
          const backoffMs = (attempt + 1) * 30000;
          logger.warn(`📚 [PromptsChatLibrary] Rate limited, retrying in ${backoffMs / 1000}s...`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }
    }
  }

  // ============ MARKET-AWARE SELECTION ============

  async getMarketPrompt(marketKey) {
    const promptIds = this.MARKET_PROMPTS[marketKey] || this.MARKET_PROMPTS.CRYPTO;
    for (const id of promptIds) {
      const prompt = await this.getPrompt(id);
      if (prompt) return prompt;
    }
    return null;
  }

  async getMarketStrategies(marketKey) {
    const promptIds = this.MARKET_PROMPTS[marketKey] || this.MARKET_PROMPTS.CRYPTO;
    const strategies = [];
    for (const id of promptIds) {
      const prompt = await this.getPrompt(id);
      if (prompt) strategies.push(prompt);
    }
    return strategies;
  }

  // ============ DEBATE PERSONA ============

  async getDebatePersona() {
    const id = this.DEBATE_PERSONAS[this.debatePersonaIndex % this.DEBATE_PERSONAS.length];
    this.debatePersonaIndex++;
    return await this.getPrompt(id);
  }

  getDebatePersonaCached() {
    const id = this.DEBATE_PERSONAS[this.debatePersonaIndex % this.DEBATE_PERSONAS.length];
    this.debatePersonaIndex++;
    return this._cacheGet(`prompt:${id}`);
  }

  // ============ SIGNAL TEMPLATES ============

  async getSignalTemplate() {
    for (const id of this.SIGNAL_TEMPLATES) {
      const prompt = await this.getPrompt(id);
      if (prompt) return prompt;
    }
    return null;
  }

  getSignalTemplateCached() {
    for (const id of this.SIGNAL_TEMPLATES) {
      const cached = this._cacheGet(`prompt:${id}`);
      if (cached) return cached;
    }
    return null;
  }

  // ============ DUE DILIGENCE & RISK ============

  async getDueDiligenceTemplate() {
    return await this.getPrompt(this.BEST_PROMPTS.BIG_4_REPORT);
  }

  async getRiskFramework() {
    return await this.getPrompt(this.BEST_PROMPTS.CRYPTO_CONTRACT);
  }

  // ============ VARIABLE TEMPLATE ENGINE ============

  fillVariables(prompt, context = {}) {
    if (!prompt || !prompt.content) return '';
    
    let content = prompt.content;
    const variables = prompt.variables || [];
    
    for (const v of variables) {
      const value = context[v.name] || v.defaultValue || `[${v.name}]`;
      content = content.replace(new RegExp(`\\$\\{${v.name}(?::[^}]*)?\\}`, 'g'), value);
    }

    for (const [key, value] of Object.entries(context)) {
      content = content.replace(new RegExp(`\\$\\{${key}(?::[^}]*)?\\}`, 'g'), String(value));
    }

    return content;
  }

  // ============ SIGNAL SCORING ============

  scoreSignalAgainstTemplate(signal, context = {}) {
    const template = this.getSignalTemplateCached();
    const templateName = template ? template.title : 'Sigrex.io 4-Step Engine (Default)';

    let score = 0.75;
    const factors = [];

    // Step 1: Sentiment Bias (Fear & Greed alignment)
    const sentimentScore = context.fearGreedIndex || 50;
    if (signal.direction === 'LONG') {
      if (sentimentScore <= 30) {
        score += 0.10;
        factors.push('Extreme Fear favors LONG (contrarian buy)');
      } else if (sentimentScore >= 75) {
        score -= 0.10;
        factors.push('Extreme Greed penalizes LONG entry');
      }
    } else if (signal.direction === 'SHORT') {
      if (sentimentScore >= 75) {
        score += 0.10;
        factors.push('Extreme Greed favors SHORT (contrarian sell)');
      } else if (sentimentScore <= 30) {
        score -= 0.10;
        factors.push('Extreme Fear penalizes SHORT entry');
      }
    }

    // Step 2: Technical Confirmation (RSI alignment)
    const rsi = signal.rsi || context.rsi || 50;
    if (signal.direction === 'LONG' && rsi < 30) {
      score += 0.05;
      factors.push(`RSI oversold (${rsi}) confirms LONG`);
    } else if (signal.direction === 'SHORT' && rsi > 70) {
      score += 0.05;
      factors.push(`RSI overbought (${rsi}) confirms SHORT`);
    }

    // Step 3: Position Check — exit-before-entry safety
    if (context.hasOpenPosition && context.lastSignalDirection === signal.direction) {
      score -= 0.15;
      factors.push('SAFETY: Same-direction entry without prior exit (Sigrex Rule 3)');
    }

    // Step 4: Consecutive signal cap (max 3 non-exit signals)
    if (context.consecutiveNonExitSignals >= 3) {
      score -= 0.20;
      factors.push('SAFETY: 3+ consecutive non-exit signals → forced HOLD (Sigrex Rule 4)');
    }

    // Confidence alignment bonus
    if (signal.confidence >= 0.80) {
      score += 0.05;
      factors.push('High confidence (>80%) aligns with template conviction threshold');
    }

    score = Math.max(0, Math.min(1, score));

    return {
      score: parseFloat(score.toFixed(2)),
      reason: factors.length > 0 ? factors.join('; ') : `Signal neutral against ${templateName}`,
      templateUsed: templateName
    };
  }

  // ============ FALLBACK DATA ============

  _getFallbackSearchResults(query) {
    const fallbacks = [
      { id: this.BEST_PROMPTS.SIMMERDEEP_QUANT, title: 'Simmerdeep Crypto Quant v2.0', description: 'Senior Trading Mentor: Druckenmiller/Napier/Armstrong fusion', type: 'FALLBACK_CACHED' },
      { id: this.BEST_PROMPTS.SIGREX_KITCHEN_SINK, title: '[sigrex.io] Full Kitchen Sink', description: 'RSI + MACD + Fear & Greed 4-step signal engine', type: 'FALLBACK_CACHED' },
      { id: this.BEST_PROMPTS.SUPER_TRADER, title: 'Super Trader Model', description: 'Stock trend analysis + strategic recommendations', type: 'FALLBACK_CACHED' }
    ];
    return fallbacks.filter(f => 
      f.title.toLowerCase().includes(query.toLowerCase()) || 
      f.description.toLowerCase().includes(query.toLowerCase()) ||
      query.toLowerCase().includes('trading')
    );
  }

  _getFallbackPrompt(id) {
    const fallbacks = {
      [this.BEST_PROMPTS.SIMMERDEEP_QUANT]: {
        id: this.BEST_PROMPTS.SIMMERDEEP_QUANT, title: 'Simmerdeep Crypto Quant v2.0',
        content: 'Act as Senior Trading Mentor: a fusion of Stan Druckenmiller (global macro/intuition), Russell Napier (market regime & debasement cycles), and Martin Armstrong (Economic Confidence Model & microstructure/order flow). Provide a strict 4-hourly synthesis covering: Global Macro, Hard Money, Sentiment, Institutional Flow, Microstructure, Altcoin Scan, and Path of Least Resistance.',
        contentPreview: 'Druckenmiller × Napier × Armstrong — 7-section crypto quant analysis',
        variables: [], type: 'FALLBACK_CACHED'
      },
      [this.BEST_PROMPTS.SIGREX_KITCHEN_SINK]: {
        id: this.BEST_PROMPTS.SIGREX_KITCHEN_SINK, title: '[sigrex.io] Full Kitchen Sink',
        content: 'Step 1 — Sentiment Bias (Fear & Greed): 0-30 LONG only, 31-50 Lean LONG, 51-74 Lean SHORT, 75-100 SHORT only. Step 2 — Technical: RSI < 30 + MACD positive = LONG, RSI > 70 + MACD negative = SHORT. Step 3 — Must EXIT before new entry. Step 4 — Max 3 consecutive non-exits.',
        contentPreview: '4-step signal engine: Sentiment → Technical → Position → Decision',
        variables: [{ name: 'symbol', defaultValue: 'SOLUSDT' }, { name: 'rsi_ob', defaultValue: '70' }, { name: 'rsi_os', defaultValue: '30' }],
        type: 'FALLBACK_CACHED'
      },
      [this.BEST_PROMPTS.SUPER_TRADER]: {
        id: this.BEST_PROMPTS.SUPER_TRADER, title: 'Super Trader Model for Stock Analysis',
        content: 'Act as a Super Trader Model. Analyze current stock trends and patterns. Use advanced algorithms to predict future movements. Offer actionable trading strategies. Focus on both technical and fundamental analysis. Consider market news and economic indicators.',
        contentPreview: 'Advanced stock analysis + strategic recommendations',
        variables: [{ name: 'stockSymbol' }, { name: 'investmentAmount' }, { name: 'riskLevel', defaultValue: 'medium' }],
        type: 'FALLBACK_CACHED'
      },
      [this.BEST_PROMPTS.BIG_4_REPORT]: {
        id: this.BEST_PROMPTS.BIG_4_REPORT, title: 'Big 4 Style Report for Retail Traders',
        content: 'McKinsey-style management consultant report: Executive Summary, Strategic Context, Solution Overview, Business Value Proposition, Risks & Mitigations, Implementation Considerations, Fundamental Analysis, Major Stock-Moving Events, Conclusion.',
        contentPreview: 'Institutional-grade due diligence report (9 sections)',
        variables: [], type: 'FALLBACK_CACHED'
      },
      [this.BEST_PROMPTS.CRYPTO_CONTRACT]: {
        id: this.BEST_PROMPTS.CRYPTO_CONTRACT, title: 'Cryptocurrency Contract Trading System',
        content: 'Analyze market trends and data. Develop trading strategies that maximize profit and minimize risk. Implement risk management techniques. Continuously monitor and adjust strategies.',
        contentPreview: 'Crypto contract/futures trading with risk tolerance tuning',
        variables: [{ name: 'marketData' }, { name: 'tradingStrategy', defaultValue: 'default' }, { name: 'riskTolerance', defaultValue: 'medium' }],
        type: 'FALLBACK_CACHED'
      },
      [this.BEST_PROMPTS.ALFA2_INSTITUTIONAL]: {
        id: this.BEST_PROMPTS.ALFA2_INSTITUTIONAL, title: 'Alfa2 Institutional Equity Research',
        content: 'Act as an elite institutional equity research analyst and global macro portfolio strategist specializing in tech, cross-border supply chains, and on-chain liquid markets.',
        contentPreview: 'Institutional equity + on-chain cross-asset analysis',
        variables: [], type: 'FALLBACK_CACHED'
      },
      [this.BEST_PROMPTS.CRYPTO_OUTLOOK]: {
        id: this.BEST_PROMPTS.CRYPTO_OUTLOOK, title: 'Crypto Market Outlook Analyst',
        content: 'Act as a Professional Crypto Analyst. Review and summarize market outlooks covering: Main Market Thesis, Key Predictions, Risk Factors, and Actionable Insights.',
        contentPreview: 'Professional crypto market outlook summaries',
        variables: [], type: 'FALLBACK_CACHED'
      }
    };
    return fallbacks[id] || null;
  }

  // ============ PRELOAD ============

  async preloadBestPrompts() {
    logger.info('📚 [PromptsChatLibrary] Pre-loading best prompts into cache...');
    const ids = Object.values(this.BEST_PROMPTS);
    let loaded = 0;
    
    for (const id of ids) {
      try {
        await this.getPrompt(id);
        loaded++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        logger.warn(`📚 [PromptsChatLibrary] Pre-load failed for ${id}: ${err.message} (fallback active)`);
      }
    }
    
    logger.info(`📚 [PromptsChatLibrary] Pre-loaded ${loaded}/${ids.length} prompts into cache`);
  }

  // ============ STATS ============

  getCacheStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    return {
      cacheSize: this.cache.size,
      maxCache: this.MAX_CACHE,
      cacheTTL: '30 minutes',
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: totalRequests > 0 ? `${((this.stats.hits / totalRequests) * 100).toFixed(1)}%` : '0%',
      errors: this.stats.errors,
      totalFetches: this.stats.totalFetches,
      preloadedPrompts: Object.keys(this.BEST_PROMPTS).length,
      marketsSupported: Object.keys(this.MARKET_PROMPTS).length,
      debatePersonas: this.DEBATE_PERSONAS.length,
      signalTemplates: this.SIGNAL_TEMPLATES.length
    };
  }
}

module.exports = new PromptsChatLibrary();
