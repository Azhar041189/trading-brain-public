const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createAgentLogger } = require('../core/logger');
const logger = createAgentLogger('SecureKeyVault');

/**
 * SecureKeyVault - Implements AES-256-GCM hardware/file encryption
 * for broker API keys, client secrets, and TOTP seeds.
 */
class SecureKeyVault {
  constructor() {
    this.vaultPath = path.join(__dirname, '../../data/vault.enc');
    this.masterKey = crypto.scryptSync(process.env.VAULT_SECRET || 'trading-brain-master-key-2026', 'salt-2026', 32);
  }

  /**
   * Save an encrypted secret
   */
  setSecret(key, value) {
    const secrets = this.getAllSecrets();
    secrets[key] = value;
    this._saveVault(secrets);
    logger.info(`🔒 [Key Vault] Securely stored encrypted secret: ${key}`);
  }

  /**
   * Get a decrypted secret
   */
  getSecret(key) {
    const secrets = this.getAllSecrets();
    return secrets[key] || process.env[key] || null;
  }

  /**
   * Get all decrypted secrets
   */
  getAllSecrets() {
    if (!fs.existsSync(this.vaultPath)) return {};
    try {
      const raw = fs.readFileSync(this.vaultPath, 'utf8');
      const data = JSON.parse(raw);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(data.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(data.authTag, 'hex'));
      let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return JSON.parse(decrypted);
    } catch (e) {
      return {};
    }
  }

  _saveVault(secretsObj) {
    const dir = path.dirname(this.vaultPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    let encrypted = cipher.update(JSON.stringify(secretsObj), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    fs.writeFileSync(this.vaultPath, JSON.stringify({
      iv: iv.toString('hex'),
      authTag,
      encrypted
    }, null, 2));
  }
}

module.exports = new SecureKeyVault();
