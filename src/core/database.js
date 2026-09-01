const path = require('path');
const fs = require('fs');
const config = require('../config');
const { Pool } = require('pg');
let sqlite3 = null;

try {
  sqlite3 = require('sqlite3').verbose();
} catch (e) {}

let pool = null;
let sqliteDb = null;
let dbEngine = 'memory'; // 'postgres', 'sqlite', or 'memory'
let dbInitPromise = null;

// Ensure data folder exists for SQLite storage
const dataDir = path.resolve(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const sqlitePath = path.join(dataDir, 'trading_brain.db');

// In-memory fallback structure
const memoryStore = {
  trades: [],
  signals: [],
  dailyPnl: [],
  positions: [],
  marketData: [],
  learningRecords: [],
  preMarketBriefings: []
};

// Initialize SQLite Schema
const initSqliteSchema = (db) => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Enable WAL mode for high-concurrency and speed
      db.run('PRAGMA journal_mode = WAL;');
      db.run('PRAGMA synchronous = NORMAL;');

      // Trades table
      db.run(`
        CREATE TABLE IF NOT EXISTS trades (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          exchange TEXT NOT NULL,
          segment TEXT NOT NULL,
          side TEXT NOT NULL,
          quantity REAL NOT NULL,
          entry_price REAL NOT NULL,
          exit_price REAL,
          stop_loss REAL,
          take_profit REAL,
          status TEXT DEFAULT 'open',
          pnl REAL DEFAULT 0,
          pnl_pct REAL DEFAULT 0,
          strategy TEXT,
          signal_id TEXT,
          opened_at TEXT DEFAULT (datetime('now')),
          closed_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Signals table
      db.run(`
        CREATE TABLE IF NOT EXISTS signals (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          exchange TEXT NOT NULL,
          segment TEXT NOT NULL,
          signal_type TEXT NOT NULL,
          direction TEXT NOT NULL,
          strength REAL,
          entry_price REAL,
          stop_loss REAL,
          take_profit REAL,
          indicators TEXT,
          metadata TEXT,
          executed INTEGER DEFAULT 0,
          trade_id TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Daily P&L table
      db.run(`
        CREATE TABLE IF NOT EXISTS daily_pnl (
          id TEXT PRIMARY KEY,
          date TEXT UNIQUE NOT NULL,
          starting_capital REAL NOT NULL,
          ending_capital REAL NOT NULL,
          realized_pnl REAL DEFAULT 0,
          unrealized_pnl REAL DEFAULT 0,
          total_trades INTEGER DEFAULT 0,
          winning_trades INTEGER DEFAULT 0,
          losing_trades INTEGER DEFAULT 0,
          max_drawdown REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Positions table
      db.run(`
        CREATE TABLE IF NOT EXISTS positions (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          exchange TEXT NOT NULL,
          segment TEXT NOT NULL,
          side TEXT NOT NULL,
          quantity REAL NOT NULL,
          avg_price REAL NOT NULL,
          current_price REAL,
          unrealized_pnl REAL DEFAULT 0,
          realized_pnl REAL DEFAULT 0,
          strategy TEXT,
          opened_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Market data table
      db.run(`
        CREATE TABLE IF NOT EXISTS market_data (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          exchange TEXT NOT NULL,
          segment TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          open REAL,
          high REAL,
          low REAL,
          close REAL,
          volume REAL,
          oi REAL,
          interval TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(symbol, exchange, segment, timestamp, interval)
        )
      `);

      // Pre-market briefings
      db.run(`
        CREATE TABLE IF NOT EXISTS pre_market_briefings (
          id TEXT PRIMARY KEY,
          date TEXT UNIQUE NOT NULL,
          briefing TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Learning records
      db.run(`
        CREATE TABLE IF NOT EXISTS learning_records (
          id TEXT PRIMARY KEY,
          date TEXT UNIQUE NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Execution fills idempotency table (Database Source of Truth)
      db.run(`
        CREATE TABLE IF NOT EXISTS execution_fills (
          fill_id TEXT PRIMARY KEY,
          client_order_id TEXT,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          quantity REAL NOT NULL,
          price REAL NOT NULL,
          strategy TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
};

// Initialize Primary Database Engine (Postgres -> SQLite -> In-Memory)
const initDatabaseEngine = async () => {
  // 1. Check if remote PostgreSQL is configured
  if (config.database?.host && config.database.host !== 'localhost' && config.database.host !== '127.0.0.1') {
    try {
      pool = new Pool({
        host: config.database.host,
        port: config.database.port,
        database: config.database.name,
        user: config.database.user,
        password: config.database.password,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000
      });
      dbEngine = 'postgres';
      console.log('🐘 PostgreSQL Database engine configured');
      return;
    } catch (e) {}
  }

  // 2. Default to Blazing-Fast Embedded SQLite Database
  if (sqlite3) {
    try {
      await new Promise((resolve, reject) => {
        sqliteDb = new sqlite3.Database(sqlitePath, (err) => {
          if (err) {
            console.warn('⚠️ SQLite initialization failed, falling back to in-memory store:', err.message);
            dbEngine = 'memory';
            reject(err);
          } else {
            dbEngine = 'sqlite';
            console.log(`📁 Embedded SQLite database initialized at ${sqlitePath}`);
            resolve();
          }
        });
      });
      
      // Initialize schema
      await initSqliteSchema(sqliteDb);
      return;
    } catch (e) {
      console.warn('SQLite init error:', e.message);
    }
  }

  // 3. Fallback to Memory Store
  dbEngine = 'memory';
  console.log('💾 Database using in-memory store');
};

// Start initialization immediately
dbInitPromise = initDatabaseEngine();

// Universal Query Interface - waits for DB init before executing
const query = async (text, params = []) => {
  // Wait for database initialization to complete
  if (dbInitPromise) {
    await dbInitPromise;
  }
  
  const start = Date.now();

  // Handle SQLite Queries
  if (dbEngine === 'sqlite' && sqliteDb) {
    return new Promise((resolve) => {
      // Map Postgres syntax placeholders ($1, $2) to SQLite (?)
      let sql = text.replace(/\$\d+/g, '?');
      sql = sql.replace(/NOW\(\)/gi, "datetime('now')");
      sql = sql.replace(/gen_random_uuid\(\)/gi, "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))");

      // Handle JSON stringification for SQLite text fields if needed
      const safeParams = (params || []).map(p => typeof p === 'object' && p !== null ? JSON.stringify(p) : p);

      const trimmedSql = sql.trim().toUpperCase();
      if (trimmedSql.startsWith('SELECT')) {
        sqliteDb.all(sql, safeParams, (err, rows) => {
          if (err) {
            resolve({ rows: [], rowCount: 0, duration: Date.now() - start, error: err.message });
          } else {
            resolve({ rows: rows || [], rowCount: rows ? rows.length : 0, duration: Date.now() - start });
          }
        });
      } else {
        sqliteDb.run(sql, safeParams, function(err) {
          if (err) {
            resolve({ rows: [], rowCount: 0, duration: Date.now() - start, error: err.message });
          } else {
            resolve({ rows: [], rowCount: this.changes || 0, lastID: this.lastID, duration: Date.now() - start });
          }
        });
      }
    });
  }

  // Handle PostgreSQL Queries
  if (dbEngine === 'postgres' && pool) {
    try {
      const res = await pool.query(text, params);
      return { rows: res.rows, rowCount: res.rowCount, duration: Date.now() - start };
    } catch (err) {
      return { rows: [], rowCount: 0, duration: Date.now() - start, error: err.message };
    }
  }

  // In-Memory Simulated Query
  return { rows: [], rowCount: 0, duration: 0 };
};

const getClient = async () => {
  if (dbInitPromise) {
    await dbInitPromise;
  }
  
  if (dbEngine === 'postgres' && pool) {
    return await pool.connect();
  }
  return {
    query,
    release: () => {}
  };
};

const initDatabase = async () => {
  if (dbInitPromise) {
    await dbInitPromise;
  }
  
  if (dbEngine === 'sqlite' && sqliteDb) {
    await initSqliteSchema(sqliteDb);
    console.log('✅ SQLite database schema verified and indexed');
  } else if (dbEngine === 'postgres' && pool) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS execution_fills (
          fill_id TEXT PRIMARY KEY,
          client_order_id TEXT,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          quantity DOUBLE PRECISION NOT NULL,
          price DOUBLE PRECISION NOT NULL,
          strategy TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('✅ PostgreSQL execution_fills table verified and indexed');
    } catch (e) {
      console.warn('⚠️ PostgreSQL execution_fills migration notice:', e.message);
    }
  }
};

module.exports = {
  pool: () => pool,
  sqliteDb: () => sqliteDb,
  query,
  getClient,
  initDatabase,
  memoryStore,
  getEngine: () => dbEngine,
  isUsingDatabase: () => dbEngine !== 'memory'
};