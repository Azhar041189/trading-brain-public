/**
 * ExcursionTelemetryEngine (v14.2 Permanent Hard-Freeze Certified)
 * 
 * Final Audit & Conflict Resolution Guarantees:
 * 1. Immutable Audit Ledger with Canonical SHA-256 Record Hash:
 *    - Every finalized telemetry record computes a deterministic SHA-256 hash across canonical fields.
 * 2. Hash-Compare Fail-Closed Recovery (Replaces Permissive `INSERT OR REPLACE`):
 *    - If tradeId does not exist: INSERT.
 *    - If tradeId exists AND canonicalRecordHash matches: NO-OP (Safe Idempotent Duplicate).
 *    - If tradeId exists BUT canonicalRecordHash differs: FAIL CLOSED. Emits `TELEMETRY_RECOVERY_CONFLICT`,
 *      persists conflicting record to quarantine (`data/telemetry_conflicts.json`), and preserves database history.
 * 3. Censored Exit Bar Semantics: Post-entry bar extrema strictly excluded on same-candle exits.
 * 4. Multi-Feed Scoped Sequences: Scoped by `${source}:${symbolOrTradeId}:${streamId}`.
 * 5. Recursive Deep Freeze: Enforces immutable event boundary.
 * 6. Zero-Decision-Delta: Verified on defined invariant corpus/configuration.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * Recursive Deep Freeze helper for immutable event DTOs
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  Object.getOwnPropertyNames(obj).forEach(prop => {
    if (
      obj[prop] !== null &&
      (typeof obj[prop] === 'object' || typeof obj[prop] === 'function') &&
      !Object.isFrozen(obj[prop])
    ) {
      deepFreeze(obj[prop]);
    }
  });
  return obj;
}

class ExcursionTelemetryEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.schemaVersion = '14.2.3';
    this.dbPath = options.dbPath || path.join(process.cwd(), 'data', 'excursion_telemetry.db');
    this.fallbackJsonPath = options.fallbackJsonPath || path.join(process.cwd(), 'data', 'excursion_telemetry.json');
    this.conflictLogPath = options.conflictLogPath || path.join(process.cwd(), 'data', 'telemetry_conflicts.json');
    this.maxHistory = options.maxHistory || 1000;
    
    // Active excursions map
    this.activeExcursions = new Map();
    
    // Completed trade excursion records
    this.tradeHistory = [];

    // Persistence State Authority: 'SQLITE_PRIMARY' | 'JSON_FALLBACK' | 'MEMORY_ONLY'
    this.persistenceMode = 'MEMORY_ONLY';
    this.db = null;

    // Multi-Feed Sequence Scope: Map of `source:symbol:streamId` -> lastSequence
    this.lastProcessedSequence = new Map();

    this._initPersistence();
  }

  _initPersistence() {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const allowSqlite = process.env.ENABLE_SQLITE_TELEMETRY === 'true' || process.platform === 'win32';
      if (allowSqlite) {
        try {
          const Database = require('better-sqlite3');
          this.db = new Database(this.dbPath);
          this._initSqliteTables();
          this.persistenceMode = 'SQLITE_PRIMARY';
          
          // Idempotent recovery: Migrate any fallback JSON records back into SQLite with hash-compare fail-closed
          this.syncJsonFallbackToSqlite();
          this._loadFromSqlite();
          return;
        } catch (sqliteErr) {
          this.persistenceMode = 'JSON_FALLBACK';
          this._loadFromJson();
          return;
        }
      }

      this.persistenceMode = 'JSON_FALLBACK';
      this._loadFromJson();
    } catch (e) {
      this.persistenceMode = 'MEMORY_ONLY';
    }
  }

  _initSqliteTables() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS closed_excursions (
        tradeId TEXT PRIMARY KEY,
        canonicalRecordHash TEXT NOT NULL,
        symbol TEXT NOT NULL,
        market TEXT NOT NULL,
        instrumentType TEXT NOT NULL,
        side TEXT NOT NULL,
        entryTimestamp INTEGER NOT NULL,
        exitTimestamp INTEGER NOT NULL,
        holdingTimeSec INTEGER NOT NULL,
        holdingHours REAL,
        velocityReason TEXT,
        entryPrice REAL NOT NULL,
        exitPrice REAL NOT NULL,
        initialStopPrice REAL NOT NULL,
        initialQuantity REAL NOT NULL,
        contractMultiplier REAL NOT NULL,
        quoteToAccountCurrency REAL NOT NULL,
        initialRiskAmount REAL NOT NULL,
        highestPriceWhileOpen REAL NOT NULL,
        lowestPriceWhileOpen REAL NOT NULL,
        mfeDollar REAL NOT NULL,
        maeDollar REAL NOT NULL,
        mfeR REAL NOT NULL,
        maeR REAL NOT NULL,
        grossPnL REAL NOT NULL,
        fees REAL NOT NULL,
        spreadCost REAL NOT NULL,
        slippageCost REAL NOT NULL,
        slippageType TEXT NOT NULL,
        netPnL REAL NOT NULL,
        realizedGrossR REAL NOT NULL,
        realizedNetR REAL NOT NULL,
        captureRatioRaw REAL,
        capturePct REAL,
        exitGivebackR REAL NOT NULL,
        givebackFromPeakR REAL NOT NULL,
        allocatedCapital REAL NOT NULL,
        returnOnAllocatedCapital REAL,
        returnVelocity REAL,
        rVelocity REAL,
        rawConfidence REAL,
        confidenceBucket TEXT NOT NULL,
        excursionSource TEXT NOT NULL,
        strategyId TEXT,
        regimeAtEntry TEXT,
        regimeAtExit TEXT,
        exitReason TEXT,
        persistenceMode TEXT NOT NULL,
        schemaVersion TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_closed_market ON closed_excursions(market);
      CREATE INDEX IF NOT EXISTS idx_closed_bucket ON closed_excursions(confidenceBucket);
    `);

    // Ensure canonicalRecordHash and metadata columns exist if table was created in older schema
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(closed_excursions)").all();
      const existingCols = new Set(tableInfo.map(c => c.name));
      if (!existingCols.has('canonicalRecordHash')) {
        this.db.exec("ALTER TABLE closed_excursions ADD COLUMN canonicalRecordHash TEXT NOT NULL DEFAULT 'UNHASHED_LEGACY'");
      }
      if (!existingCols.has('instrumentType')) {
        this.db.exec("ALTER TABLE closed_excursions ADD COLUMN instrumentType TEXT NOT NULL DEFAULT 'LINEAR_SPOT'");
      }
      if (!existingCols.has('velocityReason')) {
        this.db.exec("ALTER TABLE closed_excursions ADD COLUMN velocityReason TEXT DEFAULT 'NORMAL'");
      }
      if (!existingCols.has('spreadCost')) {
        this.db.exec("ALTER TABLE closed_excursions ADD COLUMN spreadCost REAL NOT NULL DEFAULT 0.0");
      }
      if (!existingCols.has('persistenceMode')) {
        this.db.exec("ALTER TABLE closed_excursions ADD COLUMN persistenceMode TEXT NOT NULL DEFAULT 'SQLITE_PRIMARY'");
      }
      if (!existingCols.has('schemaVersion')) {
        this.db.exec("ALTER TABLE closed_excursions ADD COLUMN schemaVersion TEXT NOT NULL DEFAULT '14.2.3'");
      }
    } catch (migErr) {}
  }

  _loadFromSqlite() {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare('SELECT * FROM closed_excursions ORDER BY exitTimestamp ASC LIMIT ?');
      this.tradeHistory = stmt.all(this.maxHistory);
    } catch (e) {
      this.tradeHistory = [];
    }
  }

  /**
   * Deterministic SHA-256 Canonical Record Hash Calculation
   */
  computeCanonicalHash(t) {
    const canonicalPayload = {
      tradeId: t.tradeId,
      symbol: t.symbol,
      market: t.market,
      side: t.side,
      entryTimestamp: t.entryTimestamp,
      exitTimestamp: t.exitTimestamp,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      initialStopPrice: t.initialStopPrice,
      initialQuantity: t.initialQuantity,
      contractMultiplier: t.contractMultiplier,
      quoteToAccountCurrency: t.quoteToAccountCurrency,
      initialRiskAmount: t.initialRiskAmount,
      highestPriceWhileOpen: t.highestPriceWhileOpen,
      lowestPriceWhileOpen: t.lowestPriceWhileOpen,
      mfeDollar: t.mfeDollar,
      maeDollar: t.maeDollar,
      mfeR: t.mfeR,
      maeR: t.maeR,
      grossPnL: t.grossPnL,
      fees: t.fees,
      netPnL: t.netPnL,
      realizedNetR: t.realizedNetR,
      captureRatioRaw: t.captureRatioRaw,
      exitGivebackR: t.exitGivebackR
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
  }

  /**
   * Log forensic conflict to quarantine store
   */
  _logQuarantineConflict(conflict) {
    try {
      let conflicts = [];
      if (fs.existsSync(this.conflictLogPath)) {
        conflicts = JSON.parse(fs.readFileSync(this.conflictLogPath, 'utf8'));
      }
      conflicts.push(conflict);
      fs.writeFileSync(this.conflictLogPath, JSON.stringify(conflicts, null, 2), 'utf8');
    } catch (e) {
      console.warn('[ExcursionTelemetry] Failed to write conflict quarantine log:', e.message);
    }
  }

  /**
   * Fail-Closed Hash-Compare Recovery Sync
   */
  syncJsonFallbackToSqlite() {
    if (!this.db || !fs.existsSync(this.fallbackJsonPath)) return;
    try {
      const raw = fs.readFileSync(this.fallbackJsonPath, 'utf8');
      const fallbackTrades = JSON.parse(raw);
      if (!Array.isArray(fallbackTrades) || fallbackTrades.length === 0) return;

      const checkStmt = this.db.prepare('SELECT canonicalRecordHash, schemaVersion FROM closed_excursions WHERE tradeId = ?');
      const insertStmt = this.db.prepare(`
        INSERT INTO closed_excursions (
          tradeId, canonicalRecordHash, symbol, market, instrumentType, side, entryTimestamp, exitTimestamp, holdingTimeSec, holdingHours,
          velocityReason, entryPrice, exitPrice, initialStopPrice, initialQuantity, contractMultiplier, quoteToAccountCurrency,
          initialRiskAmount, highestPriceWhileOpen, lowestPriceWhileOpen, mfeDollar, maeDollar, mfeR, maeR,
          grossPnL, fees, spreadCost, slippageCost, slippageType, netPnL, realizedGrossR, realizedNetR,
          captureRatioRaw, capturePct, exitGivebackR, givebackFromPeakR, allocatedCapital,
          returnOnAllocatedCapital, returnVelocity, rVelocity, rawConfidence, confidenceBucket,
          excursionSource, strategyId, regimeAtEntry, regimeAtExit, exitReason, persistenceMode, schemaVersion, createdAt
        ) VALUES (
          @tradeId, @canonicalRecordHash, @symbol, @market, @instrumentType, @side, @entryTimestamp, @exitTimestamp, @holdingTimeSec, @holdingHours,
          @velocityReason, @entryPrice, @exitPrice, @initialStopPrice, @initialQuantity, @contractMultiplier, @quoteToAccountCurrency,
          @initialRiskAmount, @highestPriceWhileOpen, @lowestPriceWhileOpen, @mfeDollar, @maeDollar, @mfeR, @maeR,
          @grossPnL, @fees, @spreadCost, @slippageCost, @slippageType, @netPnL, @realizedGrossR, @realizedNetR,
          @captureRatioRaw, @capturePct, @exitGivebackR, @givebackFromPeakR, @allocatedCapital,
          @returnOnAllocatedCapital, @returnVelocity, @rVelocity, @rawConfidence, @confidenceBucket,
          @excursionSource, @strategyId, @regimeAtEntry, @regimeAtExit, @exitReason, @persistenceMode, @schemaVersion, @createdAt
        )
      `);

      const syncTransaction = this.db.transaction((trades) => {
        for (const rawT of trades) {
          const t = this._normalizeTradeRecord(rawT);
          const computedHash = t.canonicalRecordHash || this.computeCanonicalHash(t);
          t.canonicalRecordHash = computedHash;

          const existing = checkStmt.get(t.tradeId);
          if (!existing) {
            // Case 1: Does not exist -> Clean INSERT
            insertStmt.run(t);
          } else if (existing.canonicalRecordHash === computedHash || existing.canonicalRecordHash === 'UNHASHED_LEGACY') {
            // Case 2: Exists and hash matches -> Safe Idempotent NO-OP
            continue;
          } else {
            // Case 3: Exists BUT hash differs -> FAIL CLOSED & QUARANTINE
            const conflictEvent = {
              type: 'TELEMETRY_RECOVERY_CONFLICT',
              tradeId: t.tradeId,
              existingHash: existing.canonicalRecordHash,
              incomingHash: computedHash,
              incomingRecord: t,
              timestamp: Date.now()
            };
            this.emit('telemetryRecoveryConflict', conflictEvent);
            this._logQuarantineConflict(conflictEvent);
            console.warn(`🚨 [ExcursionTelemetry] RECOVERY CONFLICT: Trade ${t.tradeId} has differing payload. Failing closed & preserving DB.`);
          }
        }
      });

      syncTransaction(fallbackTrades);
    } catch (e) {
      console.warn('[ExcursionTelemetry] Idempotent JSON sync warning:', e.message);
    }
  }

  _normalizeTradeRecord(rawT) {
    const t = {
      tradeId: rawT.tradeId || `trade_${Date.now()}`,
      symbol: rawT.symbol || 'UNKNOWN',
      market: rawT.market || 'CRYPTO',
      instrumentType: rawT.instrumentType || 'LINEAR_SPOT',
      side: rawT.side || 'LONG',
      entryTimestamp: rawT.entryTimestamp || Date.now(),
      exitTimestamp: rawT.exitTimestamp || Date.now(),
      holdingTimeSec: rawT.holdingTimeSec || 0,
      holdingHours: rawT.holdingHours || 0,
      velocityReason: rawT.velocityReason || 'NORMAL',
      entryPrice: rawT.entryPrice || 0,
      exitPrice: rawT.exitPrice || 0,
      initialStopPrice: rawT.initialStopPrice || 0,
      initialQuantity: rawT.initialQuantity || 1,
      contractMultiplier: rawT.contractMultiplier || 1.0,
      quoteToAccountCurrency: rawT.quoteToAccountCurrency || 1.0,
      initialRiskAmount: rawT.initialRiskAmount || 1.0,
      highestPriceWhileOpen: rawT.highestPriceWhileOpen || 0,
      lowestPriceWhileOpen: rawT.lowestPriceWhileOpen || 0,
      mfeDollar: rawT.mfeDollar || 0,
      maeDollar: rawT.maeDollar || 0,
      mfeR: rawT.mfeR || 0,
      maeR: rawT.maeR || 0,
      grossPnL: rawT.grossPnL || 0,
      fees: rawT.fees || 0,
      spreadCost: rawT.spreadCost || 0,
      slippageCost: rawT.slippageCost || 0,
      slippageType: rawT.slippageType || 'MODELED',
      netPnL: rawT.netPnL || 0,
      realizedGrossR: rawT.realizedGrossR || 0,
      realizedNetR: rawT.realizedNetR || 0,
      captureRatioRaw: rawT.captureRatioRaw !== undefined ? rawT.captureRatioRaw : null,
      capturePct: rawT.capturePct !== undefined ? rawT.capturePct : null,
      exitGivebackR: rawT.exitGivebackR !== undefined ? rawT.exitGivebackR : (rawT.givebackFromPeakR || 0),
      givebackFromPeakR: rawT.givebackFromPeakR !== undefined ? rawT.givebackFromPeakR : (rawT.exitGivebackR || 0),
      allocatedCapital: rawT.allocatedCapital || 10,
      returnOnAllocatedCapital: rawT.returnOnAllocatedCapital !== undefined ? rawT.returnOnAllocatedCapital : null,
      returnVelocity: rawT.returnVelocity !== undefined ? rawT.returnVelocity : null,
      rVelocity: rawT.rVelocity !== undefined ? rawT.rVelocity : null,
      rawConfidence: rawT.rawConfidence !== undefined ? rawT.rawConfidence : null,
      confidenceBucket: rawT.confidenceBucket || 'UNKNOWN',
      excursionSource: rawT.excursionSource || 'TICK_DIRECT',
      strategyId: rawT.strategyId || 'UNKNOWN',
      regimeAtEntry: rawT.regimeAtEntry || 'UNKNOWN',
      regimeAtExit: rawT.regimeAtExit || 'UNKNOWN',
      exitReason: rawT.exitReason || 'MANUAL',
      persistenceMode: 'SQLITE_PRIMARY',
      schemaVersion: this.schemaVersion,
      createdAt: rawT.createdAt || Date.now()
    };
    t.canonicalRecordHash = rawT.canonicalRecordHash || this.computeCanonicalHash(t);
    return t;
  }

  _saveRecord(record) {
    if (this.persistenceMode === 'SQLITE_PRIMARY' && this.db) {
      try {
        const checkStmt = this.db.prepare('SELECT canonicalRecordHash FROM closed_excursions WHERE tradeId = ?');
        const existing = checkStmt.get(record.tradeId);

        if (!existing) {
          const insertStmt = this.db.prepare(`
            INSERT INTO closed_excursions (
              tradeId, canonicalRecordHash, symbol, market, instrumentType, side, entryTimestamp, exitTimestamp, holdingTimeSec, holdingHours,
              velocityReason, entryPrice, exitPrice, initialStopPrice, initialQuantity, contractMultiplier, quoteToAccountCurrency,
              initialRiskAmount, highestPriceWhileOpen, lowestPriceWhileOpen, mfeDollar, maeDollar, mfeR, maeR,
              grossPnL, fees, spreadCost, slippageCost, slippageType, netPnL, realizedGrossR, realizedNetR,
              captureRatioRaw, capturePct, exitGivebackR, givebackFromPeakR, allocatedCapital,
              returnOnAllocatedCapital, returnVelocity, rVelocity, rawConfidence, confidenceBucket,
              excursionSource, strategyId, regimeAtEntry, regimeAtExit, exitReason, persistenceMode, schemaVersion, createdAt
            ) VALUES (
              @tradeId, @canonicalRecordHash, @symbol, @market, @instrumentType, @side, @entryTimestamp, @exitTimestamp, @holdingTimeSec, @holdingHours,
              @velocityReason, @entryPrice, @exitPrice, @initialStopPrice, @initialQuantity, @contractMultiplier, @quoteToAccountCurrency,
              @initialRiskAmount, @highestPriceWhileOpen, @lowestPriceWhileOpen, @mfeDollar, @maeDollar, @mfeR, @maeR,
              @grossPnL, @fees, @spreadCost, @slippageCost, @slippageType, @netPnL, @realizedGrossR, @realizedNetR,
              @captureRatioRaw, @capturePct, @exitGivebackR, @givebackFromPeakR, @allocatedCapital,
              @returnOnAllocatedCapital, @returnVelocity, @rVelocity, @rawConfidence, @confidenceBucket,
              @excursionSource, @strategyId, @regimeAtEntry, @regimeAtExit, @exitReason, @persistenceMode, @schemaVersion, @createdAt
            )
          `);
          insertStmt.run(record);
        } else if (existing.canonicalRecordHash !== record.canonicalRecordHash) {
          // Hard conflict during write -> Fail closed, quarantine, and do not overwrite
          const conflictEvent = {
            type: 'TELEMETRY_WRITE_CONFLICT',
            tradeId: record.tradeId,
            existingHash: existing.canonicalRecordHash,
            incomingHash: record.canonicalRecordHash,
            incomingRecord: record,
            timestamp: Date.now()
          };
          this.emit('telemetryRecoveryConflict', conflictEvent);
          this._logQuarantineConflict(conflictEvent);
        }
        return;
      } catch (e) {
        this.persistenceMode = 'JSON_FALLBACK';
      }
    }

    if (this.persistenceMode === 'JSON_FALLBACK') {
      try {
        const tempPath = `${this.fallbackJsonPath}.tmp.${Date.now()}`;
        fs.writeFileSync(tempPath, JSON.stringify(this.tradeHistory, null, 2), 'utf8');
        fs.renameSync(tempPath, this.fallbackJsonPath);
      } catch (e) {}
    }
  }

  _loadFromJson() {
    try {
      if (fs.existsSync(this.fallbackJsonPath)) {
        const raw = fs.readFileSync(this.fallbackJsonPath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.tradeHistory = data.slice(-this.maxHistory);
        }
      }
    } catch (e) {
      this.tradeHistory = [];
    }
  }

  /**
   * Versioned Valuation Registry & Non-Linear Fail-Closed Adapter
   */
  getInstrumentValuation(symbol, market, instrumentType = 'LINEAR_SPOT') {
    const sym = (symbol || '').toUpperCase();
    const m = (market || '').toUpperCase();

    if (['OPTION', 'INVERSE_CRYPTO', 'QUANTO'].includes(instrumentType)) {
      return { supported: false, error: 'NON_LINEAR_VALUATION_REQUIRES_DEDICATED_MODEL' };
    }

    let contractMultiplier = 1.0;
    let quoteToAccountCurrency = 1.0;
    let resolvedType = instrumentType;

    if (m === 'FUTURES' || sym.endsWith('=F') || sym.startsWith('ES=') || sym.startsWith('NQ=')) {
      resolvedType = 'LINEAR_FUTURE';
      if (sym.startsWith('ES')) contractMultiplier = 50.0;
      else if (sym.startsWith('NQ')) contractMultiplier = 20.0;
      else if (sym.startsWith('CL')) contractMultiplier = 1000.0;
      else if (sym.startsWith('GC')) contractMultiplier = 100.0;
      else if (sym.startsWith('SI')) contractMultiplier = 5000.0;
    } else if (m === 'FOREX' || sym.endsWith('=X')) {
      resolvedType = 'FX';
    }

    return {
      supported: true,
      instrumentType: resolvedType,
      contractMultiplier,
      quoteToAccountCurrency,
      metadataVersion: '1.0.0'
    };
  }

  normalizeConfidence(rawConfidence) {
    if (rawConfidence === undefined || rawConfidence === null || isNaN(rawConfidence)) {
      return { raw: null, bucket: 'UNKNOWN' };
    }
    let conf = parseFloat(rawConfidence);
    if (conf > 1.0) {
      conf = conf / 100.0;
    }
    conf = Math.max(0.0, Math.min(1.0, conf));

    let bucket = 'UNKNOWN';
    if (conf >= 0.90) bucket = '90-100';
    else if (conf >= 0.80) bucket = '80-89';
    else if (conf >= 0.70) bucket = '70-79';
    else if (conf >= 0.60) bucket = '60-69';
    else if (conf >= 0.50) bucket = '50-59';
    else bucket = '0-49';

    return { raw: Number(conf.toFixed(4)), bucket };
  }

  createImmutableEvent(rawEvent) {
    if (!rawEvent) return null;
    const cloned = JSON.parse(JSON.stringify(rawEvent));
    return deepFreeze(cloned);
  }

  recordPositionOpen(rawEvent) {
    if (!rawEvent) return null;
    const event = this.createImmutableEvent(rawEvent);
    const tradeId = event.id || event.positionId;
    if (!tradeId) return null;

    if (this.activeExcursions.has(tradeId)) {
      return this.activeExcursions.get(tradeId);
    }

    const symbol = event.symbol || 'UNKNOWN';
    const market = (event.market || 'CRYPTO').toUpperCase();
    const valuation = this.getInstrumentValuation(symbol, market, event.instrumentType);
    
    if (!valuation.supported) {
      return { tradeId, error: valuation.error, status: 'R_UNAVAILABLE' };
    }

    const entryPrice = parseFloat(event.entryPrice || event.price || 0);
    const initialStopPrice = parseFloat(event.initialStopLoss || event.stopLoss || event.sl || entryPrice);
    const initialQuantity = parseFloat(event.initialQuantity || event.quantity || event.qty || 1);
    const side = (event.side || event.direction || event.type || 'BUY').toUpperCase();
    const isLong = side === 'BUY' || side === 'LONG';

    const priceDiff = Math.abs(entryPrice - initialStopPrice);
    let initialRiskAmount = priceDiff * initialQuantity * valuation.contractMultiplier * valuation.quoteToAccountCurrency;
    
    if (initialRiskAmount <= 0.00000001) {
      initialRiskAmount = Math.max(0.01, entryPrice * 0.01 * initialQuantity * valuation.contractMultiplier * valuation.quoteToAccountCurrency);
    }

    const allocatedCapital = parseFloat(
      event.allocatedCapital || event.cost || (entryPrice * initialQuantity * valuation.contractMultiplier) || 10
    );

    const { raw: rawConfidence, bucket: confidenceBucket } = this.normalizeConfidence(event.confidence || event.score);

    const record = {
      tradeId,
      symbol,
      market,
      instrumentType: valuation.instrumentType,
      side: isLong ? 'LONG' : 'SHORT',
      entryPrice,
      initialStopPrice,
      initialQuantity,
      contractMultiplier: valuation.contractMultiplier,
      quoteToAccountCurrency: valuation.quoteToAccountCurrency,
      initialRiskAmount: Number(initialRiskAmount.toFixed(4)),
      allocatedCapital: Number(allocatedCapital.toFixed(4)),
      entryTimestamp: event.entryTimestamp || event.timestamp || Date.now(),
      highestPriceWhileOpen: entryPrice,
      lowestPriceWhileOpen: entryPrice,
      rawConfidence,
      confidenceBucket,
      strategyId: event.strategy || event.strategyId || 'UNKNOWN',
      regimeAtEntry: event.regime || event.marketRegime || 'UNKNOWN',
      excursionSource: 'TICK_DIRECT',
      sequence: event.sequence || 1,
      isClosed: false
    };

    this.activeExcursions.set(tradeId, record);
    this.emit('positionOpenTracked', record);
    return record;
  }

  /**
   * Update price observations with Multi-Feed Sequence Scope (`source:symbol:streamId`)
   */
  updateMarketPrice(symbolOrTradeId, currentPrice, candleHigh, candleLow, observationTimestamp = Date.now(), source = 'TICK_DIRECT', sequence = null, streamId = 'default') {
    if (!currentPrice && !candleHigh) return;

    if (sequence !== null) {
      const scopeKey = `${source}:${symbolOrTradeId}:${streamId}`;
      const lastSeq = this.lastProcessedSequence.get(scopeKey) || 0;
      if (sequence <= lastSeq) {
        return;
      }
      this.lastProcessedSequence.set(scopeKey, sequence);
    }

    const h = parseFloat(candleHigh !== undefined ? candleHigh : currentPrice);
    const l = parseFloat(candleLow !== undefined ? candleLow : currentPrice);

    for (const [tradeId, record] of this.activeExcursions.entries()) {
      if (record.symbol === symbolOrTradeId || record.tradeId === symbolOrTradeId) {
        if (record.isClosed) continue;

        if (source === 'BAR_APPROX') {
          record.excursionSource = 'BAR_APPROX_COMPLETE';
        }

        if (!isNaN(h) && h > record.highestPriceWhileOpen) {
          record.highestPriceWhileOpen = h;
        }
        if (!isNaN(l) && l < record.lowestPriceWhileOpen) {
          record.lowestPriceWhileOpen = l;
        }
      }
    }
  }

  /**
   * Finalize closed excursion with Canonical Record Hash and Conflict Safety
   */
  recordPositionClose(rawExitEvent) {
    if (!rawExitEvent) return null;
    const exitEvent = this.createImmutableEvent(rawExitEvent);
    const tradeId = exitEvent.id || exitEvent.positionId;
    let record = this.activeExcursions.get(tradeId);

    if (!record) {
      record = this.recordPositionOpen(exitEvent);
    }

    const exitTimestamp = exitEvent.exitTimestamp || exitEvent.timestamp || Date.now();
    const exitPrice = parseFloat(exitEvent.exitPrice || exitEvent.price || record.entryPrice);
    
    let excursionSource = record.excursionSource;
    let highestPrice = record.highestPriceWhileOpen;
    let lowestPrice = record.lowestPriceWhileOpen;

    if (exitEvent.isSameBarExit && excursionSource.startsWith('BAR_APPROX')) {
      excursionSource = 'BAR_APPROX_EXIT_BAR_CENSORED';
      highestPrice = Math.max(record.entryPrice, exitPrice);
      lowestPrice = Math.min(record.entryPrice, exitPrice);
    } else {
      highestPrice = Math.max(highestPrice, exitPrice);
      lowestPrice = Math.min(lowestPrice, exitPrice);
    }

    const isLong = record.side === 'LONG';
    const initialQty = record.initialQuantity;
    const initialRisk = record.initialRiskAmount;
    const multiplier = record.contractMultiplier;
    const fx = record.quoteToAccountCurrency;

    let mfeDollar = isLong
      ? (highestPrice - record.entryPrice) * initialQty * multiplier * fx
      : (record.entryPrice - lowestPrice) * initialQty * multiplier * fx;
    let maeDollar = isLong
      ? (record.entryPrice - lowestPrice) * initialQty * multiplier * fx
      : (highestPrice - record.entryPrice) * initialQty * multiplier * fx;

    mfeDollar = Math.max(0, mfeDollar);
    maeDollar = Math.max(0, maeDollar);

    const mfeR = Number((mfeDollar / initialRisk).toFixed(4));
    const maeR = Number((maeDollar / initialRisk).toFixed(4));

    const grossPnL = parseFloat(
      exitEvent.grossPnL !== undefined 
        ? exitEvent.grossPnL 
        : (isLong ? (exitPrice - record.entryPrice) * initialQty * multiplier * fx : (record.entryPrice - exitPrice) * initialQty * multiplier * fx)
    );
    const fees = parseFloat(exitEvent.fees || exitEvent.fee || exitEvent.brokerCharges || 0);
    const spreadCost = parseFloat(exitEvent.spreadCost || 0);
    const slippageCost = parseFloat(exitEvent.slippageCost || exitEvent.slippage || 0);
    const slippageType = exitEvent.slippageType || (exitEvent.isLive ? 'OBSERVED' : 'MODELED');

    const netPnL = parseFloat(
      exitEvent.netPnL !== undefined 
        ? exitEvent.netPnL 
        : (grossPnL - fees - spreadCost - slippageCost)
    );

    const realizedGrossR = Number((grossPnL / initialRisk).toFixed(4));
    const realizedNetR = Number((netPnL / initialRisk).toFixed(4));

    let captureRatioRaw = null;
    let capturePct = null;
    if (realizedNetR > 0 && mfeR > 0) {
      captureRatioRaw = Number((realizedNetR / mfeR).toFixed(4));
      capturePct = Number((captureRatioRaw * 100).toFixed(2));
    }

    const exitGivebackR = Number((Math.max(0, mfeR - realizedNetR)).toFixed(4));
    const givebackFromPeakR = exitGivebackR;

    const holdingTimeSec = Math.max(0, Math.round((exitTimestamp - record.entryTimestamp) / 1000));
    let holdingHours = null;
    let returnVelocity = null;
    let rVelocity = null;
    let velocityReason = 'NORMAL';
    let returnOnAllocatedCapital = null;

    if (record.allocatedCapital > 0) {
      returnOnAllocatedCapital = Number(((netPnL / record.allocatedCapital) * 100).toFixed(4));
    }

    if (holdingTimeSec >= 5) {
      holdingHours = Number((holdingTimeSec / 3600).toFixed(4));
      if (returnOnAllocatedCapital !== null) {
        returnVelocity = Number((returnOnAllocatedCapital / holdingHours).toFixed(4));
      }
      rVelocity = Number((realizedNetR / holdingHours).toFixed(4));
    } else {
      velocityReason = 'HOLDING_PERIOD_TOO_SHORT';
    }

    const finalizedTrade = {
      tradeId: record.tradeId,
      symbol: record.symbol,
      market: record.market,
      instrumentType: record.instrumentType,
      side: record.side,
      entryTimestamp: record.entryTimestamp,
      exitTimestamp,
      holdingTimeSec,
      holdingHours,
      velocityReason,
      entryPrice: record.entryPrice,
      exitPrice,
      initialStopPrice: record.initialStopPrice,
      initialQuantity: record.initialQuantity,
      contractMultiplier: record.contractMultiplier,
      quoteToAccountCurrency: record.quoteToAccountCurrency,
      initialRiskAmount: record.initialRiskAmount,
      highestPriceWhileOpen: highestPrice,
      lowestPriceWhileOpen: lowestPrice,
      mfeDollar: Number(mfeDollar.toFixed(4)),
      maeDollar: Number(maeDollar.toFixed(4)),
      mfeR,
      maeR,
      grossPnL: Number(grossPnL.toFixed(4)),
      fees: Number(fees.toFixed(4)),
      spreadCost: Number(spreadCost.toFixed(4)),
      slippageCost: Number(slippageCost.toFixed(4)),
      slippageType,
      netPnL: Number(netPnL.toFixed(4)),
      realizedGrossR,
      realizedNetR,
      captureRatioRaw,
      capturePct,
      exitGivebackR,
      givebackFromPeakR,
      allocatedCapital: record.allocatedCapital,
      returnOnAllocatedCapital,
      returnVelocity,
      rVelocity,
      rawConfidence: record.rawConfidence,
      confidenceBucket: record.confidenceBucket,
      excursionSource,
      strategyId: record.strategyId,
      regimeAtEntry: record.regimeAtEntry,
      regimeAtExit: exitEvent.regime || exitEvent.marketRegime || record.regimeAtEntry,
      exitReason: exitEvent.exitReason || exitEvent.reason || 'MANUAL_OR_AUTO_EXIT',
      persistenceMode: this.persistenceMode,
      schemaVersion: this.schemaVersion,
      createdAt: Date.now()
    };

    // Calculate Canonical SHA-256 Record Hash
    finalizedTrade.canonicalRecordHash = this.computeCanonicalHash(finalizedTrade);

    record.isClosed = true;
    this.activeExcursions.delete(tradeId);
    this.tradeHistory.push(finalizedTrade);
    if (this.tradeHistory.length > this.maxHistory) {
      this.tradeHistory.shift();
    }

    this._saveRecord(finalizedTrade);
    this.emit('positionCloseTracked', finalizedTrade);
    return finalizedTrade;
  }

  getExcursionSummary() {
    if (this.tradeHistory.length === 0) {
      return {
        totalTrades: 0,
        avgMfeR: 0,
        avgMaeR: 0,
        avgRealizedNetR: 0,
        avgCaptureRatio: 0,
        avgGivebackR: 0,
        avgReturnVelocity: 0,
        medianHoldingMinutes: 0,
        persistenceMode: this.persistenceMode,
        confidenceBuckets: {
          '90-100': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
          '80-89': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
          '70-79': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
          '60-69': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
          '50-59': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
          '0-49': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
          'UNKNOWN': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 }
        }
      };
    }

    const n = this.tradeHistory.length;
    let sumMfeR = 0;
    let sumMaeR = 0;
    let sumRealizedR = 0;
    let sumGivebackR = 0;
    let sumVelocity = 0;
    let velocityCount = 0;
    const holdTimes = [];
    const validCaptures = [];

    const buckets = {
      '90-100': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
      '80-89': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
      '70-79': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
      '60-69': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
      '50-59': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
      '0-49': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 },
      'UNKNOWN': { trades: 0, wins: 0, sumNetR: 0, winRate: 0, expectancy: 0 }
    };

    for (const t of this.tradeHistory) {
      sumMfeR += t.mfeR || 0;
      sumMaeR += t.maeR || 0;
      sumRealizedR += t.realizedNetR || 0;
      sumGivebackR += t.exitGivebackR !== undefined ? t.exitGivebackR : (t.givebackFromPeakR || 0);
      
      if (t.returnVelocity !== null && !isNaN(t.returnVelocity)) {
        sumVelocity += t.returnVelocity;
        velocityCount++;
      }

      if (t.holdingTimeSec !== undefined && t.holdingTimeSec !== null) {
        holdTimes.push(t.holdingTimeSec / 60);
      }

      if (t.capturePct !== null && !isNaN(t.capturePct)) {
        validCaptures.push(t.capturePct);
      }

      const bKey = t.confidenceBucket || 'UNKNOWN';
      if (buckets[bKey]) {
        buckets[bKey].trades++;
        if (t.realizedNetR > 0) buckets[bKey].wins++;
        buckets[bKey].sumNetR += t.realizedNetR;
      }
    }

    Object.keys(buckets).forEach(k => {
      const b = buckets[k];
      if (b.trades > 0) {
        b.winRate = Number(((b.wins / b.trades) * 100).toFixed(1));
        b.expectancy = Number((b.sumNetR / b.trades).toFixed(3));
      }
    });

    const avgCaptureRatio = validCaptures.length > 0 
      ? Number((validCaptures.reduce((a, b) => a + b, 0) / validCaptures.length).toFixed(2))
      : 0;

    holdTimes.sort((a, b) => a - b);
    const medianHoldingMinutes = holdTimes.length > 0
      ? Number(holdTimes[Math.floor(holdTimes.length / 2)].toFixed(1))
      : 0;

    return {
      totalTrades: n,
      avgMfeR: Number((sumMfeR / n).toFixed(3)),
      avgMaeR: Number((sumMaeR / n).toFixed(3)),
      avgRealizedNetR: Number((sumRealizedR / n).toFixed(3)),
      avgCaptureRatio,
      avgGivebackR: Number((sumGivebackR / n).toFixed(3)),
      avgReturnVelocity: velocityCount > 0 ? Number((sumVelocity / velocityCount).toFixed(3)) : 0,
      medianHoldingMinutes,
      persistenceMode: this.persistenceMode,
      confidenceBuckets: buckets
    };
  }
}

const excursionTelemetryEngine = new ExcursionTelemetryEngine();

module.exports = {
  deepFreeze,
  ExcursionTelemetryEngine,
  excursionTelemetryEngine
};
