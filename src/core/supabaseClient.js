// Ensure global WebSocket is available for Node 20 environments before @supabase/supabase-js
if (typeof global.WebSocket === 'undefined') {
  try {
    global.WebSocket = require('ws');
  } catch (_) {}
}

const { createClient } = require('@supabase/supabase-js');
const { createAgentLogger } = require('./logger');
const sessionStateStore = require('./sessionStateStore');
const riskManager = require('../agents/risk/riskManager');

const logger = createAgentLogger('SupabaseClient');

/**
 * Resilient Supabase Client with graceful offline fallback
 * Enhanced with real-time sync, conflict resolution, and state persistence
 */
class SupabaseService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null;
    this.key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
    this.serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
    this.realtimeChannel = null;
    this.syncQueue = [];
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.conflictResolution = 'SERVER_WINS'; // 'SERVER_WINS', 'LOCAL_WINS', 'MERGE'
    this.init();
    this.getClient = this.getClient.bind(this);
    this.getStatus = this.getStatus.bind(this);
  }

  init() {
    if (this.url && this.key && this.url.startsWith('https://')) {
      try {
        this.client = createClient(this.url, this.key, {
          auth: { persistSession: false },
          realtime: { params: { eventsPerSecond: 10 } },
          db: { schema: 'public' }
        });
        this.isConnected = true;
        this._initRealtimeSync();
        logger.info(`☁️ [Supabase Cloud] Connected to remote instance: ${this.url.split('.')[0]}.supabase.co`);
      } catch (err) {
        logger.warn(`⚠️ [Supabase Cloud] Failed to initialize client: ${err.message}. Using local SQLite.`);
        this.isConnected = false;
      }
    } else {
      logger.info('ℹ️ [Supabase Cloud] SUPABASE_URL / SUPABASE_ANON_KEY not configured. Running in local SQLite mode.');
      this.isConnected = false;
    }
  }

  /**
   * Initialize real-time synchronization channels
   */
  _initRealtimeSync() {
    if (!this.client) return;

    try {
      this.realtimeChannel = this.client.channel('trading_brain_sync');
      
      // Subscribe to portfolio state changes
      this.realtimeChannel
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'portfolio_state'
        }, (payload) => this._handleRemoteChange(payload))
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'positions'
        }, (payload) => this._handleRemoteChange(payload))
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'trades'
        }, (payload) => this._handleRemoteChange(payload))
        .on('broadcast', { event: 'state_snapshot' }, (payload) => this._handleBroadcast(payload))
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            logger.info(`🌐 [Supabase Real-Time] Subscribed to portfolio, positions, trades changes`);
            this._processSyncQueue();
          }
        });
    } catch (err) {
      logger.warn('Real-time sync init error:', { error: err.message });
    }
  }

  /**
   * Handle remote database changes
   */
  async _handleRemoteChange(payload) {
    const { eventType, new: newRecord, old: oldRecord, table } = payload;
    
    try {
      if (table === 'portfolio_state') {
        await this._syncPortfolioState(newRecord, oldRecord, eventType);
      } else if (table === 'positions') {
        await this._syncPosition(newRecord, oldRecord, eventType);
      } else if (table === 'trades') {
        await this._syncTrade(newRecord, oldRecord, eventType);
      }
    } catch (err) {
      logger.warn('Remote change handling error:', { error: err.message, table });
    }
  }

  /**
   * Handle broadcast messages from other nodes
   */
  async _handleBroadcast(payload) {
    if (payload.payload?.compoundedEquity) {
      const sessionStateStore = require('./sessionStateStore');
      sessionStateStore.saveState({
        compoundedEquity: payload.payload.compoundedEquity,
        realizedPnL: payload.payload.dailyPnL,
        positions: payload.payload.positions?.reduce((acc, p) => ({ ...acc, [p.symbol]: p }), {})
      });
      logger.info(`☁️ [Supabase Sync] Hydrated local state from cloud broadcast`);
    }
  }

  /**
   * Sync portfolio state from remote
   */
  async _syncPortfolioState(newRecord, oldRecord, eventType) {
    if (!newRecord) return;
    
    const sessionStateStore = require('./sessionStateStore');
    const localState = sessionStateStore.getState();
    
    // Conflict resolution
    const serverEquity = parseFloat(newRecord.compounded_equity) || 0;
    const localEquity = localState.compoundedEquity || 0;
    
    let resolvedEquity = localEquity;
    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      if (this.conflictResolution === 'SERVER_WINS') {
        resolvedEquity = serverEquity;
      } else if (this.conflictResolution === 'MERGE') {
        resolvedEquity = Math.max(localEquity, serverEquity);
      } else if (this.conflictResolution === 'LOCAL_WINS') {
        resolvedEquity = localEquity;
      }
      
      if (resolvedEquity !== localEquity) {
        sessionStateStore.saveState({
          compoundedEquity: resolvedEquity,
          realizedPnL: parseFloat(newRecord.realized_pnl) || 0,
          dailyPnL: parseFloat(newRecord.daily_pnl) || 0
        });
        logger.info(`☁️ [Supabase Sync] Portfolio state synced: $${resolvedEquity.toLocaleString()}`);
      }
    }
  }

  /**
   * Sync position from remote
   */
  async _syncPosition(newRecord, oldRecord, eventType) {
    const riskManager = require('../agents/risk/riskManager');
    
    if (eventType === 'DELETE') {
      // Position closed remotely
      riskManager.openPositions.delete(oldRecord.symbol);
      logger.info(`☁️ [Supabase Sync] Position removed: ${oldRecord.symbol}`);
    } else if (newRecord) {
      // Upsert position
      const symbol = newRecord.symbol;
      const existing = riskManager.openPositions.get(symbol);
      
      const serverQty = parseInt(newRecord.quantity) || 0;
      const serverAvg = parseFloat(newRecord.avg_price) || 0;
      
      if (eventType === 'INSERT' || !existing) {
        // New position from remote
        riskManager.openPositions.set(symbol, {
          symbol,
          side: newRecord.side || 'LONG',
          quantity: serverQty,
          avgPrice: serverAvg,
          avg_price: serverAvg,
          entryPrice: serverAvg,
          entry_price: serverAvg,
          currentPrice: parseFloat(newRecord.current_price) || serverAvg,
          current_price: parseFloat(newRecord.current_price) || serverAvg,
          unrealizedPnL: parseFloat(newRecord.unrealized_pnl) || 0,
          unrealized_pnl: parseFloat(newRecord.unrealized_pnl) || 0,
          pnl_pct: parseFloat(newRecord.pnl_pct) || 0,
          strategy: newRecord.strategy || 'REMOTE_SYNC',
          stopLoss: newRecord.stop_loss || null,
          stop_loss: newRecord.stop_loss || null,
          takeProfit: newRecord.take_profit || null,
          take_profit: newRecord.take_profit || null,
          opened_at: newRecord.opened_at || new Date().toISOString()
        });
        logger.info(`☁️ [Supabase Sync] New position synced: ${symbol} ${serverQty}`);
      } else if (eventType === 'UPDATE') {
        // Conflict resolution for quantity
        let resolvedQty = existing.quantity;
        if (this.conflictResolution === 'SERVER_WINS') {
          resolvedQty = serverQty;
        } else if (this.conflictResolution === 'MERGE') {
          resolvedQty = Math.max(existing.quantity, serverQty);
        }
        
        if (resolvedQty !== existing.quantity) {
          existing.quantity = resolvedQty;
          existing.avgPrice = parseFloat(newRecord.avg_price) || existing.avgPrice;
          existing.avg_price = existing.avgPrice;
          existing.currentPrice = parseFloat(newRecord.current_price) || existing.currentPrice;
          existing.current_price = existing.currentPrice;
          existing.unrealizedPnL = parseFloat(newRecord.unrealized_pnl) || 0;
          existing.unrealized_pnl = existing.unrealizedPnL;
          existing.pnl_pct = parseFloat(newRecord.pnl_pct) || 0;
          logger.info(`☁️ [Supabase Sync] Position updated: ${newRecord.symbol} qty=${resolvedQty}`);
        }
      }
    }
  }

  /**
   * Sync trade from remote
   */
  async _syncTrade(newRecord, oldRecord, eventType) {
    // Trade sync for audit trail - append to local trade history
    if (eventType === 'INSERT' && newRecord) {
      const executionEngine = require('../agents/execution/executionEngine');
      const trade = {
        ...newRecord,
        id: newRecord.id || `remote_${Date.now()}`,
        synced_from_cloud: true
      };
      executionEngine.tradeHistory.push(trade);
      // Keep history bounded
      if (executionEngine.tradeHistory.length > 1000) {
        executionEngine.tradeHistory = executionEngine.tradeHistory.slice(-1000);
      }
    }
  }

  /**
   * Queue local changes for broadcast
   */
  async broadcastState(stateUpdate = {}) {
    if (!this.isConnected || !this.realtimeChannel) return { success: false, reason: 'Not connected' };

    try {
      const sessionStateStore = require('./sessionStateStore');
      const snapshot = {
        nodeType: 'LOCAL_PUSH',
        timestamp: new Date().toISOString(),
        compoundedEquity: stateUpdate.compoundedEquity || sessionStateStore.getState().compoundedEquity || 100000,
        dailyPnL: stateUpdate.dailyPnL !== undefined ? stateUpdate.dailyPnL : 0,
        positions: stateUpdate.positions || Array.from(require('../agents/risk/riskManager').openPositions.values()),
        debates: stateUpdate.debates || []
      };

      await this.realtimeChannel.send({
        type: 'broadcast',
        event: 'state_snapshot',
        payload: snapshot
      });

      this.lastSyncTime = new Date().toISOString();
      return { success: true, timestamp: this.lastSyncTime };
    } catch (err) {
      logger.warn('Failed to broadcast state:', { error: err.message });
      this._queueForSync(stateUpdate);
      return { success: false, error: err.message };
    }
  }

  /**
   * Queue changes for later sync when reconnected
   */
  _queueForSync(stateUpdate) {
    this.syncQueue.push({
      timestamp: new Date().toISOString(),
      data: stateUpdate
    });
    if (this.syncQueue.length > 100) this.syncQueue.shift();
  }

  /**
   * Process queued syncs when reconnected
   */
  async _processSyncQueue() {
    if (this.isSyncing || this.syncQueue.length === 0) return;
    
    this.isSyncing = true;
    while (this.syncQueue.length > 0) {
      const item = this.syncQueue.shift();
      try {
        await this.broadcastState(item.data);
        await new Promise(r => setTimeout(r, 100)); // Rate limit
      } catch (err) {
        this.syncQueue.unshift(item); // Re-queue on failure
        break;
      }
    }
    this.isSyncing = false;
  }

  /**
   * Push local state to cloud database
   */
  async pushToCloud() {
    if (!this.isConnected || !this.client) return { success: false, reason: 'Not connected' };

    try {
      const sessionStateStore = require('./sessionStateStore');
      const riskManager = require('../agents/risk/riskManager');
      
      // Upsert portfolio state
      const { error: portfolioError } = await this.client
        .from('portfolio_state')
        .upsert({
          id: 'main',
          compounded_equity: sessionStateStore.getState().compoundedEquity || 100000,
          realized_pnl: sessionStateStore.getState().realizedPnL || 0,
          daily_pnl: riskManager.dailyPnL || 0,
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' });

      if (portfolioError) throw portfolioError;

      // Upsert positions
      const positions = Array.from(require('../agents/risk/riskManager').openPositions.values());
      for (const pos of positions) {
        const { error } = await this.client
          .from('positions')
          .upsert({
            symbol: pos.symbol,
            side: pos.side,
            quantity: pos.quantity,
            avg_price: pos.avgPrice || pos.avg_price,
            current_price: pos.currentPrice || pos.current_price,
            unrealized_pnl: pos.unrealizedPnL || pos.unrealized_pnl,
            pnl_pct: pos.pnl_pct,
            strategy: pos.strategy,
            stop_loss: pos.stopLoss || pos.stop_loss,
            take_profit: pos.takeProfit || pos.take_profit,
            updated_at: new Date().toISOString()
          }, { onConflict: 'symbol' });
        
        if (error) throw error;
      }

      this.lastSyncTime = new Date().toISOString();
      logger.info(`☁️ [Supabase Sync] Pushed ${positions.length} positions to cloud`);
      return { success: true, synced: positions.length, timestamp: this.lastSyncTime };
    } catch (err) {
      logger.warn('Cloud push error:', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Pull state from cloud database
   */
  async pullFromCloud() {
    if (!this.isConnected || !this.client) return { success: false, reason: 'Not connected' };

    try {
      // Pull portfolio state
      const { data: portfolio, error: portfolioError } = await this.client
        .from('portfolio_state')
        .select('*')
        .eq('id', 'main')
        .single();

      if (!portfolioError && portfolio) {
        const sessionStateStore = require('./sessionStateStore');
        sessionStateStore.saveState({
          compoundedEquity: portfolio.compounded_equity,
          realizedPnL: portfolio.realized_pnl,
          dailyPnL: portfolio.daily_pnl
        });
      }

      // Pull positions
      const { data: positions, error: posError } = await this.client
        .from('positions')
        .select('*');

      if (!posError && positions) {
        const riskManager = require('../agents/risk/riskManager');
        for (const pos of positions) {
          riskManager.openPositions.set(pos.symbol, {
            symbol: pos.symbol,
            side: pos.side,
            quantity: pos.quantity,
            avgPrice: pos.avg_price,
            avg_price: pos.avg_price,
            entryPrice: pos.avg_price,
            entry_price: pos.avg_price,
            currentPrice: pos.current_price,
            current_price: pos.current_price,
            unrealizedPnL: pos.unrealized_pnl,
            unrealized_pnl: pos.unrealized_pnl,
            pnl_pct: pos.pnl_pct,
            strategy: pos.strategy || 'REMOTE_SYNC',
            stopLoss: pos.stop_loss,
            stop_loss: pos.stop_loss,
            takeProfit: pos.take_profit,
            take_profit: pos.take_profit,
            opened_at: pos.updated_at
          });
        }
        logger.info(`☁️ [Supabase Sync] Pulled ${positions.length} positions from cloud`);
      }

      this.lastSyncTime = new Date().toISOString();
      return { success: true, timestamp: this.lastSyncTime };
    } catch (err) {
      logger.warn('Cloud pull error:', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  getClient() {
    return this.client;
  }

  getStatus() {
    return {
      configured: !!(this.url && this.key),
      connected: this.isConnected,
      url: this.url ? `${this.url.split('.')[0]}.supabase.co` : null,
      mode: this.isConnected ? 'CLOUD_POSTGRES' : 'LOCAL_SQLITE',
      lastSync: this.lastSyncTime,
      queueSize: this.syncQueue.length,
      conflictResolution: this.conflictResolution
    };
  }

  setConflictResolution(strategy) {
    if (['SERVER_WINS', 'LOCAL_WINS', 'MERGE'].includes(strategy)) {
      this.conflictResolution = strategy;
      logger.info(`☁️ [Supabase Sync] Conflict resolution set to: ${strategy}`);
    }
  }
}

module.exports = new SupabaseService();
