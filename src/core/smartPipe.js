/**
 * Smart Pipe - Market Data Stream Filter
 * 
 * Port of Cybermes smart_pipe for Trading Brain
 * Filters market data streams, preserving 100% raw logs while streaming only high-signal findings to AI context
 * Saves 70-85% token consumption
 * 
 * Usage: 
 *   const filter = new MarketDataFilter({ target: 'BTCUSDT', tool: 'market_feed', limit: 50 });
 *   const result = await filter.processStream(rawDataStream);
 */

const fs = require('fs');
const path = require('path');
const { Readable, Writable } = require('stream');

// ============================================================================
// PATTERNS & CONSTANTS (Trading-specific)
// ============================================================================

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const STATIC_SUFFIXES = [
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.css', '.mp4', '.mp3', '.webm', '.avi', '.mov',
];

// High-signal trading markers
const CRITICAL_MARKERS = [
  'liquidation', 'liquidated', 'margin call', 'stop hunt',
  'whale', 'institutional', 'block trade', 'dark pool',
  'order book imbalance', 'spread widening', 'funding rate',
  'open interest', 'gamma squeeze', 'short squeeze',
  'breakout', 'breakdown', 'fakeout', 'liquidity sweep',
];

const NEWS_MARKERS = [
  'earnings', 'guidance', 'merger', 'acquisition', 'buyback',
  'fed', 'fomc', 'cpi', 'ppi', 'nfp', 'unemployment',
  'interest rate', 'rate hike', 'rate cut', 'inflation',
  'gdp', 'retail sales', 'pmi', 'ism',
];

const TECHNICAL_MARKERS = [
  'rsi', 'macd', 'bollinger', 'moving average', 'ema', 'sma',
  'support', 'resistance', 'trendline', 'channel', 'pattern',
  'head and shoulders', 'double top', 'double bottom', 'wedge',
  'triangle', 'flag', 'pennant',
];

const SENTIMENT_MARKERS = [
  'bullish', 'bearish', 'fomo', 'fud', 'hype', 'pump', 'dump',
  'accumulation', 'distribution', 'smart money', 'retail',
  'long', 'short', 'leverage', 'deleveraging',
];

const HIGH_ENTROPY_THRESHOLD = 3.8;

// ============================================================================
// TYPES
// ============================================================================

class ScoredLine {
  constructor(score, text, metadata = {}) {
    this.score = score;
    this.text = text;
    this.metadata = metadata;
    this.timestamp = Date.now();
  }
}

