/**
 * 📡 Vault Research Event Bus (Final Frozen Specification)
 * 
 * Invariant: Zero network egress / live execution tunnel.
 * Webhook and remote URLs do NOT exist in code.
 * Routes strictly via:
 * 1. In-process internal EventEmitter
 * 2. SQLite Research Ledger
 * 3. Dashboard Read Model
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createAgentLogger } = require('../../core/logger');

const logger = createAgentLogger('VaultResearchEventBus');

class VaultResearchEventBus extends EventEmitter {
  constructor() {
    super();
    this.networkEgressPolicy = 'INTERNAL_RESEARCH_ONLY';
    this.eventBuffer = [];
    this.maxEvents = 100;
  }

  /**
   * Publish an immutable paper research event
   */
  publishResearchEvent(event) {
    const packet = {
      eventId: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      mode: 'PAPER_RESEARCH',
      executionAuthorized: false,
      liveCopierLocked: true,
      networkEgressPolicy: this.networkEgressPolicy,
      signalType: 'ALLOCATION_SIMULATION',
      marketId: event.marketId,
      question: event.question,
      outcome: event.outcome || 'YES',
      targetPrice: event.targetPrice,
      paperAllocationUSD: event.allocatedUSD,
      modelVersion: event.modelVersion || 'champion_v1.0',
      contractSemanticHash: event.contractSemanticHash || 'sem_hash_v1',
      feeScheduleHash: event.feeScheduleHash || 'fee_hash_v1',
      validUntil: new Date(Date.now() + 180000).toISOString(),
      researchProvenance: 'ZERO_SIGNING_SIMULATION',
      reasonCodes: event.reasonCodes || ['PAPER_ALLOCATION_RECORDED']
    };

    packet.verificationSignature = crypto.createHash('sha256')
      .update(JSON.stringify({ id: packet.eventId, m: packet.marketId, p: packet.paperAllocationUSD, t: packet.timestamp }))
      .digest('hex')
      .slice(0, 16);

    this.eventBuffer.unshift(packet);
    if (this.eventBuffer.length > this.maxEvents) {
      this.eventBuffer.pop();
    }

    // Emit in-process only
    this.emit('research_event', packet);

    logger.info(`📡 [ResearchEventBus] Emitted internal research event ${packet.eventId} for "${packet.question}" (Allocated: $${packet.paperAllocationUSD})`);
    return packet;
  }

  getResearchEvents() {
    return this.eventBuffer;
  }
}

const vaultResearchEventBus = new VaultResearchEventBus();
module.exports = { VaultResearchEventBus, vaultResearchEventBus };
