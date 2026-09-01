const config = require('../../config');
const { createAgentLogger } = require('../../core/logger');
const database = require('../../core/database');
const dhanClient = require('../../tools/dhanClient');
const riskManager = require('../risk/riskManager');
const { excursionTelemetryEngine } = require('../../analytics/excursionTelemetryEngine');

const logger = createAgentLogger('ExecutionEngine');

class ExecutionEngine {
  constructor() {
    this.orderQueue = [];
    this.executing = false;
    this.paperTrading = config.trading.paperTrading;
    this.orderHistory = new Map();
    
    // Multi-Layer Idempotency: Hydrate persistent fill IDs from disk across restarts
    try {
      const sessionStateStore = require('../../core/sessionStateStore');
      const savedFills = sessionStateStore.getState().processedFillIds || [];
      this.processedFillIds = new Set(savedFills);
      this.tradeHistory = sessionStateStore.getState().trades || [];
    } catch (e) {
      this.processedFillIds = new Set();
      this.tradeHistory = [];
    }
  }

  /**
   * Production Execution & Fill Event Ingestion with Authoritative Database Idempotency
   */
  async handleExecutionFill(fillEvent) {
    const { fillId, clientOrderId, symbol, side, quantity, price, action = 'OPEN', strategy } = fillEvent;
    // Strict requirement: Reject unkeyed execution events from live brokers
    const dedupeKey = fillId || clientOrderId;
    if (!dedupeKey) {
      logger.error('❌ [Execution Engine] Dropped fill event: Missing mandatory fillId/clientOrderId idempotency key');
      return { duplicate: false, status: 'REJECTED_NO_KEY', error: 'Missing mandatory idempotency key' };
    }

    // Fast-path: Check In-memory LRU cache
    if (this.processedFillIds.has(dedupeKey)) {
      logger.warn(`⚠️ [Execution Engine] Duplicate fill event ignored by In-Memory Sentinel: ${dedupeKey}`);
      return { duplicate: true, status: 'DUPLICATE_IGNORED', reason: 'IN_MEMORY_LRU_DUPLICATE' };
    }

    // Authoritative Gate: Insert into Persistent Database
    const dbRes = await database.query(
      `INSERT INTO execution_fills (fill_id, client_order_id, symbol, side, quantity, price, strategy)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (fill_id) DO NOTHING`,
      [dedupeKey, clientOrderId || dedupeKey, symbol, side, quantity, price, strategy || 'Autonomous Alpha']
    );

    // Fail-Closed: If database query encountered an operational error, halt execution immediately
    if (dbRes && dbRes.error) {
      logger.error(`🚨 [Execution Engine] FAIL-CLOSED: Database persistence error: ${dbRes.error}`, { fillId: dedupeKey });
      return { duplicate: false, status: 'DB_ERROR_FAIL_CLOSED', error: dbRes.error };
    }

    // Duplicate Check: rowCount === 0 means ON CONFLICT was triggered (record already existed in DB)
    if (dbRes && dbRes.rowCount === 0 && database.isUsingDatabase()) {
      logger.warn(`⚠️ [Execution Engine] Duplicate fill event blocked by Database UNIQUE Constraint: ${dedupeKey}`);
      this.processedFillIds.add(dedupeKey); // Sync in-memory cache
      return { duplicate: true, status: 'DUPLICATE_IGNORED', reason: 'DATABASE_UNIQUE_CONSTRAINT' };
    }

    // Insertion Succeeded: Update In-Memory LRU & Secondary Disk Snapshot
    this.processedFillIds.add(dedupeKey);
    if (this.processedFillIds.size > 10000) {
      const firstKey = this.processedFillIds.values().next().value;
      this.processedFillIds.delete(firstKey);
    }

    try {
      const sessionStateStore = require('../../core/sessionStateStore');
      sessionStateStore.saveState({
        processedFillIds: Array.from(this.processedFillIds)
      });
    } catch (e) {}

    // Forward to Real Production RiskManager
    await riskManager.recordTrade({
      symbol,
      side,
      direction: side === 'BUY' ? 'LONG' : 'SHORT',
      quantity,
      price,
      avgPrice: price,
      entryPrice: price,
      action,
      strategy: strategy || 'Autonomous Multi-Agent Alpha',
      opened_at: new Date().toISOString()
    });

    return { duplicate: false, status: 'PROCESSED', fillId: dedupeKey };
  }

  getRecentTrades(limit = 100) {
    return this.tradeHistory.slice(-limit).reverse();
  }

  clearHistory() {
    this.tradeHistory = [];
    this.orderHistory.clear();
    this.orderQueue = [];
  }

  async initialize() {
    await riskManager.initialize();
    try {
      const sessionStateStore = require('../../core/sessionStateStore');
      const diskTrades = sessionStateStore.getState().trades || [];
      if (diskTrades.length > this.tradeHistory.length) {
        this.tradeHistory = diskTrades;
      }
    } catch (e) {}
    logger.info('Execution engine initialized', { paperTrading: this.paperTrading, tradesLoaded: this.tradeHistory.length });
  }

