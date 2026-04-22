import type { AuditRepo } from '../db/repositories/audit.js';
import type { Logger } from 'pino';

export interface AuthConfig {
  dmAllowedUserIds: number[];
  groupAllowedGroupIds: number[];
}

export type AuthDecision =
  | { kind: 'allow-dm'; userId: number }
  | { kind: 'reject-dm'; userId: number; reason: string }
  | { kind: 'reject-group-v1'; chatId: number; chatType: string }
  | { kind: 'reject-unknown'; chatType: string };

export interface AuthChecker {
  check(args: {
    chatType: 'private' | 'group' | 'supergroup' | 'channel' | string;
    chatId: number;
    userId?: number | undefined;
  }): AuthDecision;
}

export function createAuthChecker(
  cfg: () => AuthConfig,
  audit: AuditRepo,
  logger: Logger,
): AuthChecker {
  return {
    check({ chatType, chatId, userId }) {
      if (chatType === 'private') {
        if (typeof userId !== 'number') {
          return { kind: 'reject-dm', userId: -1, reason: 'missing user id' };
        }
        const allowed = cfg().dmAllowedUserIds;
        if (!allowed.includes(userId)) {
          audit.record({
            kind: 'unauthorized_access',
            actor: `tg:${userId}`,
            detail: { chatType, chatId, userId, scope: 'dm' },
          });
          logger.warn(
            { userId, chatId },
            'rejected DM from non-allowlisted user',
          );
          return { kind: 'reject-dm', userId, reason: 'user not in DM allowlist' };
        }
        return { kind: 'allow-dm', userId };
      }

      if (chatType === 'group' || chatType === 'supergroup') {
        audit.record({
          kind: 'unauthorized_access',
          actor: `tg:group:${chatId}`,
          detail: { chatType, chatId, scope: 'group', reason: 'groups rejected in v1' },
        });
        logger.info(
          { chatId, chatType },
          'rejected group message — group support is planned but disabled in v1',
        );
        return { kind: 'reject-group-v1', chatId, chatType };
      }

      return { kind: 'reject-unknown', chatType };
    },
  };
}
