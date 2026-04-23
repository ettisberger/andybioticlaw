import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import { API_BILLING_ENV_VARS } from './credentials.js';

export interface RunClaudeInput {
  userMessage: string;
  systemPrompt: string;
  model: string;
  cwd: string;
  /** "all" = pass default tool set; otherwise forwarded as --allowedTools <value>. */
  allowedTools: string;
  /** Kill the CLI if no stream event arrives for this many ms. */
  streamIdleTimeoutMs: number;
  /** Optional: abort signal for user-initiated cancellation. */
  signal?: AbortSignal;
  /** Bin path for the claude CLI. Defaults to `claude`. */
  claudeBin?: string;
  /** Called for each user-visible text delta (not thinking, not tool use). */
  onDelta: (text: string) => void;
  /** Called once when the CLI emits its init event. */
  onInit?: (info: { cliSessionId: string; apiKeySource: string }) => void;
  /** Called for each rate_limit_event. */
  onRateLimit?: (payload: unknown) => void;
  /** Called for tool-use blocks (Phase 2: logged only). */
  onToolUse?: (name: string) => void;
  /** Extra logger. */
  logger?: Logger;
  /**
   * Called if we detect the CLI is running under API-key billing (anything
   * other than subscription auth). Return `true` to let the run proceed
   * anyway; default is `false` — the runner will SIGKILL immediately.
   */
  onApiKeyBilling?: (apiKeySource: string) => boolean;
  /** Absolute path to an MCP config JSON file (forwarded as --mcp-config). Optional. */
  mcpConfigPath?: string;
  /** Additional env vars to merge into the subprocess env AFTER filtering API-billing vars. */
  extraEnv?: Record<string, string>;
}

/**
 * Build the env we pass to the claude subprocess. We strip every variable that
 * could switch it from subscription auth to API-key billing or to a different
 * provider (Bedrock/Vertex). See README § Design Decisions.
 */
