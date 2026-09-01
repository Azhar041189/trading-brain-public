const winston = require('winston');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const logDir = config.logging.dir;
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Custom WebSocket Broadcast Transport — inherited by ALL child (agent) loggers
// server.js registers a callback via logger.onLogEntry() so every agent log
// (ExecutionEngine, RiskManager, ConsensusEngine, etc.) is streamed to the dashboard.
const _logListeners = [];

class BroadcastTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => {
      const entry = {
        timestamp: new Date().toISOString(),
        level: info.level ? info.level.replace(/\u001b\[\d+m/g, '') : 'info', // strip ANSI color codes
        message: info.message || '',
        meta: {}
      };
      // Extract agent name from child logger metadata
      if (info.agent) entry.meta.agent = info.agent;
      // Copy any extra metadata (symbol, market, etc.)
      const skipKeys = new Set(['timestamp', 'level', 'message', 'agent', 'splat']);
      for (const key of Object.keys(info)) {
        if (!skipKeys.has(key) && typeof info[key] !== 'object') {
          entry.meta[key] = info[key];
        }
      }

      for (const listener of _logListeners) {
        try { listener(entry); } catch (_) {}
      }
    });
    callback();
  }
}

const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
      return `${timestamp} [${level.toUpperCase()}]: ${message} ${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ 
      filename: path.join(logDir, 'trading-brain.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10
    }),
    new winston.transports.File({ 
      filename: path.join(logDir, 'errors.log'), 
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10
    }),
    new BroadcastTransport()
  ]
});

// Create child loggers for each agent
const createAgentLogger = (agentName) => {
  return logger.child({ agent: agentName });
};

// Register a callback that fires for every log entry (parent + all child loggers)
const onLogEntry = (callback) => {
  if (typeof callback === 'function') {
    _logListeners.push(callback);
  }
};

module.exports = { logger, createAgentLogger, onLogEntry };