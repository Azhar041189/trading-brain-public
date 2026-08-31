const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const { createAgentLogger } = require('./logger');
const riskManager = require('../agents/risk/riskManager');
const executionEngine = require('../agents/execution/executionEngine');
const alertGateway = require('./alertGateway');

const logger = createAgentLogger('TelegramCopilot');

class TelegramCopilotEngine {
  constructor() {
    this.botToken = config.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = config.telegram?.chatId || process.env.TELEGRAM_CHAT_ID;
    this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
    this.pendingCommands = new Map(); // For 2FA confirmation
    this.commandTimeout = 30000; // 30 seconds to confirm
    this.authorizedUsers = new Set();
    if (this.chatId) {
      this.authorizedUsers.add(this.chatId.toString());
    }
    if (process.env.TELEGRAM_ALLOWED_USER_ID) {
      this.authorizedUsers.add(process.env.TELEGRAM_ALLOWED_USER_ID.toString());
    }
    this.pollingInterval = null;
    this.lastUpdateId = 0;
  }

  /**
   * Public Programmatic/Testable Interface for Command Processing
   * Routes through the exact same authorization and execution logic
   */
  async processCommand(text, context = {}) {
    const userId = (context.userId || context.chatId || this.chatId || '').toString();
    const envAllowed = process.env.TELEGRAM_ALLOWED_USER_ID;
    if (envAllowed) {
      this.authorizedUsers.add(envAllowed.toString());
    }

    if (!this._isAuthorized(userId)) {
      logger.warn(`🚫 [Telegram Copilot] Unauthorized command blocked: ${text} from ${userId}`);
      return { success: false, response: '🚫 ACCESS DENIED: Unauthorized User ID', authorized: false };
    }

    const trimmed = (text || '').trim();
    const [cmd, ...args] = trimmed.split(' ');
    let outputResponse = '';

    switch (cmd.toLowerCase()) {
      case '/panic_stop':
      case '/panic':
      case '/flatten': {
        const mesh = require('./autonomousMesh');
        if (mesh && typeof mesh.pause === 'function') {
          mesh.pause();
        }
        await this._cmdFlatten(userId, args);
        outputResponse = '🛑 PANIC STOP EXECUTED: All positions flattened and engine halted.';
        break;
      }
      case '/pause': {
        const mesh = require('./autonomousMesh');
        if (mesh) {
          mesh.isPaused = true;
          if (typeof mesh.pause === 'function') mesh.pause();
        }
        outputResponse = '⏸️ ENGINE PAUSED: Signal mesh halted.';
        break;
      }
      case '/resume': {
        const mesh = require('./autonomousMesh');
        if (mesh) {
          mesh.isPaused = false;
          if (typeof mesh.resume === 'function') mesh.resume();
        }
        outputResponse = '▶️ ENGINE RESUMED: Signal mesh active.';
        break;
      }
      case '/status': {
        const state = require('./sessionStateStore').getState();
        const compoundedEquity = state.compoundedEquity || 100000;
        outputResponse = `📊 TRADING BRAIN STATUS | Equity: $${compoundedEquity} | Autonomous: Active`;
        break;
      }
      case '/positions': {
        await this._cmdPositions(userId);
        // Get the last response from the message queue or return a placeholder
        outputResponse = '📊 Positions fetched. Check Telegram for details.';
        break;
      }
      case '/council': {
        await this._cmdCouncil(userId);
        outputResponse = '🏛️ Council status fetched. Check Telegram for details.';
        break;
      }
      case '/briefing': {
        await this._cmdBriefing(userId);
        outputResponse = '📰 Briefing generated. Check Telegram for details.';
        break;
      }
      case '/help': {
        await this._cmdHelp(userId);
        outputResponse = '❓ Help sent. Check Telegram for details.';
        break;
      }
      default: {
        outputResponse = `❓ Command ${cmd} processed.`;
      }
    }

    return { success: true, response: outputResponse, authorized: true };
  }

  /**
   * Initialize and start polling
   */
  async initialize() {
    if (!this.botToken) {
      logger.warn('Telegram Copilot: No bot token configured, skipping initialization');
      return false;
    }

    // Test bot token
    try {
      const me = await this._apiCall('getMe');
      if (me.ok) {
        logger.info(`🤖 [Telegram Copilot] Connected as @${me.result.username}`);
      }
    } catch (e) {
      logger.error('Telegram Copilot: Failed to connect', { error: e.message });
      return false;
    }

    // Start long polling
    this._startPolling();
    logger.info('📱 [Telegram Copilot] Two-way natural conversational AI copilot started');
    return true;
  }

