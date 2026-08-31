const supabaseService = require('./supabaseClient');
const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('SupabaseSyncEngine');

/**
 * SupabaseSyncEngine - Asynchronously mirrors trades, positions, proof-of-trade blocks, and RL weights to Supabase
 */
class SupabaseSyncEngine {
  constructor() {
    this.client = supabaseService.getClient();
  }

  /**
   * Sync executed trade to Supabase Cloud
   */
  async syncTrade(trade) {
    if (!supabaseService.isConnected || !this.client) return;
    try {
      const payload = {
        id: trade.id || trade.orderId || `trade_${Date.now()}`,
        symbol: trade.symbol,
        market: trade.market || 'CRYPTO',
        direction: trade.direction || (trade.side === 'BUY' ? 'LONG' : 'SHORT'),
        side: trade.side || 'BUY',
        price: parseFloat(trade.price || 0),
        qty: parseFloat(trade.qty || trade.quantity || 0),
        stop_loss: trade.stopLoss ? parseFloat(trade.stopLoss) : null,
        take_profit: trade.takeProfit ? parseFloat(trade.takeProfit) : null,
        pnl: trade.pnl ? parseFloat(trade.pnl) : 0,
        pnl_pct: trade.pnlPct ? parseFloat(trade.pnlPct) : 0,
        status: trade.status || 'COMPLETE',
        strategy: trade.strategy || 'AUTONOMOUS_MESH',
        confidence: trade.confidence ? parseFloat(trade.confidence) : 75.0,
        paper_trading: trade.paperTrading !== undefined ? trade.paperTrading : true,
        metadata: trade.metadata || {},
        created_at: trade.timestamp || new Date().toISOString()
      };

      const { error } = await this.client.from('trades').upsert(payload);
      if (error) throw error;
      logger.info(`☁️ [Supabase Cloud] Trade synced: ${payload.direction} ${payload.symbol} @ ${payload.price}`);
    } catch (err) {
      logger.warn(`⚠️ [Supabase Sync Error] Failed to sync trade: ${err.message}`);
    }
  }

  /**
   * Sync active positions to Supabase Cloud
   */
  async syncPosition(position) {
    if (!supabaseService.isConnected || !this.client) return;
    try {
      const payload = {
        symbol: position.symbol,
        market: position.market || 'CRYPTO',
        side: position.side || (position.direction === 'LONG' ? 'LONG' : 'SHORT'),
        qty: parseFloat(position.qty || 0),
        entry_price: parseFloat(position.entryPrice || position.price || 0),
        current_price: parseFloat(position.currentPrice || position.entryPrice || 0),
        stop_loss: position.stopLoss ? parseFloat(position.stopLoss) : null,
        take_profit: position.takeProfit ? parseFloat(position.takeProfit) : null,
        unrealized_pnl: position.unrealizedPnL ? parseFloat(position.unrealizedPnL) : 0,
        unrealized_pnl_pct: position.unrealizedPnLPct ? parseFloat(position.unrealizedPnLPct) : 0,
        opened_at: position.openedAt || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { error } = await this.client.from('positions').upsert(payload);
      if (error) throw error;
    } catch (err) {
      logger.warn(`⚠️ [Supabase Sync Error] Failed to sync position: ${err.message}`);
    }
  }

  /**
   * Sync cryptographic Proof-of-Trade block
   */
  async syncLedgerBlock(block) {
    if (!supabaseService.isConnected || !this.client) return;
    try {
      const payload = {
        block_index: block.index || block.block_index,
        timestamp: block.timestamp || new Date().toISOString(),
        action: block.action || 'TRADE_EXECUTION',
        trade_hash: block.tradeHash || block.trade_hash || block.hash,
        prev_block_hash: block.prevBlockHash || block.prev_block_hash,
        payload: block.payload || block.data || {}
      };

      const { error } = await this.client.from('proof_of_trade_ledger').upsert(payload);
      if (error) throw error;
    } catch (err) {
      logger.warn(`⚠️ [Supabase Sync Error] Failed to sync ledger block: ${err.message}`);
    }
  }

  /**
   * Backup Continuous RL policy weights
   */
  async syncRLWeights(weightsData) {
    if (!supabaseService.isConnected || !this.client) return;
    try {
      const payload = {
        version: weightsData.version || 1,
        regime: weightsData.regime || 'neutral',
        weights: weightsData.weights || {},
        meta_parameters: weightsData.metaParameters || {},
        trades_trained: weightsData.tradesTrained || 0,
        ppo_updates: weightsData.ppoUpdates || 0,
        meta_updates: weightsData.metaUpdates || 0,
        recorded_at: new Date().toISOString()
      };

      const { error } = await this.client.from('rl_policy_weights').insert(payload);
      if (error) throw error;
      logger.info(`☁️ [Supabase Cloud] RL Policy Weights v${payload.version} backed up successfully`);
    } catch (err) {
      logger.warn(`⚠️ [Supabase Sync Error] Failed to sync RL weights: ${err.message}`);
    }
  }
}

module.exports = new SupabaseSyncEngine();
