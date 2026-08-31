/**
 * 🛡️ Prediction Market Compliance & Sandbox Governance Gate (Phase P-1 Hardened)
 * 
 * Hard Invariants:
 * 1. STARTUP_REFUSED if any signing keys (PRIVATE_KEY, etc.) exist in the process environment.
 * 2. walletSigningEnabled is permanently false.
 * 3. realOrderPlacementEnabled is permanently false.
 * 4. Geoblock checks fail-closed on network errors, timeouts, or indeterminate responses.
 */

const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('PredictionComplianceGate');

const PROHIBITED_SIGNING_KEYS = [
  'POLYMARKET_PRIVATE_KEY',
  'POLY_PRIVATE_KEY',
  'PRIVATE_KEY',
  'ETH_PRIVATE_KEY',
  'SIGNER_KEY',
  'WALLET_PRIVATE_KEY',
  'PK'
];

class PredictionComplianceGate {
  constructor() {
    this.researchMode = true;
    this.walletSigningEnabled = false;
    this.realOrderPlacementEnabled = false;
    this.enforceZeroSigningInvariant();
  }

  /**
   * Hardened Startup Invariant: Refuses startup if any signing credential exists
   */
  enforceZeroSigningInvariant() {
    for (const key of PROHIBITED_SIGNING_KEYS) {
      if (process.env[key] && process.env[key].trim() !== '') {
        const errMsg = `🚨 [ComplianceGate] FATAL STARTUP_REFUSED: Prohibited signing credential detected in environment (${key}). Prediction Market Research Candidate must never run in a process with access to signing keys.`;
        logger.error(errMsg);
        throw new Error(errMsg);
      }
    }
  }

  /**
   * Verify environment state before running any P-1..P3 paper module
   */
  verifyEnvironment() {
    this.enforceZeroSigningInvariant();

    if (this.walletSigningEnabled || this.realOrderPlacementEnabled) {
      const errMsg = '🚨 [ComplianceGate] FATAL SECURITY VIOLATION: Wallet signing and live order placement are strictly forbidden in PREDICTION_MARKET_RESEARCH_CANDIDATE_V1 (P-1 through P3).';
      logger.error(errMsg);
      throw new Error(errMsg);
    }
    return true;
  }

  /**
   * Fail-Closed Geoblock Check against Polymarket compliance endpoints
   * @param {string} ipAddress - Optional client IP
   * @returns {Promise<{ isEligible: boolean, isGeoblocked: boolean, country: string, status: string }>}
   */
  async checkGeoblockStatus(ipAddress = null) {
    try {
      const url = 'https://polymarket.com/api/geoblock';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TradingBrain-Research-P0/1.0' }
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        // HTTP Error -> Fail Closed
        logger.warn(`⚠️ [ComplianceGate] Geoblock API returned HTTP ${response.status}. Failing closed.`);
        return { isEligible: false, isGeoblocked: true, country: 'UNKNOWN', status: 'FAIL_CLOSED_HTTP_ERROR' };
      }

      const data = await response.json();
      if (!data || typeof data.blocked !== 'boolean') {
        // Malformed JSON payload -> Fail Closed
        logger.warn('⚠️ [ComplianceGate] Malformed geoblock response. Failing closed.');
        return { isEligible: false, isGeoblocked: true, country: 'UNKNOWN', status: 'FAIL_CLOSED_MALFORMED_RESPONSE' };
      }

      const isBlocked = data.blocked === true;
      return {
        isEligible: !isBlocked,
        isGeoblocked: isBlocked,
        country: data.country || 'UNKNOWN',
        status: isBlocked ? 'GEOBLOCKED' : 'ELIGIBLE'
      };
    } catch (err) {
      // Timeout or Network Failure -> Fail Closed
      logger.warn(`⚠️ [ComplianceGate] Geoblock check failed (${err.message}). Failing closed to preserve compliance.`);
      return {
        isEligible: false,
        isGeoblocked: true,
        country: 'UNKNOWN',
        status: 'FAIL_CLOSED_NETWORK_ERROR',
        error: err.message
      };
    }
  }

  getStatus() {
    return {
      governanceStatus: 'ENGINEERING_IMPLEMENTED_EMPIRICAL_VALIDATION_PENDING',
      researchMode: this.researchMode,
      walletSigningEnabled: this.walletSigningEnabled,
      realOrderPlacementEnabled: this.realOrderPlacementEnabled,
      zeroSigningInvariant: 'ENFORCED_FAIL_STARTUP'
    };
  }
}

const complianceGate = new PredictionComplianceGate();
module.exports = { PredictionComplianceGate, complianceGate };