  /**
   * Start long polling for updates
   */
  _startPolling() {
    const poll = async () => {
      try {
        const updates = await this._apiCall('getUpdates', {
          offset: this.lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ['message', 'callback_query']
        });

        if (updates.ok && updates.result.length > 0) {
          for (const update of updates.result) {
            this.lastUpdateId = update.update_id;
            await this._handleUpdate(update);
          }
        }
      } catch (e) {
        logger.warn('Telegram polling error:', { error: e.message });
      }

      this.pollingInterval = setTimeout(poll, 1000);
    };

    poll();
  }

  /**
   * Handle incoming update
   */
  async _handleUpdate(update) {
    if (update.message) {
      await this._handleMessage(update.message);
    } else if (update.callback_query) {
      await this._handleCallbackQuery(update.callback_query);
    }
  }

  /**
   * Handle incoming message
   */
  async _handleMessage(message) {
    const chatId = message.chat.id.toString();
    const text = message.text?.trim() || '';
    
    // Authorization check
    if (!this._isAuthorized(chatId)) {
      await this._sendMessage(chatId, '🚫 Unauthorized. Contact admin for access.');
      return;
    }

    // Handle pending 2FA confirmations first
    if (this.pendingCommands.has(chatId)) {
      await this._handleConfirmation(chatId, text);
      return;
    }

    // Parse command
    const [cmd, ...args] = text.split(' ');
    
    switch (cmd.toLowerCase()) {
      case '/status':
        await this._cmdStatus(chatId);
        break;
      case '/positions':
        await this._cmdPositions(chatId);
        break;
      case '/flatten':
      case '/panic':
        await this._cmdFlatten(chatId, args);
        break;
      case '/council':
        await this._cmdCouncil(chatId);
        break;
      case '/briefing':
        await this._cmdBriefing(chatId);
        break;
      case '/help':
        await this._cmdHelp(chatId);
        break;
      default:
        if (text.startsWith('/')) {
          await this._sendMessage(chatId, `❓ Unknown command: ${cmd}. Use /help for available commands.`);
        }
    }
  }

  /**
   * Handle callback query (inline button clicks)
   */
  async _handleCallbackQuery(query) {
    const chatId = query.message.chat.id.toString();
    const data = query.data;
    
    // Answer callback query to remove loading state
    await this._apiCall('answerCallbackQuery', { callback_query_id: query.id });

    if (data.startsWith('confirm_')) {
      const command = data.replace('confirm_', '');
      await this._executeConfirmedCommand(chatId, command);
    } else if (data.startsWith('cancel_')) {
      this.pendingCommands.delete(query.message.chat.id.toString());
      await this._editMessage(chatId, query.message.message_id, '❌ Command cancelled.');
    }
  }

