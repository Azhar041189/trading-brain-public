const https = require('https');
const config = require('../config');
const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('AlertGateway');

/**
 * AlertGateway - Dispatches beautifully formatted, compact real-time trading alerts to Telegram & Discord Webhooks.
 */
class AlertGateway {
  constructor() {
    this.telegramToken = config.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
    this.telegramChatId = config.telegram?.chatId || process.env.TELEGRAM_CHAT_ID || null;
    this.discordWebhook = config.discord?.webhookUrl || process.env.DISCORD_WEBHOOK_URL || null;
    this.discordUsername = config.discord?.username || 'Trading Brain';
    this.discordAvatarUrl = config.discord?.avatarUrl || 'https://i.imgur.com/TradingBrain.png';
    this.telegramEnabled = Boolean(this.telegramToken && this.telegramChatId);
    this.discordEnabled = Boolean(this.discordWebhook);
    this.enabled = this.telegramEnabled || this.discordEnabled;
    this.alertHistory = [];
  }

  _getInstanceBadge() {
    if (process.env.INSTANCE_TAG) {
      return process.env.INSTANCE_TAG.toUpperCase().includes('PROD') || process.env.INSTANCE_TAG.toUpperCase().includes('LIVE')
        ? '☁️ [LIVE CLOUD]'
        : '💻 [LOCAL TESTBED]';
    }
    const isWindowsLocal = process.platform === 'win32';
    const isLocalhost = !process.env.PUBLIC_IP || process.env.PUBLIC_IP === 'localhost' || process.env.PUBLIC_IP === '127.0.0.1';
    if (isWindowsLocal || isLocalhost) {
      return '💻 [LOCAL TESTBED]';
    }
    return '☁️ [LIVE CLOUD VM]';
  }

  _isIndianAsset(symbol, market) {
    if (market === 'IN') return true;
    if (!symbol) return false;
    const sym = String(symbol).toUpperCase();
    if (sym.endsWith('.NS') || sym.endsWith('.BO')) return true;
    const inSymbols = [
      'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
      'KOTAKBANK', 'SBIN', 'BHARTIARTL', 'ITC', 'LT', 'BAJFINANCE', 'TATAMOTORS', 'TATASTEEL',
      'TATACONSUM', 'HINDALCO', 'DRREDDY', 'CIPLA', 'APOLLOHOSP', 'HEROMOTOCO', 'EICHERMOT',
      'INDUSINDBK', 'SHRIRAMFIN', 'TECHM', 'HDFCLIFE', 'SBILIFE', 'GRASIM'
    ];
    return inSymbols.some(s => sym === s || sym.startsWith(s));
  }

  _getCurrency(symbol, market) {
    return this._isIndianAsset(symbol, market) ? '₹' : '$';
  }

  _formatPrice(val, symbol, market) {
    if (val === undefined || val === null || isNaN(val)) return '0.00';
    const num = parseFloat(val);
    const curr = this._getCurrency(symbol, market);
    if (this._isIndianAsset(symbol, market)) {
      return `${curr}${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `${curr}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  _formatStrategy(strategy) {
    if (!strategy) return 'Multi-Agent Consensus';
    const s = String(strategy).toLowerCase().replace(/_/g, ' ');
    if (s.includes('momentum') || s.includes('crossover')) return 'Momentum EMA Crossover';
    if (s.includes('reversion') || s.includes('bb')) return 'Bollinger Mean Reversion';
    if (s.includes('breakout') || s.includes('donchian')) return 'Donchian Breakout Matrix';
    if (s.includes('vwap')) return 'Institutional VWAP Flow';
    if (s.includes('arbitrage') || s.includes('arb')) return 'Cross-Venue Arbitrage';
    return strategy.charAt(0).toUpperCase() + strategy.slice(1);
  }

  _formatVotes(votes) {
    if (!votes) return null;
    let voteArr = votes;
    if (typeof votes === 'string') {
      try { voteArr = JSON.parse(votes); } catch (e) { return null; }
    }
    if (!Array.isArray(voteArr) || voteArr.length === 0) return null;

    const agentLabels = {
      'HTF_Trend_Sentinel': '📈 HTF Trend',
      'Macro_Research_Agent': '🌐 Macro Regime',
      'Technical_Vetting_Agent': '🔬 Technical Vetting',
      'Options_Derivatives_Auditor': '🎯 Options PCR',
      'Volume_Shocker_Sentinel': '🌊 Volume Flow',
      'Risk_Reward_Auditor': '🛡️ Risk Sentinel'
    };

    return voteArr.map(v => {
      const label = agentLabels[v.agent] || (v.agent ? v.agent.replace(/_/g, ' ') : 'Specialist');
      const score = Math.round((parseFloat(v.score || 0)) * 100);
      const reason = v.reason || 'Approved';
      return `• *${label}:* \`${score}%\` — _${reason}_`;
    }).join('\n');
  }

  async sendTelegram(message) {
    this.alertHistory.unshift({ timestamp: new Date().toISOString(), message, channel: 'telegram' });
    if (this.alertHistory.length > 50) this.alertHistory.pop();

    const telegramDispatcher = require('./telegramAlertDispatcher');
    return telegramDispatcher.sendMessage(message, 'Markdown');
  }

  async sendDiscord(message) {
    this.alertHistory.unshift({ timestamp: new Date().toISOString(), message, channel: 'discord' });
    if (this.alertHistory.length > 50) this.alertHistory.pop();

    if (!this.discordEnabled) return { success: true, simulated: true };

    return new Promise((resolve) => {
      const payload = JSON.stringify({
        username: this.discordUsername,
        avatar_url: this.discordAvatarUrl,
        content: message
      });

      const url = new URL(this.discordWebhook);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        resolve({ success: res.statusCode === 200 || res.statusCode === 204 });
      });

      req.on('error', (err) => {
        logger.warn('Discord dispatch error:', { error: err.message });
        resolve({ success: false, error: err.message });
      });

      req.write(payload);
      req.end();
    });
  }

