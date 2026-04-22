import type { Handler, HandlerContext, HandlerResult } from './types.js';
import type { AgentTaskPayload } from '../payloads.js';

/**
 * `agent-task` kind: fires a Claude session with the configured prompt.
 * Costs tokens. Honors per-schedule `budget_tokens_per_day` + the global
 * daily budget (both enforced in the engine before this handler runs).
 *
 * The session is submitted to the per-chat queue just like a DM, so it
 * serializes behind any ongoing user conversation in the same chat.
 */
export const agentTaskHandler: Handler<AgentTaskPayload> = {
  kind: 'agent-task',
  async run(payload: AgentTaskPayload, ctx: HandlerContext): Promise<HandlerResult> {
    const chatIdStr =
      payload.chatId ?? (ctx.defaultChatId !== null ? String(ctx.defaultChatId) : null);
    if (chatIdStr === null) {
      return {
        status: 'fail',
        error: 'no chatId in payload and no principal configured',
      };
    }

    try {
      const result = await ctx.submitAgentTask({
        chatId: chatIdStr,
        prompt: payload.prompt,
        scheduleName: ctx.schedule.name,
        ...(payload.model ? { modelOverride: payload.model } : {}),
      });
      const tokens = result.tokensInput + result.tokensOutput;
      if (result.status === 'completed') {
        return { status: 'success', tokensUsed: tokens, output: result.text.slice(0, 1000) };
      }
      return {
        status: 'fail',
        tokensUsed: tokens,
        error: `session ended with status=${result.status}${result.error ? ` — ${result.error}` : ''}`,
      };
    } catch (e) {
      return { status: 'fail', error: (e as Error).message };
    }
  },
};
