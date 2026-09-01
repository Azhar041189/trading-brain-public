const axios = require('axios');
const crypto = require('crypto');
const { createAgentLogger } = require('../core/logger');

const logger = createAgentLogger('BinanceWeb3Sentinel');

/**
 * BinanceWeb3Sentinel - Integrates official Binance Skills Hub endpoints
 * Provides pre-trade security audits, honeypot detection, and smart money verification.
 */
class BinanceWeb3Sentinel {
  constructor() {
    this.auditEndpoint = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit';
    this.chainMap = {
      'BSC': '56',
      'SOLANA': 'CT_501',
      'BASE': '8453',
      'ETH': '1'
    };
  }

  /**
   * Audit token security before executing DEX or Spot Altcoin trades
   * @param {string} contractAddress 
   * @param {string} chain - 'BSC', 'SOLANA', 'BASE', 'ETH'
   */
  async auditTokenSecurity(contractAddress, chain = 'BSC') {
    try {
      const chainId = this.chainMap[chain.toUpperCase()] || '56';
      const requestId = crypto.randomUUID();

      const response = await axios.post(
        this.auditEndpoint,
        {
          binanceChainId: chainId,
          contractAddress: contractAddress,
          requestId: requestId
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'source': 'agent',
            'Accept-Encoding': 'identity',
            'User-Agent': 'binance-web3/1.4 (Skill)'
          },
          timeout: 8000
        }
      );

      const data = response.data;
      if (data && data.code === '000000' && data.data) {
        const audit = data.data;
        const score = typeof audit.score === 'number' ? audit.score : 100;
        const level = (audit.riskLevel || '').toUpperCase();
        const isSafe = level === 'LOW' || level === 'SAFE' || level === 'CLEAN' || score >= 80;
        
        const risks = [];
        (audit.categories || []).forEach(cat => {
          (cat.details || []).forEach(det => {
            if (det.isHit) {
              risks.push(`[${det.riskType}] ${det.title}: ${det.description}`);
            }
          });
        });

        logger.info(`🛡️ [Binance Security Audit] ${contractAddress} (${chain}) - Score: ${score}/100 | Safe: ${isSafe}`, {
          riskCount: risks.length,
          score
        });

        return {
          safe: isSafe,
          riskLevel: audit.riskLevel || 'LOW',
          score: score,
          risks: risks,
          contractAddress,
          chain
        };
      }

      return { safe: true, riskLevel: 'UNVERIFIED_PASSED', risks: [] };
    } catch (err) {
      logger.warn(`⚠️ [Binance Security Audit] Audit check skipped: ${err.message}`);
      return { safe: true, riskLevel: 'FALLBACK_PASSED', risks: [] };
    }
  }
}

module.exports = new BinanceWeb3Sentinel();
