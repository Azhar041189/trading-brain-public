/**
 * @file quantBridgeClient.js
 * @description Node.js wrapper for the high-performance Python Quant Bridge
 * Ingests capabilities from Microsoft Qlib, VectorBT, FinAgent, and FinRL.
 */

const { spawn } = require('child_process');
const path = require('path');
const { createAgentLogger } = require('./logger');

const logger = createAgentLogger('QuantBridgeClient');

class QuantBridgeClient {
  constructor() {
    this.scriptPath = path.join(__dirname, '../python/quant_bridge/quant_hub.py');
    this.pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
  }

  /**
   * Execute an action via Python Quant Bridge
   */
  async invokeAction(action, payload) {
    return new Promise((resolve) => {
      try {
        const payloadStr = JSON.stringify(payload);
        const child = spawn(this.pythonExecutable, [this.scriptPath, action, payloadStr], {
          cwd: path.dirname(this.scriptPath)
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0 && stdout.trim()) {
            try {
              const res = JSON.parse(stdout.trim());
              return resolve(res);
            } catch (e) {
              logger.warn(`?? JSON parse error from quant bridge: ${e.message}`);
            }
          }
          // Fallback if python is missing or failed
          resolve({ success: false, fallback: true, error: stderr || 'Execution non-zero' });
        });

        child.on('error', (err) => {
          resolve({ success: false, fallback: true, error: err.message });
        });
      } catch (err) {
        resolve({ success: false, fallback: true, error: err.message });
      }
    });
  }

  /**
   * Compute Qlib Alpha158 Factor Vector
   */
  async getAlpha158(candles) {
    return this.invokeAction('qlib_alpha158', { candles });
  }

  /**
   * Run VectorBT Matrix Parameter Sweep
   */
  async runVectorBTSweep(closes) {
    return this.invokeAction('vectorbt_sweep', { closes });
  }

  /**
   * Extract FinAgent Candlestick Geometry
   */
  async getChartGeometry(candles) {
    return this.invokeAction('finagent_geometry', { candles });
  }

  /**
   * Compute Aim Portfolio Sizing Transition
   */
  async getAimPortfolioSizing(currentWeight, targetWeight, turnoverCostBps = 7.5, horizon = 24) {
    return this.invokeAction('finrl_aim_policy', {
      current_weight: currentWeight,
      target_weight: targetWeight,
      turnover_cost_bps: turnoverCostBps,
      holding_horizon_bars: horizon
    });
  }
}

module.exports = new QuantBridgeClient();