class ProcessResult {
  constructor(totalRaw = 0, uniqueScored = 0, shownCount = 0, preservedCount = 0) {
    this.totalRaw = totalRaw;
    this.uniqueScored = uniqueScored;
    this.shownCount = shownCount;
    this.preservedCount = preservedCount;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function cleanLine(line) {
  let cleaned = line.replace(ANSI_REGEX, '');
  return cleaned.trim();
}

function calculateEntropy(text) {
  if (text.length < 16) return 0.0;
  
  const counts = new Array(256).fill(0);
  const length = text.length;
  
  for (let i = 0; i < length; i++) {
    counts[text.charCodeAt(i)]++;
  }
  
  let entropy = 0;
  for (const count of counts) {
    if (count > 0) {
      const p = count / length;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

function isStaticAsset(lower) {
  for (const ext of STATIC_SUFFIXES) {
    if (lower.endsWith(ext) || lower.includes(ext + '?') || lower.includes(ext + '#')) {
      return true;
    }
  }
  return false;
}

function scoreMarketLine(line) {
  const lower = line.toLowerCase();
  
  // Filter static assets
  if (isStaticAsset(lower)) return 0;
  
  let score = 10; // Base score
  
  // Critical trading events
  for (const marker of CRITICAL_MARKERS) {
    if (lower.includes(marker)) {
      score += 80;
      break;
    }
  }
  
  // News events
  for (const marker of NEWS_MARKERS) {
    if (lower.includes(marker)) {
      score += 50;
      break;
    }
  }
  
  // Technical analysis
  for (const marker of TECHNICAL_MARKERS) {
    if (lower.includes(marker)) {
      score += 30;
      break;
    }
  }
  
  // Sentiment
  for (const marker of SENTIMENT_MARKERS) {
    if (lower.includes(marker)) {
      score += 20;
      break;
    }
  }
  
  // Price action signals
  if (lower.includes('200') || lower.includes('ok')) {
    score += 25;
    if (lower.includes('/api/') || lower.includes('/v1/') || lower.includes('/v2/')) {
      score += 25;
    }
  }
  
  // Error states (potential issues)
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden')) {
    score += 20;
    if (lower.includes('/admin') || lower.includes('/api/') || lower.includes('/internal')) {
      score += 25;
    }
  }
  
  if (lower.includes('500') || lower.includes('internal server error')) {
    score += 15;
  }
  
  // Parameter presence (potential data)
  if (line.includes('?') && line.includes('=')) {
    score += 20;
  }
  
  // UUID detection (order IDs, trade IDs)
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  if (uuidRegex.test(line)) {
    score += 20;
  }
  
  // High entropy secrets/keys
  if (lower.includes('key') || lower.includes('secret') || lower.includes('tok') || lower.includes('pass')) {
    if (calculateEntropy(line) > HIGH_ENTROPY_THRESHOLD) {
      score += 30;
    }
  }
  
  // Volume/price data
  if (lower.includes('volume') || lower.includes('price') || lower.includes('bid') || lower.includes('ask')) {
    score += 15;
  }
  
  // Time-based relevance
  if (lower.includes('now') || lower.includes('just') || lower.includes('alert') || lower.includes('breaking')) {
    score += 25;
  }
  
  return Math.min(score, 200); // Cap score
}

// ============================================================================
// MAIN FILTER CLASS
// ============================================================================

class MarketDataFilter {
  constructor(options = {}) {
    this.target = options.target || 'default_target';
    this.tool = options.tool || 'market_feed';
    this.limit = options.limit || 50;
    this.rootDir = options.rootDir || process.cwd();
    this.reconDir = path.join(this.rootDir, 'recon', this.target);
    this.rawLogPath = path.join(this.reconDir, `${this.tool}_raw.txt`);
    this.metadataPath = path.join(this.reconDir, `${this.tool}_metadata.json`);
    
    // Ensure recon directory exists
    if (!fs.existsSync(this.reconDir)) {
      fs.mkdirSync(this.reconDir, { recursive: true, mode: 0o777 });
    }
    
    this.rawFile = fs.createWriteStream(this.rawLogPath, { flags: 'w', mode: 0o666 });
    this.seen = new Set();
    this.scored = [];
    this.totalRaw = 0;
    this.rawBuf = null;
  }
  
  /**
   * Process a stream of market data
   * @param {Readable} inputStream - Input stream (stdin, file, etc.)
   * @param {Writable} outputStream - Output stream for high-signal findings (stdout)
   * @returns {Promise<ProcessResult>}
   */
  _processStream(inputStream, outputStream) {
      return new Promise((resolve, reject) => {
        // Use native Node.js buffering instead of bufio
        const rawBuf = {
          write: (str) => {
            this.rawFile.write(str);
          },
          flush: () => {
            // No-op for native stream
          }
        };
        this.rawBuf = rawBuf;
      
        const readline = require('readline');
        const scanner = readline.createInterface({
          input: inputStream,
          crlfDelay: Infinity
        });
      
        scanner.on('line', (line) => {
          const cleaned = this._cleanLine(line);
          if (!cleaned) return;
        
          this.totalRaw++;
          this.rawFile.write(cleaned + '\n');
        
          if (!this.seen.has(cleaned)) {
            this.seen.add(cleaned);
            const score = scoreMarketLine(cleaned);
            if (score > 0) {
              this.scored.push(new ScoredLine(score, cleaned));
            }
          }
        });
      
        scanner.on('close', () => {
          this._finalize(outputStream)
            .then(resolve)
            .catch(reject);
        });
      
        scanner.on('error', (err) => reject(err));
      });
    }
  
  _cleanLine(line) {
    return cleanLine(line);
  }
  
  async _finalize(outputStream) {
    // Sort by score descending
    this.scored.sort((a, b) => b.score - a.score);
    
    const displayCount = Math.min(this.limit, this.scored.length);
    
    // Write summary to output stream
    outputStream.write(
      `📊 [Smart Filter] ${displayCount} high-signal findings prioritized (from ${this.totalRaw} total raw lines).\n\n`
    );
    
    // Write top findings
    for (let i = 0; i < displayCount; i++) {
      outputStream.write(this.scored[i].text + '\n');
    }
    
    if (this.scored.length > displayCount) {
      outputStream.write(
        `\n... (+${this.scored.length - displayCount} more filtered entries archived in raw log)\n`
      );
    }
    
    // Save metadata
    const metadata = {
      target: this.target,
      tool: this.tool,
      timestamp: new Date().toISOString(),
      totalRaw: this.totalRaw,
      uniqueScored: this.scored.length,
      shownCount: displayCount,
      preservedCount: this.scored.length - displayCount,
      rawLogPath: this.rawLogPath
    };
    
    fs.writeFileSync(this.metadataPath, JSON.stringify(metadata, null, 2));
    
    this.rawFile.end();
    
    return new ProcessResult(
      this.totalRaw,
      this.scored.length,
      displayCount,
      this.scored.length - displayCount
    );
  }
  
  close() {
    if (this.rawFile) {
      this.rawFile.end();
    }
  }
  
  /**
   * Static method to process array of lines (for batch processing)
   */
  static processLines(lines, options = {}) {
    const filter = new MarketDataFilter(options);
    const scored = [];
    const seen = new Set();
    let totalRaw = 0;
    
    for (const line of lines) {
      const cleaned = cleanLine(line);
      if (!cleaned) continue;
      
      totalRaw++;
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        const score = scoreMarketLine(cleaned);
        if (score > 0) {
          scored.push(new ScoredLine(score, cleaned));
        }
      }
    }
    
    scored.sort((a, b) => b.score - a.score);
    
    const displayCount = Math.min(options.limit || 50, scored.length);
    const result = {
      totalRaw,
      uniqueScored: scored.length,
      shownCount: displayCount,
      preservedCount: scored.length - displayCount,
      topFindings: scored.slice(0, displayCount).map(s => s.text)
    };
    
    return result;
  }
}

// ============================================================================
// STREAM TRANSFORM (for pipeline usage)
// ============================================================================

class SmartFilterTransform extends require('stream').Transform {
  constructor(options = {}) {
    super({ objectMode: true });
    this.options = options;
    this.buffer = [];
  }
  
  _transform(chunk, encoding, callback) {
    // Buffer for batch processing
    this.buffer.push(chunk.toString());
    callback();
  }
  
  _flush(callback) {
    try {
      const result = MarketDataFilter.processLines(this.buffer, { limit: this.options.limit });
      // Emit top findings
      for (const finding of result.topFindings) {
        this.push(finding + '\n');
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  
  // Simple CLI: cat file | node smart_pipe.js --target SLUG --tool TOOL --limit N
  const targetIdx = args.indexOf('--target');
  const toolIdx = args.indexOf('--tool');
  const limitIdx = args.indexOf('--limit');
  const tIdx = args.indexOf('-t');
  const nIdx = args.indexOf('-n');
  const lIdx = args.indexOf('-l');
  
  const target = args[targetIdx + 1] || args[tIdx + 1] || 'default_target';
  const tool = args[toolIdx + 1] || args[nIdx + 1] || 'market_feed';
  const limit = parseInt(args[limitIdx + 1] || args[lIdx + 1] || '50');
  
  const filter = new MarketDataFilter({ target, tool, limit });
  
  filter.processStream(process.stdin, process.stdout)
    .then(result => {
      console.error(`✅ Processed ${result.totalRaw} lines, ${result.uniqueScored} unique, ${result.shownCount} shown`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = {
  MarketDataFilter,
  SmartFilterTransform,
  scoreMarketLine,
  cleanLine,
  calculateEntropy,
  ProcessResult,
  ScoredLine
};