  async sendAlert(message) {
    const results = [];
    if (this.telegramEnabled) {
      results.push(await this.sendTelegram(message));
    }
    if (this.discordEnabled) {
      results.push(await this.sendDiscord(message));
    }
    return results;
  }

  notifyTradeExecuted(trade) {
    const isLong = trade.direction === 'LONG' || trade.direction === 'BUY';
    const icon = isLong ? '🟢' : '🔴';
    const symbol = trade.symbol || 'UNKNOWN';
    const market = trade.market || (this._isIndianAsset(symbol) ? 'IN' : 'CRYPTO');
    const entryStr = this._formatPrice(trade.entryPrice, symbol, market);
    const slStr = this._formatPrice(trade.stopLoss, symbol, market);
    const tpStr = this._formatPrice(trade.takeProfit, symbol, market);
    const confPct = Math.round((parseFloat(trade.confidence || 0.85)) * 100);
    const strategyName = this._formatStrategy(trade.strategy);
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const badge = this._getInstanceBadge();

    const lines = [
      `${icon} *${badge} TRADE EXECUTED [${market}]*`,
      `🎯 *Asset:* \`${symbol}\` | *Side:* *${isLong ? 'LONG ↗️' : 'SHORT ↘️'}* | *Qty:* \`${trade.quantity || 1}\``,
      `💵 *Entry:* \`${entryStr}\` | ⚖️ *R:R:* \`${trade.riskReward || 1.8}x\``,
      `🛑 *SL:* \`${slStr}\` | 🎯 *TP:* \`${tpStr}\``,
      `⚡ *Strategy:* _${strategyName}_ (\`${confPct}% Conf\`)`,
      `⏰ _${timeStr} IST | ${badge}_`
    ];

    return this.sendAlert(lines.join('\n'));
  }

  notifyHermesEntryCleared(trade) {
    const isLong = trade.direction === 'LONG' || trade.direction === 'BUY';
    const icon = isLong ? '🟢' : '🔴';
    const symbol = trade.symbol || 'UNKNOWN';
    const market = trade.market || (this._isIndianAsset(symbol) ? 'IN' : 'CRYPTO');
    const entryStr = this._formatPrice(trade.entryPrice, symbol, market);
    const slStr = this._formatPrice(trade.stopLoss, symbol, market);
    const tpStr = this._formatPrice(trade.takeProfit, symbol, market);
    const confPct = Math.round((parseFloat(trade.confidence || 0.85)) * 100);
    const strategyName = this._formatStrategy(trade.strategy);
    const votesFormatted = this._formatVotes(trade.consensusVotes);
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const badge = this._getInstanceBadge();

    const lines = [
      `${icon} *${badge} HERMES ENTRY CLEARED*`,
      `🎯 *Asset:* \`${symbol}\` [${market}] | *Side:* *${isLong ? 'LONG ↗️' : 'SHORT ↘️'}*`,
      `💵 *Entry:* \`${entryStr}\` | *SL:* \`${slStr}\` | *TP:* \`${tpStr}\``,
      `📊 *Confidence:* \`${confPct}%\` | ⚡ *Strategy:* _${strategyName}_`
    ];

    if (votesFormatted) {
      lines.push('🏛️ *Committee Breakdown:*');
      lines.push(votesFormatted);
    }

    lines.push(`⏰ _${timeStr} IST | ${badge}_`);

    return this.sendAlert(lines.join('\n'));
  }