export function buildClaudeEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const blocked = new Set<string>(API_BILLING_ENV_VARS as readonly string[]);
  for (const [k, v] of Object.entries(base)) {
    if (blocked.has(k)) continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export type RunStatus = 'completed' | 'failed' | 'cancelled' | 'crashed';

export interface RunClaudeResult {
  status: RunStatus;
  text: string;
  /** Sum of `input_tokens + cache_creation + cache_read` for billing purposes. */
  tokensInput: number;
  tokensOutput: number;
  /** Breakdown of `tokensInput` for observability (cache optimization monitoring). */
  tokensInputFresh?: number;
  tokensCacheCreation?: number;
  tokensCacheRead?: number;
  error?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  cliSessionId?: string;
  /** True iff `terminal_reason` from the result event indicates an API error. */
  transientApiError?: boolean;
  /** The `apiKeySource` value from the CLI's init event (`"none"` for subscription). */
  apiKeySource?: string;
  /** True iff the runner killed the subprocess because it was running under API-key billing. */
  killedByApiKeyGuard?: boolean;
}

/**
 * Spawn `claude` as a subprocess, stream the JSON-lines output, and return a
 * unified result. Streaming text deltas are forwarded to `onDelta`.
 *
 * Why it's shaped this way:
 *   - We parse newline-delimited JSON from stdout, buffering partial lines.
 *     better-sqlite3-style "just call readline" would work too but this keeps
 *     backpressure under our control.
 *   - `text_delta` events are emitted live. `thinking_delta` and
 *     `signature_delta` are skipped — they're the CLI's extended-thinking
 *     feed, which we don't surface to the user.
 *   - `result` event carries the authoritative usage numbers. We don't derive
 *     them from the incremental deltas.
 *   - `streamIdleTimeoutMs` guards against the CLI hanging with no output
 *     (Claude's servers under outage, network stall). First SIGTERM, then
 *     SIGKILL after 5s.
 *   - `signal` supports user-triggered /cancel. Abort → SIGTERM → SIGKILL.
 */
export function runClaude(input: RunClaudeInput): Promise<RunClaudeResult> {
  const bin = input.claudeBin ?? 'claude';
  const args = [
    '-p',
    input.userMessage,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--input-format',
    'text',
    '--model',
    input.model,
    '--no-session-persistence',
    '--system-prompt',
    input.systemPrompt,
    '--permission-mode',
    'bypassPermissions',
  ];
  if (input.allowedTools && input.allowedTools !== 'all') {
    args.push('--allowedTools', input.allowedTools);
  }
  if (input.mcpConfigPath) {
    args.push('--mcp-config', input.mcpConfigPath);
  }

  const baseEnv = buildClaudeEnv();
  const mergedEnv: NodeJS.ProcessEnv = input.extraEnv
    ? { ...baseEnv, ...input.extraEnv }
    : baseEnv;

  const child = spawn(bin, args, {
    cwd: input.cwd,
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;

  const log = input.logger;

  let aggregatedText = '';
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensInputFresh = 0;
  let tokensCacheCreation = 0;
  let tokensCacheRead = 0;
  let cliSessionId: string | undefined;
  let resultSeen = false;
  let transientApiError = false;
  let resultError: string | undefined;
  let lastStreamEventAt = Date.now();
  let stderr = '';
  let killedByHang = false;
  let killedByAbort = false;
  let killedByApiKeyGuard = false;
  let observedApiKeySource: string | undefined;

  // Idle watchdog.
  const idleInterval = setInterval(() => {
    if (Date.now() - lastStreamEventAt > input.streamIdleTimeoutMs) {
      killedByHang = true;
      log?.warn(
        { pid: child.pid, idleMs: Date.now() - lastStreamEventAt },
        'claude process idle — sending SIGTERM',
      );
      terminateChild(child, log);
    }
  }, 1000);

  // Abort wiring.
  const onAbort = () => {
    killedByAbort = true;
    log?.info({ pid: child.pid }, 'abort signal received — terminating claude subprocess');
    terminateChild(child, log);
  };
  input.signal?.addEventListener('abort', onAbort);

  // Stdout line parser.
  let stdoutBuf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    lastStreamEventAt = Date.now();
    stdoutBuf += chunk.toString('utf8');
    let nl = stdoutBuf.indexOf('\n');
    while (nl >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) handleLine(line);
      nl = stdoutBuf.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    stderr += s;
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
    log?.debug({ stderr: s.trim() }, 'claude stderr');
  });

  function handleLine(line: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log?.debug({ line }, 'stream-json: unparseable line');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const obj = msg as Record<string, unknown>;

    switch (obj.type) {
      case 'system': {
        if (obj.subtype === 'init' && typeof obj.session_id === 'string') {
          cliSessionId = obj.session_id;
          const src = typeof obj.apiKeySource === 'string' ? obj.apiKeySource : 'none';
          observedApiKeySource = src;
          input.onInit?.({ cliSessionId, apiKeySource: src });

          // HARD GUARD: subscription-only. If the CLI is running under an
          // API key (anything other than "none"), kill immediately and fail
          // the session. Allow an explicit override hook so tests can
          // exercise the path without actually billing.
          if (src !== 'none') {
            const allow = input.onApiKeyBilling?.(src) === true;
            if (!allow) {
              killedByApiKeyGuard = true;
              log?.error(
                { apiKeySource: src, pid: child.pid },
                'claude CLI reports API-key billing — aborting to stay on subscription auth',
              );
              try {
                child.kill('SIGKILL');
              } catch {
                /* already gone */
              }
            }
          }
        }
        return;
      }
      case 'stream_event': {
        const ev = obj.event as { type?: string; delta?: Record<string, unknown> } | undefined;
        if (ev?.type === 'content_block_delta') {
          const delta = ev.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            aggregatedText += delta.text;
            try {
              input.onDelta(delta.text);
            } catch (e) {
              log?.warn({ err: (e as Error).message }, 'onDelta handler threw');
            }
          }
          // thinking_delta and signature_delta are intentionally dropped.
        }
        return;
      }
      case 'assistant': {
        // Full message snapshot (between blocks). Ignore — aggregated text is already captured.
        return;
      }
      case 'rate_limit_event': {
        input.onRateLimit?.(obj.rate_limit_info ?? obj);
        return;
      }
      case 'tool_use': {
        const name = typeof obj.name === 'string' ? obj.name : 'unknown';
        input.onToolUse?.(name);
        return;
      }
      case 'result': {
        resultSeen = true;
        const usage = obj.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            }
          | undefined;
        if (usage) {
          tokensInputFresh = usage.input_tokens ?? 0;
          tokensCacheCreation = usage.cache_creation_input_tokens ?? 0;
          tokensCacheRead = usage.cache_read_input_tokens ?? 0;
          tokensInput = tokensInputFresh + tokensCacheCreation + tokensCacheRead;
          tokensOutput = usage.output_tokens ?? 0;
        }
        if (obj.is_error === true || obj.subtype === 'error_during_execution') {
          if (typeof obj.api_error_status === 'number') {
            transientApiError = [503, 529].includes(obj.api_error_status);
          }
          // Log the FULL result-event payload so we can see what claude
          // actually said. The previous fallback "result event marked as
          // error" hid the cause; now we capture it.
          log?.warn(
            {
              subtype: obj.subtype,
              api_error_status: obj.api_error_status,
              num_turns: obj.num_turns,
              duration_ms: obj.duration_ms,
              permission_denials: obj.permission_denials,
              result_field: obj.result,
              error_field: obj.error,
              recent_stderr: stderr ? stderr.trim().slice(-1500) : '',
            },
            'claude result event has is_error=true',
          );
          // Compose the most informative message we can from whatever
          // fields are present, plus stderr tail.
          const parts: string[] = [];
          if (typeof obj.subtype === 'string' && obj.subtype !== 'success') {
            parts.push(`subtype=${obj.subtype}`);
          }
          if (typeof obj.result === 'string' && obj.result.trim()) {
            parts.push(obj.result.trim().slice(0, 300));
          } else if (typeof obj.error === 'string' && obj.error.trim()) {
            parts.push(obj.error.trim().slice(0, 300));
          }
          if (typeof obj.api_error_status === 'number') {
            parts.push(`api_status=${obj.api_error_status}`);
          }
          if (stderr.trim()) {
            parts.push(`stderr=${stderr.trim().slice(-300)}`);
          }
          resultError =
            parts.length > 0
              ? parts.join(' | ')
              : 'result event marked as error (no detail in payload)';
        }
        return;
      }
      default:
        return;
    }
  }

  return new Promise<RunClaudeResult>((resolve) => {
    child.on('error', (err) => {
      log?.error({ err: err.message }, 'failed to spawn claude');
      clearInterval(idleInterval);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({
        status: 'failed',
        text: aggregatedText,
        tokensInput,
        tokensOutput,
        error: `spawn error: ${err.message}`,
      });
    });

    child.on('close', (code, signal) => {
      clearInterval(idleInterval);
      input.signal?.removeEventListener('abort', onAbort);

      // Drain any leftover stdout buffer — a final line without trailing newline.
      if (stdoutBuf.trim()) {
        handleLine(stdoutBuf.trim());
        stdoutBuf = '';
      }

      let status: RunStatus;
      let error: string | undefined;
      if (killedByApiKeyGuard) {
        status = 'failed';
        error = `aborted: claude CLI running under API-key billing (apiKeySource=${observedApiKeySource}). Expected subscription auth. Check for ANTHROPIC_API_KEY in the service env.`;
      } else if (killedByAbort) {
        status = 'cancelled';
        error = 'cancelled by user';
      } else if (killedByHang) {
        status = 'crashed';
        error = 'stream idle timeout';
      } else if (resultError) {
        status = 'failed';
        error = resultError;
      } else if (code === 0 && resultSeen) {
        status = 'completed';
      } else if (code === 0) {
        // process ended cleanly but we never saw a `result` event — odd, treat as failed
        status = 'failed';
        error = 'no result event received';
      } else {
        status = 'failed';
        error = `exited with code ${code}${signal ? ` (${signal})` : ''}${stderr ? `: ${stderr.trim().slice(0, 400)}` : ''}`;
      }

      resolve({
        status,
        text: aggregatedText,
        tokensInput,
        tokensOutput,
        tokensInputFresh,
        tokensCacheCreation,
        tokensCacheRead,
        ...(error ? { error } : {}),
        exitCode: code,
        signal,
        ...(cliSessionId ? { cliSessionId } : {}),
        ...(transientApiError ? { transientApiError: true } : {}),
        ...(observedApiKeySource ? { apiKeySource: observedApiKeySource } : {}),
        ...(killedByApiKeyGuard ? { killedByApiKeyGuard: true } : {}),
      });
    });
  });
}

function terminateChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  log: Logger | undefined,
): void {
  if (child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch (e) {
    log?.warn({ err: (e as Error).message }, 'SIGTERM failed');
  }
  setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }, 5_000).unref();
}
