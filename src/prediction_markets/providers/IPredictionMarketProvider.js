/**
 * 🏛️ Prediction Market Provider Interface Contract
 * 
 * Strict architectural abstraction for all prediction market data providers.
 * Core Trading Brain logic imports only this interface/adapter layer, never raw SDK types.
 */

class IPredictionMarketProvider {
  /**
   * Fetch active markets matching query filters
   * @param {Object} filter - { category, limit, active, closed, tag }
   * @returns {Promise<Array<Object>>} Standardized market objects
   */
  async getMarkets(filter = {}) {
    throw new Error('Method getMarkets() must be implemented by provider.');
  }

  /**
   * Fetch a single contract / market definition by conditionId or slug
   * @param {string} identifier - Condition ID or Market Slug
   * @returns {Promise<Object>} Normalized contract definition
   */
  async getContract(identifier) {
    throw new Error('Method getContract() must be implemented by provider.');
  }

  /**
   * Fetch current Central Limit Order Book (CLOB) snapshot for a specific token
   * @param {string} tokenId - ERC-1155 Token ID (YES or NO token)
   * @returns {Promise<Object>} { bids: [{price, size}], asks: [{price, size}], timestamp, hash }
   */
  async getOrderBook(tokenId) {
    throw new Error('Method getOrderBook() must be implemented by provider.');
  }

  /**
   * Subscribe to real-time WebSocket order-book updates for a token
   * @param {string} tokenId - ERC-1155 Token ID
   * @param {Function} callback - (bookUpdate) => void
   * @returns {Function} Unsubscribe handle
   */
  subscribeBook(tokenId, callback) {
    throw new Error('Method subscribeBook() must be implemented by provider.');
  }

  /**
   * Fetch official fee schedule metadata for a specific market
   * @param {string} marketId - Condition ID or Market ID
   * @returns {Promise<Object>} { feesEnabled, rate, exponent, takerOnly, rebateRate, scheduleHash }
   */
  async getFeeSchedule(marketId) {
    throw new Error('Method getFeeSchedule() must be implemented by provider.');
  }

  /**
   * Fetch complete, unedited resolution rules and Oracle parameters
   * @param {string} conditionId - Condition ID
   * @returns {Promise<Object>} { resolutionSource, rulesText, endTimestamp, oracleMechanism, clarifications }
   */
  async getResolutionRules(conditionId) {
    throw new Error('Method getResolutionRules() must be implemented by provider.');
  }
}

module.exports = IPredictionMarketProvider;