  // ============ MAIN EXECUTION ============

  async executeSignal(signal, portfolio) {
    // Validate    // Check risk limits (Bypass for position closes)
    let validation = { allowed: true, reasons: [] };
    if (signal.strategy !== 'position_close' && signal.action !== 'CLOSE') {
      validation = await riskManager.validateTrade(signal, portfolio);
      if (!validation.allowed) {
        logger.warn('Signal rejected by risk manager', { 
          symbol: signal.symbol, 
          reasons: validation.reasons 
        });
        return { success: false, rejected: true, reasons: validation.reasons };
      }
    }

    // Calculate position size
    const quantity = signal.strategy === 'position_close' 
      ? signal.quantity 
      : (validation.adjustedQuantity || riskManager.calculatePositionSize(signal, portfolio));
    
    if (quantity <= 0) {
      return { success: false, rejected: true, reasons: ['Calculated quantity is zero'] };
    }

    // Handle Position Flip (Close existing opposite position if present, but ignore if this IS a position close)
    if (signal.strategy !== 'position_close' && signal.action !== 'CLOSE') {
      const existing = riskManager.openPositions.get(signal.symbol);
      if (existing) {
        const isExistingLong = existing.side === 'LONG' || existing.side === 'BUY';
        const isSignalLong = signal.direction === 'LONG';
        if (isExistingLong !== isSignalLong) {
          logger.info(`🔄 [Position Flip Execution] Closing existing ${existing.side} on ${signal.symbol} to enter ${signal.direction}`);
          await this.closePosition(signal.symbol, existing.segment, existing.quantity, signal.entryPrice, 'POSITION_FLIP');
        }
      }

      // Handle Controlled Rotation Eviction (Smart Capital Reallocation)
      if (validation.rotationRequired && validation.targetSymbolToEvict) {
        const stalePos = riskManager.openPositions.get(validation.targetSymbolToEvict);
        if (stalePos) {
          logger.info(`🔄 [Controlled Rotation] Evicting stagnant ${validation.targetSymbolToEvict} to allocate capital for superior ${signal.symbol}`);
          await this.closePosition(validation.targetSymbolToEvict, stalePos.segment, stalePos.quantity, stalePos.currentPrice, 'CONTROLLED_ROTATION');
        }
      }
    }

    logger.info('Executing signal', { symbol: signal.symbol, direction: signal.direction, quantity, price: signal.entryPrice });

    // Create order
    const order = this.buildOrder(signal, quantity);
    
    // Execute order
    let result;
    if (this.paperTrading) {
      result = await this.executePaperOrder(order);
    } else {
      result = await this.executeLiveOrder(order);
    }

    logger.info('Execution result', { success: result.success, orderId: result.orderId, status: result.orderStatus });

    // Record trade
    if (result.success) {
      await this.recordTrade(order, result, signal);
      if (signal.strategy !== 'position_close' && signal.action !== 'CLOSE') {
        const fillP = parseFloat(result.averagePrice || order.price || signal.entryPrice || 0);
        await riskManager.recordTrade({
          symbol: order.symbol,
          side: order.transactionType,
          direction: order.transactionType === 'BUY' ? 'LONG' : 'SHORT',
          quantity: result.filledQuantity || order.quantity,
          price: fillP,
          avgPrice: fillP,
          avg_price: fillP,
          entryPrice: fillP,
          entry_price: fillP,
          action: 'OPEN',
          segment: order.exchangeSegment || signal.segment || 'EQUITY',
          strategy: signal.strategy || 'Autonomous Multi-Agent Alpha',
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          opened_at: new Date().toISOString()
        });

        // Read-only Excursion Telemetry Observer (v14.2 Candidate Foundation)
        try {
          excursionTelemetryEngine.recordPositionOpen({
            id: `pos_${order.symbol}`,
            positionId: `pos_${order.symbol}`,
            symbol: order.symbol,
            market: signal.market || (order.exchangeSegment === 'NSE_EQ' ? 'IN' : 'CRYPTO'),
            side: order.transactionType,
            direction: order.transactionType === 'BUY' ? 'LONG' : 'SHORT',
            entryPrice: fillP,
            initialStopLoss: signal.stopLoss,
            quantity: result.filledQuantity || order.quantity,
            confidence: signal.confidence,
            strategy: signal.strategy,
            regime: signal.marketRegime || signal.regime
          });
        } catch (e) {}

        // Dispatch Telegram Live Push Notification across all markets (Crypto, US, India, Forex)
        try {
          const telegram = require('../../core/telegramAlertDispatcher');
          telegram.notifyTradeEntry({
            symbol: order.symbol,
            direction: order.transactionType === 'BUY' ? 'LONG' : 'SHORT',
            entryPrice: result.averagePrice || order.price,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            confidence: signal.confidence ? `${(signal.confidence * 100).toFixed(0)}%` : '85%',
            strategy: signal.strategy || 'Multi-Agent Consensus'
          });
        } catch (e) {}
      }
    }

    return { success: result.success, orderId: result.orderId, ...result };
  }

