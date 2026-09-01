const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('DhanAutoAuth');

/**
 * DhanAutoAuth - Automated TOTP Token Refresher for DhanHQ
 * Implements native RFC 6238 standard TOTP generation (SHA-1 / 30s timestep / 6 digits).
 * Runs daily at 08:45 AM IST to generate fresh 24h SEBI-compliant access tokens.
 */
class DhanAutoAuth {
  constructor() {
    this.clientId = process.env.DHAN_CLIENT_ID;
    this.pin = process.env.DHAN_PIN;
    this.totpSecret = process.env.DHAN_TOTP_SECRET;
    this.envPath = path.join(__dirname, '../../.env');
  }

  /**
   * Decode Base32 TOTP Secret
   */
  base32Decode(base32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    const clean = base32.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
    for (let i = 0; i < clean.length; i++) {
      const val = alphabet.indexOf(clean[i]);
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.substr(i, 8), 2));
    }
    return Buffer.from(bytes);
  }

  /**
   * Generate live 6-digit TOTP code (RFC 6238)
   */
  generateTOTP() {
    const secret = process.env.DHAN_TOTP_SECRET || this.totpSecret;
    if (!secret) {
      throw new Error('DHAN_TOTP_SECRET is not configured in .env');
    }

    // If a 6-digit numeric OTP was provided directly, use it
    if (/^\d{6}$/.test(secret.trim())) {
      return secret.trim();
    }

    const key = this.base32Decode(secret);
    const epoch = Math.floor(Date.now() / 1000);
    const timeStep = Math.floor(epoch / 30);
    
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(timeStep), 0);

    const hmac = crypto.createHmac('sha1', key).update(timeBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binaryCode = (
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    );

    return (binaryCode % 1000000).toString().padStart(6, '0');
  }

  /**
   * Automatically authenticate with DhanHQ and update local .env
   */
  async refreshAccessToken() {
    const clientId = process.env.DHAN_CLIENT_ID || this.clientId;
    const pin = process.env.DHAN_PIN || this.pin;
    const totpSecret = process.env.DHAN_TOTP_SECRET || this.totpSecret;

    if (!clientId || !totpSecret || !pin) {
      logger.warn('⚠️ [Dhan Auto-Auth] Missing DHAN_CLIENT_ID, DHAN_PIN, or DHAN_TOTP_SECRET in .env. Skipping automated login.');
      return { success: false, reason: 'MISSING_CREDENTIALS' };
    }

    try {
      const totpCode = this.generateTOTP();
      logger.info(`🔄 [Dhan Auto-Auth] Generated TOTP code: ${totpCode}. Requesting fresh 24-hour token...`);

      // DhanHQ Token Generation API
      const res = await axios.post('https://api.dhan.co/v2/token/generate', {
        dhanClientId: clientId,
        pin: pin,
        totp: totpCode
      }, { timeout: 8000 });

      if (res.data && res.data.accessToken) {
        const freshToken = res.data.accessToken;
        this.updateEnvFile(freshToken);
        process.env.DHAN_ACCESS_TOKEN = freshToken;
        logger.info('✅ [Dhan Auto-Auth] Fresh 24-hour Access Token generated & updated in .env successfully!');
        return { success: true, token: freshToken };
      } else {
        throw new Error(res.data?.message || 'Token not returned in response');
      }
    } catch (e) {
      logger.error(`❌ [Dhan Auto-Auth] Automated refresh note: ${e.response?.data?.message || e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Safely write fresh token into .env file
   */
  updateEnvFile(newToken) {
    if (!fs.existsSync(this.envPath)) return;
    try {
      let content = fs.readFileSync(this.envPath, 'utf8');
      if (content.includes('DHAN_ACCESS_TOKEN=')) {
        content = content.replace(/DHAN_ACCESS_TOKEN=.*/, `DHAN_ACCESS_TOKEN=${newToken}`);
      } else {
        content += `\nDHAN_ACCESS_TOKEN=${newToken}\n`;
      }
      fs.writeFileSync(this.envPath, content, 'utf8');
    } catch (e) {
      logger.error('Failed to write new token to .env file', { error: e.message });
    }
  }

  /**
   * Schedule automatic daily refresh at 08:45 AM IST
   */
  scheduleDaily() {
    const cron = require('cron');
    // 08:45 AM IST Monday through Friday
    const job = new cron.CronJob('0 45 8 * * 1-5', async () => {
      logger.info('⏰ [Cron Trigger: 08:45 AM IST] Running pre-market DhanHQ token auto-refresh...');
      await this.refreshAccessToken();
    }, null, true, 'Asia/Kolkata');
    job.start();
    logger.info('⏰ [Dhan Auto-Auth] Scheduled automatic daily refresh for 08:45 AM IST (Mon-Fri)');
  }
}

module.exports = new DhanAutoAuth();
