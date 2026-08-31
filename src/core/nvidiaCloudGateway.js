const axios = require('axios');
const { createAgentLogger } = require('./logger');
const logger = createAgentLogger('NvidiaLLM');

class NvidiaCloudGateway {
  constructor() {
    this.endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
    this.model = 'meta/llama-3.1-8b-instruct'; // Fast, high-availability NVIDIA NIM model
    this.timeoutMs = 8000; // Circuit breaker to prevent stalling
    this.apiKey = process.env.NVIDIA_API_KEY || null;
  }

  /**
   * Evaluate a news headline or SEC filing sentence and return a mathematical MacroScore
   */
  async evaluateSentiment(text, isPaperTrading = false) {
    if (!this.apiKey) {
      return { score: 0, rationale: 'NVIDIA API Key not configured.', success: false };
    }

    if (!isPaperTrading) {
      logger.warn(`🛑 [NvidiaLLM] Blocked: AI sentiment engine is only allowed in PAPER_TRADING mode.`);
      return { score: 0, rationale: 'Blocked in Production mode.', success: false };
    }

    try {
      const prompt = `You are a quantitative financial analyst evaluating news for algorithmic trading. 
Analyze this headline and output ONLY a valid JSON object containing a MacroScore (float between -1.0 and 1.0) and a brief 1-sentence Rationale. Do not include any other text or markdown formatting.
Headline: "${text}"`;

      const response = await axios.post(
        this.endpoint,
        {
          model: this.model,
          messages: [
            { role: "system", content: "You output only raw valid JSON." },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 150
        },
        { 
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: this.timeoutMs 
        }
      );

      const content = response.data.choices[0].message.content;
      // Strip markdown code blocks if the LLM accidentally includes them
      const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanContent);

      // Validate bounds
      let score = parseFloat(parsed.MacroScore);
      if (isNaN(score)) score = 0;
      score = Math.max(-1.0, Math.min(1.0, score));

      logger.info(`🧠 [NvidiaLLM] Sentiment: ${score} | ${parsed.Rationale}`);

      return {
        score: score,
        rationale: parsed.Rationale || 'No rationale provided.',
        success: true
      };

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        logger.warn(`⚠️ [NvidiaLLM] Timeout exceeded (${this.timeoutMs}ms). Circuit breaker triggered.`);
      } else {
        logger.warn(`⚠️ [NvidiaLLM] Error: ${error.message}`);
      }
      
      // Fallback
      return { score: 0, rationale: 'LLM Offline or Timeout', success: false };
    }
  }
}

module.exports = new NvidiaCloudGateway();
