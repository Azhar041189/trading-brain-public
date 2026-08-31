const axios = require('axios');
const http = require('http');
const https = require('https');
const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('TelegramDispatcher');

// Force IPv4 HTTPS Agent to avoid cloud ENETUNREACH IPv6 routing errors
const ipv4HttpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  timeout: 10000
});

/**
 * TelegramAlertDispatcher - Resilient, Rate-Limited Real-Time Push Alerts
 * Includes leaky-bucket rate limiter, 429 backoff handling, IPv4 pinning, and non-blocking background queue.
 */
class TelegramAlertDispatcher {
  constructor() {
    this.reloadCredentials();
    this.alertLog = [];
    this.queue = [];
    this.isProcessingQueue = false;
    this.rateLimitUntil = 0;
    this.consecutiveFailures = 0;
    this.circuitBreakerUntil = 0;
    this.lastSentBySymbol = new Map();

    // Start background queue worker (processes every 1200ms)
    this.queueInterval = setInterval(() => this.processQueue(), 1200);
  }

  getInstanceBadge() {
    if (process.env.INSTANCE_TAG) {
      return process.env.INSTANCE_TAG.toUpperCase().includes('PROD') || process.env.INSTANCE_TAG.toUpperCase().includes('LIVE')
        ? '☁️ [LIVE CLOUD]'
        : '💻 [LOCAL TESTBED]';
    }
    // Auto-detect by OS environment / platform
    const isWindowsLocal = process.platform === 'win32';
    const isLocalhost = !process.env.PUBLIC_IP || process.env.PUBLIC_IP === 'localhost' || process.env.PUBLIC_IP === '127.0.0.1';
    if (isWindowsLocal || isLocalhost) {
      return '💻 [LOCAL TESTBED]';
    }
    return '☁️ [LIVE CLOUD VM]';
  }

  reloadCredentials() {
    const rawToken = process.env.TELEGRAM_BOT_TOKEN;
    const rawChat = process.env.TELEGRAM_CHAT_ID;
    this.botToken = (rawToken && rawToken !== 'your_bot_token' && rawToken.trim().length > 10) ? rawToken.trim() : null;
    this.chatId = (rawChat && rawChat !== 'your_chat_id' && rawChat.trim().length > 0) ? rawChat.trim() : null;
  }

  /**
   * Enqueue a message for rate-limited, resilient dispatch
   */
  async sendMessage(text, parseMode = 'HTML', symbolKey = null) {
    // Check if local alerts are explicitly muted
    if (process.env.DISABLE_LOCAL_TELEGRAM_ALERTS === 'true' && this.getInstanceBadge().includes('LOCAL')) {
      return { success: true, muted: true };
    }
    this.reloadCredentials();
    const entry = {
      timestamp: new Date().toISOString(),
      text,
      status: 'QUEUED'
    };

    // If unconfigured or dummy credentials, simulate gracefully
    if (!this.botToken || !this.chatId) {
      entry.status = 'SIMULATED';
      this.alertLog.unshift(entry);
      if (this.alertLog.length > 50) this.alertLog.pop();
      return { success: true, simulated: true };
    }

    // Debounce rapid bursts on the exact same symbol (minimum 5s interval per symbol)
    if (symbolKey) {
      const lastSent = this.lastSentBySymbol.get(symbolKey) || 0;
      if (Date.now() - lastSent < 5000) {
        return { success: true, throttled: true };
      }
      this.lastSentBySymbol.set(symbolKey, Date.now());
    }

    // Add to leaky bucket queue (cap queue at 20 items to prevent backpressure)
    if (this.queue.length > 20) {
      this.queue.shift(); // Drop oldest alert to preserve fresh signals
    }

    this.queue.push({ text, parseMode, entry });
    return { success: true, queued: true };
  }