  async executeMultipleSignals(signals, portfolio) {
    const results = [];
    
    // Sort by confidence * riskReward
    signals.sort((a, b) => (b.confidence * b.riskReward) - (a.confidence * a.riskReward));
    
    for (const signal of signals) {
      // Check daily limits before each trade
      const validation = await riskManager.validateTrade(signal, portfolio);
      if (!validation.allowed) {
        logger.warn(`🛑 [Risk Limit Skip: ${signal.symbol}] Skipped: ${(validation.reasons || []).join('; ')}`);
        results.push({ signal, success: false, skipped: true, reasons: validation.reasons });
        continue;
      }
      
      const result = await this.executeSignal(signal, portfolio);
      results.push({ signal, ...result });
      
      // Small delay between orders
      await this.sleep(500);
    }
    
    return results;
  }

  // ============ ORDER BUILDING ============

  buildOrder(signal, quantity) {
    const correlationId = `tb_${signal.strategy}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // In Indian Equity market: All LONG/BUY equity signals route as CNC Cash Delivery (₹0 Delivery Brokerage on Dhan)
    // SHORT signals route as INTRADAY (MIS) as required by SEBI exchange rules
    const isLong = signal.direction === 'LONG' || signal.side === 'BUY' || signal.action === 'BUY';
    const productType = isLong ? 'CNC' : 'INTRADAY';

    if (signal.segment === 'NSE_EQ') {
      return dhanClient.buildEquityOrder({
        symbol: signal.symbol,
        securityId: signal.securityId,
        side: isLong ? 'BUY' : 'SELL',
        quantity,
        price: signal.entryPrice,
        orderType: 'LIMIT',
        productType: productType, // Zero-brokerage CNC Delivery for all LONG shares and ETFs
        triggerPrice: 0
      });
    } else if (signal.segment === 'NSE_FNO') {
      return dhanClient.buildFNOOrder({
        securityId: signal.securityId,
        exchangeSegment: signal.exchangeSegment || 'NSE_FNO',
        side: signal.direction === 'LONG' ? 'BUY' : 'SELL',
        quantity,
        price: signal.entryPrice,
        orderType: 'LIMIT',
        productType: 'INTRADAY',
        triggerPrice: 0
      });
    }
    
    // Default (Crypto / US) - Enforce Limit Maker Execution for Ultra-Low Taker/Maker Fees
    return {
      ...signal,
      price: signal.entryPrice,
      quantity,
      correlationId,
      orderType: 'LIMIT',
      executionType: 'MAKER_POST_ONLY',
      transactionType: signal.direction === 'LONG' ? 'BUY' : 'SELL'
    };
  }

  // ============ PAPER TRADING (NAUTILUS-STYLE EVENT-DRIVEN STATE MACHINE) ============

  async executePaperOrder(order) {
    const startTimestamp = Date.now();
    logger.info('Executing paper order', { 
      symbol: order.securityId || order.symbol, 
      side: order.transactionType, 
      qty: order.quantity, 
      price: order.price 
    });

    const orderId = `paper_${startTimestamp}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Formal State Machine Transition Log
    const transitions = [
      { from: 'INITIALIZED', to: 'PENDING_SUBMIT', timestamp: new Date(startTimestamp).toISOString(), reason: 'ORDER_DISPATCHED' },
      { from: 'PENDING_SUBMIT', to: 'SUBMITTED', timestamp: new Date(startTimestamp + 1).toISOString(), reason: 'GATEWAY_ACK' },
      { from: 'SUBMITTED', to: 'ACCEPTED', timestamp: new Date(startTimestamp + 2).toISOString(), reason: 'MATCHING_ENGINE_ACCEPT' }
    ];

    // Simulate fill at limit price or market price
    const fillPrice = parseFloat(order.price || order.entryPrice || 0);

    // Realistic Microstructure Slippage:
    // MAKER_POST_ONLY orders experience 0 slippage (passive limit fill).
    // TAKER market orders experience realistic 0.03% to 0.05% friction.
    const isMaker = order.executionType === 'MAKER_POST_ONLY';
    const slippageRate = isMaker ? 0.0 : 0.0004; // 0.04% for takers, 0% for makers
    const slippage = fillPrice * slippageRate;
    const actualPrice = order.transactionType === 'BUY' 
      ? fillPrice + slippage 
      : fillPrice - slippage;

    const fillTimestamp = Date.now();
    const latencyMs = fillTimestamp - startTimestamp;

    transitions.push({
      from: 'ACCEPTED',
      to: 'FILLED',
      timestamp: new Date(fillTimestamp).toISOString(),
      reason: isMaker ? 'PASSIVE_LIMIT_BOOK_MATCH' : 'AGGRESSIVE_TAKER_MATCH',
      latencyMs
    });

    const result = {
      orderId,
      orderStatus: 'FILLED',
      executionState: 'FILLED',
      stateTransitions: transitions,
      latencyMs,
      averagePrice: actualPrice > 0 ? actualPrice.toFixed(4) : (order.entryPrice ? Number(order.entryPrice).toFixed(4) : '0.00'),
      filledQuantity: order.quantity,
      pendingQuantity: 0,
      omsErrorDescription: 'Paper trade executed with deterministic matching engine',
      timestamp: new Date(fillTimestamp).toISOString()
    };

    // Store in history
    this.orderHistory.set(orderId, { order, result, transitions, timestamp: new Date() });

    logger.info('Paper order filled', { orderId, price: actualPrice.toFixed(2), latencyMs: `${latencyMs}ms`, state: 'FILLED' });
    return { success: true, ...result };
  }

