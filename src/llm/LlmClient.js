/**
 * Thin wrapper around an OpenAI-compatible chat endpoint (the course
 * LiteLLM gateway from lab8, or any provider).
 *
 * Design constraints:
 *  - the LLM never calls game APIs; it only produces text/JSON that the
 *    runtime validates before anything affects behavior;
 *  - the `openai` package is imported lazily so that agents run fine
 *    without it installed as long as no LLM call is made;
 *  - isConfigured() lets callers (MissionInterpreter) fall back to
 *    deterministic parsing when no provider is set up.
 */
export class LlmClient {
  #client = null;

  /**
   * @param {object} opts
   * @param {string|null} opts.baseUrl
   * @param {string|null} opts.apiKey
   * @param {string|null} opts.model
   * @param {import('../metrics/MetricsCollector.js').MetricsCollector} [opts.metrics]
   * @param {import('../metrics/RunLogger.js').RunLogger} [opts.logger]
   */
  constructor({ baseUrl = null, apiKey = null, model = null, metrics = null, logger = null }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.metrics = metrics;
    this.logger = logger;
  }

  isConfigured() {
    return !!(this.baseUrl && this.apiKey && this.model);
  }

  /**
   * One chat completion. Throws when unconfigured or on provider errors —
   * callers are expected to catch and fall back.
   * @param {{role: string, content: string}[]} messages
   * @returns {Promise<string>} assistant message content
   */
  async chat(messages, { temperature = 0 } = {}) {
    if (!this.isConfigured()) throw new Error('LLM provider not configured');

    if (!this.#client) {
      const { default: OpenAI } = await import('openai');
      this.#client = new OpenAI({ baseURL: this.baseUrl, apiKey: this.apiKey });
    }

    const startedAt = Date.now();
    const response = await this.#client.chat.completions.create({
      model: this.model,
      messages,
      temperature,
    });
    const content = response.choices?.[0]?.message?.content ?? '';
    this.logger?.log('llm_call', {
      model: this.model,
      durationMs: Date.now() - startedAt,
      outputChars: content.length,
    });
    return content;
  }
}