  /**
   * Process queued messages respecting Telegram rate limits (1 msg / 1.2s)
   */
  async processQueue() {
    if (this.isProcessingQueue || this.queue.length === 0) return;
    
    // Check if in 429 rate limit backoff cooldown
    if (Date.now() < this.rateLimitUntil) return;
    
    // Check if in circuit breaker cooldown after consecutive network drops
    if (Date.now() < this.circuitBreakerUntil) return;

    this.isProcessingQueue = true;
    const item = this.queue.shift();

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await axios.post(url, {
        chat_id: this.chatId,
        text: item.text,
        parse_mode: item.parseMode || 'HTML',
        disable_web_page_preview: true
      }, { 
        timeout: 10000,
        httpsAgent: ipv4HttpsAgent
      });

      this.consecutiveFailures = 0;
      item.entry.status = 'SENT';
      this.alertLog.unshift(item.entry);
      if (this.alertLog.length > 50) this.alertLog.pop();
      logger.info('✅ [Telegram Alert] Live push broadcasted successfully');
    } catch (e) {
      const status = e.response?.status;
      const retryAfter = e.response?.data?.parameters?.retry_after;

      if (status === 429) {
        // Handle Telegram 429 Rate Limit
        const cooldownSec = retryAfter ? parseInt(retryAfter, 10) : 5;
        this.rateLimitUntil = Date.now() + (cooldownSec * 1000);
        logger.warn(`⚠️ [Telegram Rate Limit] 429 received, backing off for ${cooldownSec}s`);
        // Re-queue item to retry after cooldown
        this.queue.unshift(item);
      } else if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'ENETUNREACH' || e.code === 'EAI_AGAIN') {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 3) {
          // Pause queue for 30s to prevent socket churn on cloud network hiccups
          this.circuitBreakerUntil = Date.now() + 30000;
          logger.warn(`⚠️ [Telegram Network] Socket timeout/unreachable (${e.code}). Pausing dispatches for 30s.`);
        } else {
          logger.warn(`⚠️ [Telegram Network] Transient drop (${e.code}). Will retry.`);
        }
      } else {
        // Fallback for HTML tag syntax errors: retry as plain text
        try {
          const plainText = item.text.replace(/<[^>]*>?/gm, '');
          const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
          await axios.post(url, {
            chat_id: this.chatId,
            text: plainText,
            disable_web_page_preview: true
          }, { timeout: 8000, httpsAgent: ipv4HttpsAgent });
          item.entry.status = 'SENT_PLAIN';
          this.alertLog.unshift(item.entry);
        } catch (err2) {
          logger.warn('⚠️ [Telegram Alert] Message dropped:', { error: e.message });
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Broadcast Trade Entry Card
   */
  async notifyTradeEntry(trade) {
    const isLong = trade.direction === 'LONG' || trade.direction === 'BUY';
    const sym = trade.symbol || 'ASSET';
    const instanceBadge = this.getInstanceBadge();
    const card = `
🚨 <b>${instanceBadge} NEW TRADE ENTRY</b>
━━━━━━━━━━━━━━━━━━━━
🎯 <b>Asset:</b> <code>${sym}</code>
🧭 <b>Action:</b> ${isLong ? '🟢 <b>BUY / LONG</b>' : '🔴 <b>SELL / SHORT</b>'}
💵 <b>Entry Price:</b> <code>${trade.entryPrice}</code>
🛡️ <b>Stop Loss:</b> <code>${trade.stopLoss || '-'}</code>
🎯 <b>Take Profit:</b> <code>${trade.takeProfit || '-'}</code>
📊 <b>Confidence:</b> <code>${trade.confidence || '85%'}</code>
⚡ <b>Strategy:</b> <i>${trade.strategy || 'Multi-Agent Consensus'}</i>
━━━━━━━━━━━━━━━━━━━━
⏰ <i>${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })} IST | ${instanceBadge}</i>
    `.trim();
    return this.sendMessage(card, 'HTML', `entry_${sym}`);
  }

  /**
   * Broadcast Auto-Exit Card
   */
  async notifyTradeExit(exit) {
    const isWin = (exit.profitPct !== undefined ? exit.profitPct : (exit.pnlUSD || 0)) >= 0;
    const sym = exit.symbol || 'ASSET';
    const profitPct = exit.profitPct !== undefined ? parseFloat(exit.profitPct) : 0;
    const pnlVal = exit.pnlUSD !== undefined ? parseFloat(exit.pnlUSD) : 0;
    const instanceBadge = this.getInstanceBadge();
    const card = `
${isWin ? `💰 <b>${instanceBadge} TAKE PROFIT HIT</b>` : `🛡️ <b>${instanceBadge} STOP LOSS TRIGGERED</b>`}
━━━━━━━━━━━━━━━━━━━━
🎯 <b>Asset:</b> <code>${sym}</code>
💵 <b>Exit Price:</b> <code>${exit.exitPrice}</code>
📈 <b>P&L:</b> ${isWin ? '🟢' : '🔴'} <b>${isWin ? '+' : ''}${profitPct.toFixed(2)}%</b> (${isWin ? '+' : ''}${pnlVal.toFixed(2)})
⚡ <b>Reason:</b> <code>${exit.reason || 'Auto-Exit Sentinel'}</code>
━━━━━━━━━━━━━━━━━━━━
⏰ <i>${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })} IST | ${instanceBadge}</i>
    `.trim();
    return this.sendMessage(card, 'HTML', `exit_${sym}`);
  }

  getRecentAlerts() {
    return this.alertLog;
  }
}

module.exports = new TelegramAlertDispatcher();
