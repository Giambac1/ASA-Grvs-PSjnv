import fs from 'node:fs';
import path from 'node:path';
import { safeStringify } from '../utils/serialization.js';

/**
 * JSON-lines logger: one file per agent per run under experiments/logs/.
 * Every line is {t, event, ...payload}. The same logger also writes the
 * final result summary (from MetricsCollector) under experiments/results/.
 *
 * Log files are append-only and cheap; the analysis lives in
 * notebooks/ or simple scripts, never in the runtime.
 */
export class RunLogger {
  /**
   * @param {object} opts
   * @param {string} [opts.dir] log directory
   * @param {string} [opts.label] scenario/run label
   * @param {string} [opts.role] 'bdi' | 'llm' | custom
   */
  constructor({ dir = 'experiments/logs', label = 'run', role = 'agent' } = {}) {
    this.label = label;
    this.role = role;
    this.closed = false;
    this.stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `${label}-${role}-${this.stamp}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    // A write that races past close() emits an asynchronous 'error'
    // (ERR_STREAM_WRITE_AFTER_END) that a try/catch around write() cannot
    // catch; without a listener Node would crash. Swallow it: logging must
    // never break the agent, least of all during shutdown.
    this.stream.on('error', () => {});
  }

  /** Append one event line. Never throws; a no-op once closed. */
  log(event, payload = {}) {
    if (this.closed) return;
    try {
      this.stream.write(`${safeStringify({ t: Date.now(), event, ...payload })}\n`);
    } catch {
      // Logging must never break the agent.
    }
  }

  /** Write the final run summary as a standalone JSON result file. */
  writeResult(summary, resultsDir = 'experiments/results') {
    fs.mkdirSync(resultsDir, { recursive: true });
    const file = path.join(resultsDir, `${this.label}-${this.role}-${this.stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(summary, null, 2));
    return file;
  }

  /** Idempotent: stops further logging and ends the stream once. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stream.end();
  }
}
