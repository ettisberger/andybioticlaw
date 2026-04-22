import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Handler, HandlerContext, HandlerResult } from './types.js';
import type { BashPayload } from '../payloads.js';
import { parseTrigger } from '../payloads.js';

const pexec = promisify(execFile);

/**
 * `bash` kind: runs the configured shell command and captures stdout/stderr.
 *
 * If stdout is a JSON `TriggerEnvelope` — `{"trigger": true, "prompt": "..."}`
 * — the handler fires a chained agent session with that prompt. Otherwise
 * the handler completes without touching the agent and does not consume
 * tokens.
 *
 * Running shell commands on the host is a sharp knife. The service runs as
 * a dedicated user (`andybioticlaw` in prod), but commands still inherit
 * that user's filesystem access. Prefer narrow commands; don't pipe
 * unvalidated data in.
 */
export const bashHandler: Handler<BashPayload> = {
  kind: 'bash',
  async run(payload: BashPayload, ctx: HandlerContext): Promise<HandlerResult> {
    const timeoutMs = payload.timeoutSec * 1000;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let ran = true;

    try {
      const result = await pexec('/bin/sh', ['-c', payload.command], {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? err.message;
      exitCode = typeof err.code === 'number' ? err.code : 1;
      ran = false;
    }

    const head = (s: string) => s.trim().slice(0, 2000);

    if (!ran) {
      return {
        status: 'fail',
        output: head(stderr || stdout),
        error: `command exited with code ${exitCode}`,
      };
    }

    const trigger = parseTrigger(stdout);
    if (!trigger) {
      return { status: 'success', output: head(stdout) };
    }

    // Trigger envelope: chain into an agent session. Tokens billed against
    // this schedule's budget.
    const chatIdStr =
      trigger.chatId ??
      (ctx.defaultChatId !== null ? String(ctx.defaultChatId) : null);
    if (chatIdStr === null) {
      return {
        status: 'fail',
        output: head(stdout),
        error: 'trigger envelope present but no chatId configured',
      };
    }
    try {
      const agentResult = await ctx.submitAgentTask({
        chatId: chatIdStr,
        prompt: trigger.prompt,
        scheduleName: ctx.schedule.name,
      });
      const tokens = agentResult.tokensInput + agentResult.tokensOutput;
      if (agentResult.status === 'completed') {
        return {
          status: 'success',
          tokensUsed: tokens,
          output: `bash OK → agent OK (${tokens} tokens). stdout head: ${head(stdout).slice(0, 200)}`,
        };
      }
      return {
        status: 'fail',
        tokensUsed: tokens,
        error: `bash OK but chained agent session failed: ${agentResult.error ?? agentResult.status}`,
      };
    } catch (e) {
      return {
        status: 'fail',
        output: head(stdout),
        error: `chained agent submit failed: ${(e as Error).message}`,
      };
    }
  },
};