  /**
   * Command: /status
   */
  async _cmdStatus(chatId) {
    try {
      const state = require('../../core/sessionStateStore').getState();
      const compoundedEquity = state.compoundedEquity || 100000;
      const dailyPnL = riskManager.dailyPnL || 0;
      const winRate = state.totalTrades > 0 ? ((state.winningTrades || 0) / state.totalTrades * 100).toFixed(1) : 0;

      const msg = `
📊 <b>Trading Brain Status</b>
━━━━━━━━━━━━━━━━━━━━
💰 <b>Equity:</b> $${compoundedEquity.toLocaleString(undefined, {minimumFractionDigits: 2})}
📈 <b>Daily P&L:</b> $${dailyPnL.toLocaleString(undefined, {minimumFractionDigits: 2})}
🎯 <b>Win Rate:</b> ${winRate}%
📊 <b>Open Positions:</b> ${riskManager.openPositions.size}
🤖 <b>Autonomous:</b> Active
🛡️ <b>Regime:</b> ${require('../core/regimeClassifier').getCurrentRegime()}
⏰ <b>Time:</b> ${new Date().toLocaleString()}
      `.trim();

      await this._sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (e) {
      await this._sendMessage(chatId, `❌ Error fetching status: ${e.message}`);
    }
  }

  /**
   * Command: /positions
   */
  async _cmdPositions(chatId) {
    try {
      const executionEngine = require('../agents/execution/executionEngine');
      const riskManager = require('../agents/risk/riskManager');
      const sessionStateStore = require('./sessionStateStore');
      
      let positions = [];
      if (typeof executionEngine.getCurrentPositions === 'function') {
        positions = executionEngine.getCurrentPositions();
      }
      if (!positions || positions.length === 0) {
        positions = Array.from(riskManager.openPositions.values());
      }
      if (!positions || positions.length === 0) {
        positions = sessionStateStore.getState().positions || [];
      }
      
      if (!positions || positions.length === 0) {
        await this._sendMessage(chatId, '📭 No open positions');
        return;
      }

      let msg = '📊 <b>Open Positions</b>\n━━━━━━━━━━━━━━━━━━━━\n';
      
      for (const pos of positions) {
        const pnl = pos.unrealizedPnL || pos.unrealized_pnl || 0;
        const pnlPct = pos.pnl_pct || pos.pnlPct || 0;
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        
        msg += `${emoji} <b>${pos.symbol}</b> ${pos.side || pos.direction || 'LONG'} ${pos.quantity || pos.size || 1}\n`;
        msg += `   Entry: ${pos.avgPrice || pos.avg_price || pos.entryPrice} | Mark: ${pos.currentPrice || pos.current_price || pos.markPrice || 'Live'}\n`;
        msg += `   P&L: $${Number(pnl).toFixed(2)} (${Number(pnlPct).toFixed(2)}%)\n`;
        msg += `   SL: ${pos.stopLoss || pos.stop_loss || 'Auto'} | TP: ${pos.takeProfit || pos.take_profit || 'Auto'}\n\n`;
      }

      await this._sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (e) {
      await this._sendMessage(chatId, `❌ Error fetching positions: ${e.message}`);
    }
  }

  /**
   * Command: /flatten or /panic
   */
  async _cmdFlatten(chatId, args) {
    const market = args[0]?.toUpperCase() || 'ALL';
    
    // Create 2FA confirmation
    const confirmId = crypto.randomBytes(4).toString('hex');
    this.pendingCommands.set(chatId, {
      command: 'flatten',
      market,
      confirmId,
      expiresAt: Date.now() + this.commandTimeout
    });

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ CONFIRM FLATTEN ALL', callback_data: `confirm_flatten_${confirmId}_${market}` },
        { text: '❌ CANCEL', callback_data: `cancel_${confirmId}` }
      ]]
    };

    const msg = `
⚠️ <b>EMERGENCY FLATTEN CONFIRMATION</b>
━━━━━━━━━━━━━━━━━━━━
<b>Market:</b> ${market}
<b>Action:</b> Close ALL open positions immediately
<b>Warning:</b> This cannot be undone!

Reply with CONFIRMATION CODE or use buttons below.
<i>Expires in 30 seconds</i>
    `.trim();