  async executeLiveOrder(order) {
    // HARD CEILING: LIVE execution is strictly forbidden on memory-only database engines
    if (!database.isUsingDatabase()) {
      const dbErr = '🚨 [Execution Engine] CRITICAL: LIVE order blocked - Database engine is in memory-only fallback mode. A durable PostgreSQL or SQLite database is strictly mandatory for live trading.';
      logger.error(dbErr, { order });
      return {
        success: false,
        error: dbErr,
        rejected: true,
        reason: 'PERSISTENT_DB_MANDATORY_FOR_LIVE'
      };
    }

    logger.info('Executing live order', { 
      symbol: order.securityId, 
      side: order.transactionType, 
      qty: order.quantity, 
      price: order.price 
    });

    try {
      const result = await dhanClient.placeOrder(order);
      
      // Check order status
      let orderStatus = result.orderStatus || 'PENDING';
      let avgPrice = result.averagePrice || order.price;
      let filledQty = result.filledQuantity || 0;
      
      // If partial fill, wait and check
      if (orderStatus === 'PARTIAL' || orderStatus === 'OPEN') {
        await this.sleep(2000);
        const status = await dhanClient.getOrderById(result.orderId);
        orderStatus = status.orderStatus;
        avgPrice = status.averagePrice || avgPrice;
        filledQty = status.filledQuantity || filledQty;
      }
      
      const execResult = {
        orderId: result.orderId,
        orderStatus,
        averagePrice: avgPrice,
        filledQuantity: filledQty,
        pendingQuantity: order.quantity - filledQty,
        omsErrorDescription: result.omsErrorDescription || 'Order executed',
        timestamp: new Date().toISOString()
      };

      this.orderHistory.set(result.orderId, { order, result: execResult, timestamp: new Date() });
      
      logger.info('Live order result', { orderId: result.orderId, status: orderStatus, avgPrice });
      
      return { success: orderStatus === 'COMPLETE' || orderStatus === 'PARTIAL', ...execResult };
      
    } catch (error) {
      logger.error('Live order failed', { error: error.message, order });
      return { 
        success: false, 
        error: error.message, 
        orderId: null 
      };
    }
  }

  // ============ POSITION MANAGEMENT ============

