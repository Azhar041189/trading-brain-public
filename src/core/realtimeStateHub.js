const { createAgentLogger } = require('./logger');
const supabaseService = require('./supabaseClient');
const sessionStateStore = require('./sessionStateStore');
const riskManager = require('../agents/risk/riskManager');

const logger = createAgentLogger('RealtimeStateHub');

/**
 * RealtimeStateHub - Distributed State Synchronization Hub (Render Cloud ↔ Localhost ↔ Mobile)
 * Streams live mark-to-market positions, portfolio equity, PnL, and council debates over Supabase Realtime WebSockets.
 */
class RealtimeStateHub {
  constructor() {
    this.isCloudNode = process.env.RENDER === 'true' || process.env.NODE_ENV === 'production';
    this.mirrorMode = false;
    this.cloudSnapshot = null;
    this.lastSyncTime = null;
    this.channel = null;
  }

  initialize() {
    if (!supabaseService.isConnected) {
      logger.info('Supabase client not connected. Operating in local standalone state mode.');
      return;
    }

    try {
      const client = supabaseService.getClient();
      if (client) {
        this.channel = client.channel('trading_brain_cluster');
        
        // Listen for live cluster state broadcasts
        this.channel.on('broadcast', { event: 'state_snapshot' }, (payload) => {
          this._handleRemoteSnapshot(payload.payload);
        }).subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            logger.info(`🌐 [State Hub] Subscribed to Supabase Real-Time Cluster Channel (Node Type: ${this.isCloudNode ? 'CLOUD_MASTER' : 'LOCAL_CLIENT'})`);
          }
        });
      }
    } catch (err) {
      logger.warn('State Hub subscription error:', { error: err.message });
    }
  }

  /**
   * Broadcast current node state snapshot to the distributed cluster
   */
  async broadcastState(stateUpdate = {}) {
    if (!supabaseService.isConnected || !this.channel) return;

    try {
      const snapshot = {
        nodeType: this.isCloudNode ? 'CLOUD_MASTER' : 'LOCAL_CLIENT',
        timestamp: new Date().toISOString(),
        compoundedEquity: stateUpdate.compoundedEquity || sessionStateStore.getState().compoundedEquity || 100000,
        dailyPnL: stateUpdate.dailyPnL !== undefined ? stateUpdate.dailyPnL : riskManager.dailyPnL,
        unrealizedPnL: stateUpdate.unrealizedPnL || 0,
        positionsCount: riskManager.openPositions.size,
        positions: Array.from(riskManager.openPositions.values()),
        recentDebates: stateUpdate.debates || []
      };

      await this.channel.send({
        type: 'broadcast',
        event: 'state_snapshot',
        payload: snapshot
      });

      this.lastSyncTime = snapshot.timestamp;
    } catch (e) {
      logger.warn('Failed to broadcast state snapshot:', { error: e.message });
    }
  }

  _handleRemoteSnapshot(snapshot) {
    if (!snapshot) return;

    // 1. If Local Node receives snapshot from Cloud Master
    if (snapshot.nodeType === 'CLOUD_MASTER' && !this.isCloudNode) {
      this.cloudSnapshot = snapshot;
      this.lastSyncTime = snapshot.timestamp;
    }
    
    // 2. If Cloud Master receives a sync push from Local Master
    if (snapshot.nodeType === 'LOCAL_PUSH_SYNC' && this.isCloudNode) {
      this.cloudSnapshot = snapshot;
      this.lastSyncTime = snapshot.timestamp;
      
      // Update Cloud Master local state
      try {
        sessionStateStore.saveState({
          compoundedEquity: snapshot.compoundedEquity,
          realizedPnL: snapshot.dailyPnL,
          positions: snapshot.positions ? snapshot.positions.reduce((acc, p) => ({ ...acc, [p.symbol]: p }), {}) : {}
        });
        logger.info(`☁️ [Cloud Master Sync] Hydrated cloud state with Local Compounded Equity: $${snapshot.compoundedEquity}`);
      } catch (e) {}
    }
  }

  async syncLocalToCloud() {
    if (!supabaseService.isConnected || !this.channel) return { success: false, reason: 'Supabase channel not active' };

    const snapshot = {
      nodeType: 'LOCAL_PUSH_SYNC',
      timestamp: new Date().toISOString(),
      compoundedEquity: sessionStateStore.getState().compoundedEquity || 10,
      dailyPnL: sessionStateStore.getState().realizedPnL || 0,
      unrealizedPnL: 0,
      positionsCount: riskManager.openPositions.size,
      positions: Array.from(riskManager.openPositions.values())
    };

    await this.channel.send({
      type: 'broadcast',
      event: 'state_snapshot',
      payload: snapshot
    });

    return { success: true, message: 'Local compounded state pushed to Cloud Master via Supabase', snapshot };
  }

  getClusterStatus() {
    return {
      nodeType: this.isCloudNode ? 'CLOUD_MASTER' : 'LOCAL_OBSERVER',
      mirrorMode: this.mirrorMode,
      lastSyncTime: this.lastSyncTime || 'Standalone Local',
      cloudConnected: supabaseService.isConnected,
      cloudSnapshot: this.cloudSnapshot
    };
  }

  enableMirrorMode(enabled = true) {
    this.mirrorMode = enabled;
    logger.info(`🔄 [State Hub] Cloud Mirror Mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return this.getClusterStatus();
  }
}

module.exports = new RealtimeStateHub();