  notifyAutoExit(pos, exitType) {
    const isTP = exitType === 'TAKE_PROFIT' || exitType === 'AUTO_TAKE_PROFIT';
    const icon = isTP ? '💰' : '🛡️';
    const typeLabel = isTP ? 'TAKE PROFIT HIT' : 'STOP LOSS TRIGGERED';
    const symbol = pos.symbol || 'UNKNOWN';
    const market = pos.market || (this._isIndianAsset(symbol) ? 'IN' : 'CRYPTO');
    const exitPrice = pos.currentPrice || pos.exitPrice || 0;
    const exitPriceStr = this._formatPrice(exitPrice, symbol, market);
    const pnl = pos.realizedPnL !== undefined ? pos.realizedPnL : (pos.unrealizedPnL || 0);
    const pnlPct = pos.profitPct !== undefined ? pos.profitPct : (pos.avgPrice ? ((exitPrice - pos.avgPrice) / pos.avgPrice * 100) : 0);
    const isWin = pnl >= 0;
    const pnlFormatted = this._formatPrice(Math.abs(pnl), symbol, market);
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const badge = this._getInstanceBadge();

    const lines = [
      `${icon} *${badge} AUTO-EXIT: ${typeLabel}*`,
      `🎯 *Asset:* \`${symbol}\` (${pos.side || (pos.quantity >= 0 ? 'LONG' : 'SHORT')})`,
      `💵 *Exit:* \`${exitPriceStr}\``,
      `📈 *P&L:* ${isWin ? '🟢' : '🔴'} *${isWin ? '+' : '-'}${Math.abs(pnlPct).toFixed(2)}%* (${isWin ? '+' : '-'}${pnlFormatted})`,
      `⚡ *Reason:* \`${exitType}\``,
      `⏰ _${timeStr} IST | ${badge}_`
    ];

    return this.sendAlert(lines.join('\n'));
  }

  notifyRegimeShift(oldRegime, newRegime, symbol = 'MARKET') {
    const regimeEmoji = {
      'TRENDING_BULL': '🐂',
      'TRENDING_BEAR': '🐻',
      'RANGING_CHOPPY': '📊',
      'VOLATILE_CRASH': '⚡',
      'HIGH_VOLATILITY_PANIC': '🌪️'
    };

    const oldEmoji = regimeEmoji[oldRegime] || '📈';
    const newEmoji = regimeEmoji[newRegime] || '📈';
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    const lines = [
      `🔄 *REGIME SHIFT [${symbol}]*`,
      `${oldEmoji} *${oldRegime}* ➔ ${newEmoji} *${newRegime}*`,
      `⚡ *Adaptation:* ${newRegime === 'TRENDING_BULL' || newRegime === 'VOLATILE_CRASH' ? '`Mean Reversion OFF`' : '`Mean Reversion ON`'} | ${newRegime === 'TRENDING_BEAR' ? '`SHORT MODE`' : (newRegime === 'TRENDING_BULL' ? '`LONG MODE`' : '`NEUTRAL`')}`,
      `⏰ _${timeStr} IST | Macro Sentinel_`
    ];

    return this.sendAlert(lines.join('\n'));
  }

  notifyCircuitBreaker(symbol, reason, severity = 'HIGH') {
    const severityEmoji = severity === 'CRITICAL' ? '🚨' : '⚠️';
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    const lines = [
      `${severityEmoji} *CIRCUIT BREAKER: ${severity}*`,
      `🎯 *Symbol:* \`${symbol}\` — _${reason}_`,
      `🛡️ *Protocol:* New entries paused. Active positions shielded.`,
      `⏰ _${timeStr} IST | Risk Protocol_`
    ];

    return this.sendAlert(lines.join('\n'));
  }

  notifyBreakevenTriggered(pos) {
    const symbol = pos.symbol || 'UNKNOWN';
    const market = pos.market || (this._isIndianAsset(symbol) ? 'IN' : 'CRYPTO');
    const entryStr = this._formatPrice(pos.entryPrice || pos.avgPrice, symbol, market);
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    const lines = [
      `🛡️ *BREAKEVEN RATCHET ACTIVATED*`,
      `🎯 *Symbol:* \`${symbol}\` (*${pos.side || 'LONG'}* @ \`${entryStr}\`)`,
      `✨ *Action:* SL moved to entry. Downside risk is now $0.00!`,
      `⏰ _${timeStr} IST | Capital Preservation_`
    ];

    return this.sendAlert(lines.join('\n'));
  }

  notifyMilestoneAchieved(milestone, vaultVal) {
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    const lines = [
      `🎉 *MILESTONE ACHIEVED: ${milestone.name || 'Target Level'}*`,
      `🔒 *User Savings Vault:* \`$${(vaultVal || 0).toLocaleString()}\` (Locked & Safe)`,
      `🚀 *Status:* Seed Protected. Compounding House Money!`,
      `⏰ _${timeStr} IST | 100x Growth Protocol_`
    ];

    return this.sendAlert(lines.join('\n'));
  }
}

module.exports = new AlertGateway();
