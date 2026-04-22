import type { Handler, HandlerContext, HandlerResult } from './types.js';
import type { HttpCheckPayload } from '../payloads.js';
import { parseTrigger } from '../payloads.js';

/**
 * `http-check` kind: issues an HTTP request, optionally validates status,
 * and optionally chains into an agent session if the response body is a
 * TriggerEnvelope JSON.
 */
export const httpCheckHandler: Handler<HttpCheckPayload> = {
  kind: 'http-check',
  async run(payload: HttpCheckPayload, ctx: HandlerContext): Promise<HandlerResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), payload.timeoutSec * 1000);

    let status = 0;
    let bodyText = '';
    let errored: string | null = null;
    try {
      const init: RequestInit = {
        method: payload.method,
        headers: payload.headers,
        signal: controller.signal,
      };
      if (payload.body !== undefined && payload.method !== 'GET' && payload.method !== 'HEAD') {
        init.body = payload.body;
      }
      const resp = await fetch(payload.url, init);
      status = resp.status;
      bodyText = await resp.text();
    } catch (e) {
      errored = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }

    const head = (s: string) => s.slice(0, 2000);

    if (errored) {
      return {
        status: 'fail',
        error: `fetch failed: ${errored}`,
        output: head(bodyText),
      };
    }

    if (payload.expectedStatus !== undefined && status !== payload.expectedStatus) {
      return {
        status: 'fail',
        error: `status ${status} != expected ${payload.expectedStatus}`,
        output: head(bodyText),
      };
    }

    const trigger = parseTrigger(bodyText);
    if (!trigger) {
      return { status: 'success', output: `HTTP ${status}. body head: ${head(bodyText).slice(0, 200)}` };
    }

    const chatIdStr =
      trigger.chatId ??
      (ctx.defaultChatId !== null ? String(ctx.defaultChatId) : null);
    if (chatIdStr === null) {
      return {
        status: 'fail',
        output: head(bodyText),
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
          output: `HTTP ${status} → agent OK (${tokens} tokens)`,
        };
      }
      return {
        status: 'fail',
        tokensUsed: tokens,
        error: `http-check OK but chained agent failed: ${agentResult.error ?? agentResult.status}`,
      };
    } catch (e) {
      return {
        status: 'fail',
        error: `chained agent submit failed: ${(e as Error).message}`,
      };
    }
  },
};