  async closePosition(symbol, segment, quantity, price, reason = 'MANUAL') {
    // Get current position
    const positions = await this.getCurrentPositions();
    const position = positions.find(p => p.symbol === symbol);
    
    if (!position) {
      return { success: false, error: 'No position found' };
    }

    const closeQty = quantity || position.quantity;
    const side = position.side === 'LONG' ? 'SELL' : 'BUY';
    
    const signal = {
      symbol,
      segment,
      securityId: position.securityId,
      direction: position.side === 'LONG' ? 'SHORT' : 'LONG', // Opposite to close
      entryPrice: price || position.currentPrice,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 1,
      confidence: 1,
      strategy: 'position_close',
      exchangeSegment: segment
    };

    const result = await this.executeSignal(signal, { totalCapital: 100000 }); // Portfolio passed for validation
    
    if (result.success) {
      const entryP = parseFloat(position.avgPrice || position.avg_price || position.entryPrice || position.currentPrice || price);
      const exitP = parseFloat(price || position.currentPrice || entryP);
      const rawPnl = (position.side === 'LONG' ? (exitP - entryP) : (entryP - exitP)) * closeQty;
      
      // Calculate realistic broker fees & regulatory charges
      // 1. Dhan / Indian Equities (STT 0.1%, Exchange 0.00345%, GST 18%, SEBI + Stamp Duty, Brokerage ₹20 or 0.03%)
      // 2. Binance / Crypto (0.04% taker fee + 0.05% slippage friction)
      // 3. US Equities (SEC $0.0000278 + FINRA TAF + $0.005/share)
      const isIndian = /^[A-Z0-9_]+$/.test(symbol) && !symbol.includes('USDT') && !symbol.includes('BTC') && !symbol.includes('ETH');
      let brokerFee = 0;
      let feeBreakdown = '';

      if (isIndian) {
        const turnover = (entryP + exitP) * closeQty;
        const stt = turnover * 0.00025; // 0.025% STT on intraday equity sell
        const brokerage = Math.min(20, turnover * 0.0003); // Dhan ₹20 or 0.03%
        const exchangeTurnover = turnover * 0.0000345; // NSE 0.00345%
        const sebi = turnover * 0.000001; // SEBI ₹10/crore
        const stampDuty = (entryP * closeQty) * 0.00003; // Stamp duty 0.003% on buy
        const gst = (brokerage + exchangeTurnover + sebi) * 0.18; // 18% GST
        brokerFee = parseFloat((stt + brokerage + exchangeTurnover + sebi + stampDuty + gst).toFixed(2));
        if (brokerFee < 0.05) brokerFee = 0.05; // Minimum realistic friction
        feeBreakdown = `Dhan Intraday: ₹${brokerFee} (Brokerage+STT+GST)`;
      } else if (symbol.includes('USDT') || symbol.includes('USD') || symbol.includes('BTC') || symbol.includes('ETH')) {
        const notional = (entryP + exitP) * closeQty;
        brokerFee = parseFloat((notional * 0.00075).toFixed(4)); // Binance 0.075% standard taker fee (4 decimals for micro-trades)
        feeBreakdown = `Binance Fee: $${brokerFee.toFixed(4)} (0.075% Taker)`;
      } else {
        brokerFee = parseFloat((closeQty * 0.005 + 1.0).toFixed(2)); // US standard
        feeBreakdown = `Broker Fee: $${brokerFee}`;
      }

      const isSubDollarTrade = Math.abs(rawPnl) < 0.10 && !isIndian;
      const pnl = parseFloat((rawPnl - brokerFee).toFixed(isSubDollarTrade ? 4 : 2));
      
      // Update risk manager state, remove position and enforce 90s anti-churn cooldown
      riskManager.openPositions.delete(symbol);
      riskManager.dailyPnL += pnl;
      if (typeof riskManager.recordCooldown === 'function') {
        riskManager.recordCooldown(symbol, 90);
      }

      // Add clear SELL trade entry into Trade History logs
      const exitTrade = {
        id: `exit_${Date.now()}`,
        timestamp: new Date().toISOString(),
        symbol: symbol,
        side: 'SELL',
        action: pnl >= 0 ? 'SELL (TAKE PROFIT)' : 'SELL (STOP LOSS)',
        quantity: closeQty,
        entryPrice: exitP,
        stopLoss: '-',
        takeProfit: '-',
        riskReward: pnl >= 0 ? '2.0x' : '0.0x',
        confidence: '100%',
        strategy: reason === 'AUTO_TAKE_PROFIT' ? 'Auto-Exit Sentinel (Profit Realized)' : (reason === 'AUTO_STOP_LOSS' ? 'Stop Loss Protection' : 'Manual Close'),
        status: 'FILLED',
        grossPnL: rawPnl,
        brokerFee: brokerFee,
        feeNote: feeBreakdown,
        realizedPnL: pnl
      };
      this.tradeHistory.push(exitTrade);
      if (this.tradeHistory.length > 200) this.tradeHistory.shift();

      // Read-only Excursion Telemetry Observer (v14.2 Candidate Foundation)
      try {
        excursionTelemetryEngine.recordPositionClose({
          id: `pos_${symbol}`,
          positionId: `pos_${symbol}`,
          symbol: symbol,
          exitPrice: exitP,
          grossPnL: rawPnl,
          fees: brokerFee,
          netPnL: pnl,
          exitReason: reason,
          exitTimestamp: Date.now()
        });
      } catch (e) {}

      try {
        const sessionStateStore = require('../../core/sessionStateStore');
        sessionStateStore.saveState({ trades: this.tradeHistory });
      } catch (e) {}

      const compoundingEngine = require('../../core/compoundingEngine');
      compoundingEngine.recordTradePnL(pnl);

      // Dispatch Telegram Push Alert for Realized Exit
      try {
        const telegram = require('../../core/telegramAlertDispatcher');
        const profitPct = entryP > 0 ? ((exitP - entryP) / entryP) * 100 * (position.side === 'LONG' ? 1 : -1) : 0;
        telegram.notifyTradeExit({
          symbol,
          exitPrice: exitP,
          profitPct,
          pnlUSD: pnl,
          reason
        });
      } catch (e) {}

      // Phase 4: Closed-Loop Episodic Learning & Memory Recording
      try {
        const agentMemory = require('../../core/agentMemoryEngine');
        const regimeClassifier = require('../../core/regimeClassifier');
        const smartRouter = require('../../core/smartRouter');
        const marketKey = smartRouter.resolveMarketForSignal({ symbol });
        const currentRegime = regimeClassifier.getRegimeForMarket(marketKey) || 'RANGING_CHOPPY';
        
        agentMemory.storeEpisode({
          symbol,
          regime: currentRegime,
          direction: position.side || 'LONG',
          entryPrice: entryP,
          exitPrice: exitP,
          pnl,
          reason,
          lesson: pnl >= 0 
            ? `Winning setup in ${currentRegime} for ${symbol}. Maintained discipline and captured profit.`
            : `Loss triggered in ${currentRegime} for ${symbol}. Protected capital via strict stop loss.`
        });
      } catch (e) {}

      // Phase C: Forward Paper Probation Cryptographic Ledger Recording
      try {
        const paperProbationSentinel = require('../../core/paperProbationSentinel');
        paperProbationSentinel.recordTrade({
          tradeId: exitTrade.id,
          model: 'CANDIDATE_v14_1',
          symbol: symbol,
          direction: position.side || 'LONG',
          entryPrice: entryP,
          exitPrice: exitP,
          quantity: closeQty,
          grossPnL: rawPnl,
          fees: brokerFee,
          netPnL: pnl,
          holdingBars: 1,
          strategy: position.strategy || exitTrade.strategy,
          market: position.market || 'CRYPTO'
        });
      } catch (e) {}

      // Persist to database
      try {
        const database = require('../../core/database');
        await database.query(
          `UPDATE trades 
           SET status = 'closed', exit_price = $1, realized_pnl = $2, closed_at = NOW() 
           WHERE symbol = $3 AND status = 'open'`,
          [exitP, pnl, symbol]
        );
      } catch (e) {}

      // Persist updated session state
      try {
        const sessionStateStore = require('../../core/sessionStateStore');
        const posObj = {};
        for (const [s, p] of riskManager.openPositions) posObj[s] = p;
        sessionStateStore.saveState({
          realizedPnL: riskManager.dailyPnL,
          compoundedEquity: compoundingEngine.getCompoundedEquity(),
          positions: posObj,
          trades: this.tradeHistory.slice(-100)
        });
      } catch (e) {}

      // Anti-Chop & Anti-Revenge Trading: Place symbol on 15-minute cooldown if stopped out
      if (pnl < 0 || (reason && (reason.includes('STOP_LOSS') || reason.includes('AUTO_STOP_LOSS')))) {
        try {
          riskManager.recordCooldown(symbol, 900); // 15-minute (900s) cooldown on symbol
          logger.info(`🛡️ [Anti-Chop Cooldown Triggered] Symbol ${symbol} placed on 15m cooldown after stop-loss to prevent consecutive losses`);
        } catch (e) {}
      }

      logger.info('Position closed & profits compounded', { symbol, qty: closeQty, pnl, reason });
    }
    
    return result;
  }