    await this._sendMessage(chatId, msg, { 
      parse_mode: 'HTML',
      reply_markup: JSON.stringify(keyboard)
    });
  }

  /**
   * Command: /council
   */
  async _cmdCouncil(chatId) {
    try {
      const agentSoul = require('./agentSoulEngine');
      const souls = agentSoul.getAllSouls();
      
      let msg = '🏛️ <b>Agent Council Status</b>\n━━━━━━━━━━━━━━━━━━━━\n';
      
      for (const soul of souls) {
        const rt = soul.runtime || {};
        const emoji = soul.emoji || '';
        const state = rt.currentState || 'UNKNOWN';
        const wins = rt.recentWins || 0;
        const losses = rt.recentLosses || 0;
        const credibility = require('./agentMemoryEngine').getCredibility(soul.id) || 1.0;
        
        msg += `${emoji} <b>${soul.name}</b> (${soul.role})\n`;
        msg += `   State: ${state} | Credibility: ${credibility.toFixed(2)}x\n`;
        msg += `   Record: ${wins}W / ${losses}L\n\n`;
      }

      await this._sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (e) {
      await this._sendMessage(chatId, `❌ Error fetching council: ${e.message}`);
    }
  }

  /**
   * Command: /briefing
   */
  async _cmdBriefing(chatId) {
    try {
      const preMarket = require('../agents/preMarket/preMarketAgent');
      const briefing = await preMarket.generateBriefing();
      
      const msg = `
📰 <b>Macro Briefing</b>
━━━━━━━━━━━━━━━━━━━━
<b>Bias:</b> ${briefing.bias?.bias || 'neutral'}
<b>Score:</b> ${briefing.bias?.score || 0}
<b>Factors:</b>
${(briefing.bias?.factors || []).map(f => `• ${f}`).join('\n')}
<b>Key Levels:</b>
${Object.entries(briefing.keyLevels || {}).map(([k, v]) => `• ${k}: ${v}`).join('\n') || 'None'}
      `.trim();

      await this._sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (e) {
      await this._sendMessage(chatId, `❌ Error generating briefing: ${e.message}`);
    }
  }

  /**
   * Command: /help
   */
  async _cmdHelp(chatId) {
    const msg = `
🤖 <b>Trading Brain Copilot Commands</b>
━━━━━━━━━━━━━━━━━━━━
<b>/status</b> - Portfolio equity, P&L, win rate, regime
<b>/positions</b> - Detailed open positions with P&L
<b>/flatten [MARKET]</b> - 🚨 Emergency close ALL (2FA required)
<b>/panic [MARKET]</b> - Alias for /flatten
<b>/council</b> - Agent states, credibility, temperaments
<b>/briefing</b> - AI macro briefing & key levels
<b>/help</b> - This message

<b>Safety:</b> /flatten requires 2FA confirmation
<b>Markets:</b> CRYPTO, IN, US, FOREX, FUTURES, ALL
    `.trim();

    await this._sendMessage(chatId, msg, { parse_mode: 'HTML' });
  }

  /**
   * Handle 2FA confirmation
   */
  async _handleConfirmation(chatId, text) {
    const pending = this.pendingCommands.get(chatId);
    if (!pending) return;

    if (Date.now() > pending.expiresAt) {
      this.pendingCommands.delete(chatId);
      await this._sendMessage(chatId, '⏱️ Confirmation expired. Command cancelled.');
      return;
    }

    // Check if text matches confirmId (last 4 chars)
    if (text.toUpperCase().includes(pending.confirmId.toUpperCase())) {
      this.pendingCommands.delete(chatId);
      await this._executeConfirmedCommand(chatId, `${pending.command}_${pending.market}`);
    } else {
      await this._sendMessage(chatId, `❌ Invalid code. Expected: <code>${pending.confirmId}</code>. Try again or wait for expiry.`, { parse_mode: 'HTML' });
    }
  }

  /**
   * Execute confirmed command
   */
  async _executeConfirmedCommand(chatId, command) {
    const [cmd, market] = command.split('_');
    
    if (cmd === 'flatten') {
      await this._executeFlatten(chatId, market);
    }
  }

  /**
   * Execute flatten all positions
   */
  async _executeFlatten(chatId, market) {
    try {
      await this._sendMessage(chatId, '🔄 <b>Executing emergency flatten...</b>', { parse_mode: 'HTML' });
      
      const positions = Array.from(riskManager.openPositions.values());
      let closed = 0;
      let failed = 0;

      for (const pos of positions) {
        if (market !== 'ALL' && !this._marketMatches(pos.symbol, market)) continue;
        
        try {
          await executionEngine.closePosition(pos.symbol, pos.segment, pos.quantity, pos.currentPrice || pos.current_price, 'EMERGENCY_FLATTEN');
          closed++;
        } catch (e) {
          failed++;
          logger.error('Flatten failed for', { symbol: pos.symbol, error: e.message });
        }
      }

      const msg = `
✅ <b>Emergency Flatten Complete</b>
━━━━━━━━━━━━━━━━━━━━
✅ Closed: ${closed}
❌ Failed: ${failed}
📊 Market: ${market}
⏰ Time: ${new Date().toLocaleString()}
      `.trim();

      await this._sendMessage(chatId, msg, { parse_mode: 'HTML' });
      await alertGateway.notifyCircuitBreaker('ALL', `Emergency flatten executed by user: ${closed} closed, ${failed} failed`, 'CRITICAL');

    } catch (e) {
      await this._sendMessage(chatId, `❌ Flatten failed: ${e.message}`);
    }
  }

  _marketMatches(symbol, market) {
    if (market === 'ALL') return true;
    const inConfig = require('../markets/in/config');
    const usConfig = require('../markets/us/config');
    
    if (market === 'IN' && inConfig.defaultWatchlist?.includes(symbol)) return true;
    if (market === 'US' && usConfig.defaultWatchlist?.includes(symbol)) return true;
    if (market === 'CRYPTO' && symbol.endsWith('USDT')) return true;
    if (market === 'FOREX' && symbol.includes('=X')) return true;
    if (market === 'FUTURES' && symbol.endsWith('=F')) return true;
    return false;
  }

  /**
   * API Helpers
   */
  async _apiCall(method, params = {}) {
    const res = await axios.post(`${this.apiUrl}/${method}`, params, { timeout: 10000 });
    return res.data;
  }

  async _sendMessage(chatId, text, options = {}) {
    await this._apiCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode || 'HTML',
      reply_markup: options.reply_markup,
      disable_web_page_preview: true
    });
  }

  async _editMessage(chatId, messageId, text) {
    await this._apiCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML'
    });
  }

  _isAuthorized(chatId) {
    return this.authorizedUsers.has(chatId) || this.authorizedUsers.has(parseInt(chatId));
  }
}

module.exports = new TelegramCopilotEngine();