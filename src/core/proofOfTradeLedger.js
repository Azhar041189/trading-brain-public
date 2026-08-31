const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('ProofOfTrade');

/**
 * ProofOfTradeLedger - Creates an immutable, cryptographically verifiable
 * SHA-256 hash chain of every executed trade and milestone sweep for public auditing.
 */
class ProofOfTradeLedger {
  constructor() {
    this.ledgerPath = path.join(__dirname, '../../data/proof_of_trade_ledger.json');
    this.blocks = this._loadLedger();
  }

  _loadLedger() {
    if (fs.existsSync(this.ledgerPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8'));
      } catch (e) { return []; }
    }
    // Genesis Block
    return [{
      index: 0,
      timestamp: new Date().toISOString(),
      eventType: 'GENESIS_BLOCK',
      data: { message: 'Trading Brain Genesis Proof of Trade' },
      previousHash: '00000000000000000000000000000000',
      hash: 'genesis_hash_proof_2026'
    }];
  }

  /**
   * Commit a new verified event/trade to the hash ledger
   */
  recordBlock(eventType, data) {
    const prevBlock = this.blocks[this.blocks.length - 1];
    const index = this.blocks.length;
    const timestamp = new Date().toISOString();

    const payload = JSON.stringify({ index, timestamp, eventType, data, prevHash: prevBlock.hash });
    const hash = crypto.createHash('sha256').update(payload).digest('hex');

    const newBlock = {
      index,
      timestamp,
      eventType,
      data,
      previousHash: prevBlock.hash,
      hash
    };

    this.blocks.push(newBlock);
    this._saveLedger();

    logger.info(`🔗 [Proof-of-Trade Block #${index}] ${eventType} | Hash: ${hash.slice(0, 16)}...`);
    return newBlock;
  }

  getRecentBlocks(limit = 10) {
    return this.blocks.slice(-limit).reverse();
  }

  _saveLedger() {
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.ledgerPath, JSON.stringify(this.blocks, null, 2));
  }
}

module.exports = new ProofOfTradeLedger();