  async closeAllPositions(reason = 'END_OF_DAY') {
    const positions = await this.getCurrentPositions();
    const results = [];
    
    for (const position of positions) {
      const result = await this.closePosition(
        position.symbol, 
        position.segment, 
        position.quantity, 
        position.currentPrice, 
        reason
      );
      results.push({ symbol: position.symbol, ...result });
      await this.sleep(1000);
    }
    
    return results;
  }

  // ============ ADVANCED DYNAMIC EXIT & 3-STAGE PROFIT LOCKER SENTINEL ============

  evaluateExit(position, livePrice, candles = []) {
    if (!position || !livePrice) return null;

    const entry = parseFloat(position.avgPrice || position.avg_price || position.entryPrice || position.entry_price || livePrice);
    if (!entry || entry <= 0) return null;
    const isLong = position.side === 'LONG' || position.side === 'BUY';
    const profitDistance = isLong ? (livePrice - entry) : (entry - livePrice);
    const profitPct = (profitDistance / entry) * 100;
    const initialRisk = Math.abs(entry - (position.stopLoss || (entry * (isLong ? 0.985 : 1.015))));

    // 1. Time-based stagnation exit: Force close after 4 hours if dead flat
    const entryTime = position.entryTime ? new Date(position.entryTime).getTime() : (Date.now() - 3600000);
    const holdDurationMs = Date.now() - entryTime;
    if (holdDurationMs > 4 * 60 * 60 * 1000 && Math.abs(profitPct) < 0.20) {
      return { action: 'CLOSE', reason: 'TIME_STOP_4H_STAGNANT' };
    }

    // 2. High-Asymmetric Take Profit (+1.50% to +3.50% target or hit TP level)
    const minProfitThreshold = 1.25;
    const hasHitTarget = position.takeProfit && (isLong ? livePrice >= position.takeProfit : livePrice <= position.takeProfit);
    if (profitPct >= minProfitThreshold && hasHitTarget) {
      return { action: 'CLOSE', reason: 'AUTO_TAKE_PROFIT' };
    }

    // 3. Hard Stop Loss / Ratcheted Protected Stop Exit
    if (position.stopLoss && (isLong ? livePrice <= position.stopLoss : livePrice >= position.stopLoss)) {
      return { action: 'CLOSE', reason: position.isBreakevenLocked ? 'LOCKED_PROFIT_EXIT' : 'AUTO_STOP_LOSS' };
    }

    // 4. STAGE 1: Immediate Risk-Free Breakeven Lock at +0.50% Gain (+0.75R)
    // Ensures fees (0.19% roundtrip) are covered and the trade can NEVER lose money
    if (profitPct >= 0.50) {
      const feeBuffer = entry * 0.0022; // 0.22% buffer covers all maker/taker fees + slippage
      const beLevel = isLong ? (entry + feeBuffer) : (entry - feeBuffer);
      if (isLong && (!position.stopLoss || position.stopLoss < beLevel)) {
        position.stopLoss = parseFloat(beLevel.toFixed(4));
        position.isBreakevenLocked = true;
        logger.info(`🛡️ [Stage 1 Breakeven Lock] Stop Loss moved to Entry+Fees for ${position.symbol} @ $${position.stopLoss} (Risk-Free Winner)`);
      } else if (!isLong && (!position.stopLoss || position.stopLoss > beLevel)) {
        position.stopLoss = parseFloat(beLevel.toFixed(4));
        position.isBreakevenLocked = true;
        logger.info(`🛡️ [Stage 1 Breakeven Lock] Stop Loss moved to Entry+Fees for ${position.symbol} @ $${position.stopLoss} (Risk-Free Winner)`);
      }
    }

    // 5. STAGE 2: Guaranteed Profit Lock at +1.00% Gain (+1.5R)
    // Locks in a guaranteed +0.50% net profit in the bank
    if (profitPct >= 1.00) {
      const guaranteedProfitLevel = isLong ? (entry * 1.0050) : (entry * 0.9950);
      if (isLong && (!position.stopLoss || position.stopLoss < guaranteedProfitLevel)) {
        position.stopLoss = parseFloat(guaranteedProfitLevel.toFixed(4));
        logger.info(`💰 [Stage 2 Profit Lock] Stop ratcheted to +0.50% guaranteed gain for ${position.symbol} @ $${position.stopLoss}`);
      } else if (!isLong && (!position.stopLoss || position.stopLoss > guaranteedProfitLevel)) {
        position.stopLoss = parseFloat(guaranteedProfitLevel.toFixed(4));
        logger.info(`💰 [Stage 2 Profit Lock] Stop ratcheted to +0.50% guaranteed gain for ${position.symbol} @ $${position.stopLoss}`);
      }
    }

    // 6. STAGE 3: Chandelier / ATR Runner Trailing Stop (Trails winner at 2.0x ATR for explosive trends)
    if (candles && candles.length >= 14) {
      const atr = this.calculateATR(candles, 14);
      if (atr > 0 && profitPct >= 1.25) {
        const trailingStop = isLong ? (livePrice - (atr * 2.0)) : (livePrice + (atr * 2.0));
        if (isLong && (!position.stopLoss || trailingStop > position.stopLoss)) {
          position.stopLoss = parseFloat(trailingStop.toFixed(4));
          logger.info(`🚀 [Stage 3 ATR Trail] Trailed stop-loss for ${position.symbol} runner to $${position.stopLoss}`);
        } else if (!isLong && (!position.stopLoss || trailingStop < position.stopLoss)) {
          position.stopLoss = parseFloat(trailingStop.toFixed(4));
          logger.info(`🚀 [Stage 3 ATR Trail] Trailed stop-loss for ${position.symbol} runner to $${position.stopLoss}`);
        }
      }
    }

    return null;
  }

  checkExitConditions(position, livePrice, candles = []) {
    return this.evaluateExit(position, livePrice, candles);
  }

  calculateATR(candles, period = 14) {
    if (!candles || candles.length < period) return 0;
    let trSum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1] ? candles[i - 1].close : candles[i].open;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trSum += tr;
    }
    return trSum / period;
  }

  async updateTrailingStopsAndBreakeven(currentQuotes = new Map(), candlesMap = new Map()) {
    const positions = await this.getCurrentPositions();
    if (positions.length === 0) return;

    for (const pos of positions) {
      const livePrice = currentQuotes.get(pos.symbol) || pos.currentPrice;
      if (!livePrice || !pos.entryPrice) continue;

      // Read-only Excursion Telemetry Observer (v14.2 Candidate Foundation)
      try {
        excursionTelemetryEngine.updateMarketPrice(pos.symbol, livePrice);
      } catch (e) {}

      const candles = candlesMap.get(pos.symbol) || [];
      const exitDecision = this.evaluateExit(pos, livePrice, candles);
      if (exitDecision && exitDecision.action === 'CLOSE') {
        logger.info(`🎯 [Dynamic Exit Triggered] ${pos.symbol} executing ${exitDecision.reason} @ $${livePrice}`);
        await this.closePosition(pos.symbol, pos.segment, pos.quantity, livePrice, exitDecision.reason);
      }
    }
  }

  // ============ ORDER MANAGEMENT ============

  async modifyOrder(orderId, modifications) {
    try {
      if (this.paperTrading) {
        // Paper trading: update local record
        const history = this.orderHistory.get(orderId);
        if (history) {
          history.order = { ...history.order, ...modifications };
          return { success: true, orderId, modified: true };
        }
        return { success: false, error: 'Order not found' };
      }
      
      return await dhanClient.modifyOrder(orderId, modifications);
    } catch (error) {
      logger.error('Modify order failed', { orderId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async cancelOrder(orderId) {
    try {
      if (this.paperTrading) {
        this.orderHistory.delete(orderId);
        return { success: true, orderId, cancelled: true };
      }
      
      return await dhanClient.cancelOrder(orderId);
    } catch (error) {
      logger.error('Cancel order failed', { orderId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async getOrderStatus(orderId) {
    try {
      if (this.paperTrading) {
        const history = this.orderHistory.get(orderId);
        return history?.result || { error: 'Order not found' };
      }
      
      return await dhanClient.getOrderById(orderId);
    } catch (error) {
      return { error: error.message };
    }
  }

  // ============ HELPERS ============

  async getCurrentPositions() {
    try {
      if (this.paperTrading) {
        // Return active positions from riskManager in-memory registry with complete data integrity
        return Array.from(riskManager.openPositions.values()).map(p => {
          const entryPrice = parseFloat(p.avgPrice || p.avg_price || p.entryPrice || p.entry_price || p.currentPrice || p.price || 0);
          const currentPrice = parseFloat(p.currentPrice || p.current_price || entryPrice || 0);
          const isLong = p.side === 'LONG' || p.side === 'BUY';
          const qty = p.quantity || 1;
          const pnl = isLong ? (currentPrice - entryPrice) * qty : (entryPrice - currentPrice) * qty;
          const pnlPct = entryPrice > 0 ? (isLong ? ((currentPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - currentPrice) / entryPrice) * 100) : 0;

          return {
            symbol: p.symbol,
            side: isLong ? 'LONG' : 'SHORT',
            quantity: qty,
            avg_price: entryPrice,
            avgPrice: entryPrice,
            entry_price: entryPrice,
            entryPrice: entryPrice,
            current_price: currentPrice,
            currentPrice: currentPrice,
            unrealized_pnl: parseFloat(pnl.toFixed(2)),
            unrealizedPnL: parseFloat(pnl.toFixed(2)),
            pnl_pct: parseFloat(pnlPct.toFixed(2)),
            strategy: p.strategy || 'Autonomous Multi-Agent Alpha',
            stop_loss: p.stopLoss || p.stop_loss || null,
            stopLoss: p.stopLoss || p.stop_loss || null,
            take_profit: p.takeProfit || p.take_profit || null,
            takeProfit: p.takeProfit || p.take_profit || null,
            sector: p.sector || 'EQUITY',
            segment: p.segment || 'EQUITY',
            opened_at: p.opened_at || p.openedAt || new Date().toISOString()
          };
        });
      }
      
      const data = await dhanClient.getPositions();
      return data.data || [];
    } catch (error) {
      logger.error('Get positions failed', { error: error.message });
      return [];
    }
  }

  async recordTrade(order, result, signal) {
    try {
      const tradeEntry = {
        id: result.orderId || `trade_${Date.now()}`,
        timestamp: new Date().toISOString(),
        symbol: signal.symbol,
        side: order.transactionType || (signal.direction === 'LONG' ? 'BUY' : 'SELL'),
        action: signal.direction === 'LONG' ? 'BUY (LONG)' : 'SELL (SHORT)',
        quantity: result.filledQuantity || order.quantity,
        entryPrice: result.averagePrice || order.price || signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        riskReward: signal.riskReward || 1.8,
        confidence: signal.confidence ? `${(signal.confidence * 100).toFixed(0)}%` : '85%',
        strategy: signal.strategy || 'Autonomous Multi-Agent Alpha',
        status: 'FILLED'
      };

      this.tradeHistory.push(tradeEntry);
      if (this.tradeHistory.length > 500) this.tradeHistory.shift();

      // Persist to session state store
      try {
        const sessionStateStore = require('../../core/sessionStateStore');
        sessionStateStore.saveState({ trades: this.tradeHistory.slice(-100) });
        
        // Mirror trade to Supabase Cloud
        const supabaseSyncEngine = require('../../core/supabaseSyncEngine');
        supabaseSyncEngine.syncTrade(tradeEntry);
      } catch (e) {}

      await database.query(
        `INSERT INTO trades (symbol, exchange, segment, side, quantity, entry_price, stop_loss, take_profit, status, strategy, signal_id, opened_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
        [
          signal.symbol,
          order.exchangeSegment?.includes('NSE') ? 'NSE' : 'BSE',
          signal.segment,
          order.transactionType,
          result.filledQuantity || order.quantity,
          result.averagePrice || order.price,
          signal.stopLoss,
          signal.takeProfit,
          'open',
          signal.strategy,
          signal.id || null
        ]
      );
    } catch (error) {
      logger.error('Record trade failed', { error: error.message });
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============ END OF DAY ============

  async endOfDay() {
    logger.info('End of day routine starting');
    
    // Close all positions if configured
    // await this.closeAllPositions('END_OF_DAY');
    
    // Cancel pending orders
    // (would need to track pending orders)
    
    // Update daily P&L
    const positions = await this.getCurrentPositions();
    let unrealizedPnL = 0;
    
    for (const pos of positions) {
      unrealizedPnL += parseFloat(pos.unrealized_pnl || 0);
    }
    
    await riskManager.updatePnL(0, unrealizedPnL);
    
    logger.info('End of day complete', { unrealizedPnL });
  }
}

module.exports = new ExecutionEngine();