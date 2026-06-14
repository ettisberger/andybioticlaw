export interface ProfileLockHolder {
  sessionId: string;
  startedAt: number;
  tool: string;
}

export class ProfileLockBusyError extends Error {
  readonly profile: string;
  readonly holder: ProfileLockHolder;
}

export class ProfileLockManager {
  acquire(profile: string, sessionId: string, tool: string): void;
  release(profile: string, sessionId: string): void;
  releaseAll(): void;
  status(): Array<{
    profile: string;
    sessionId: string;
    tool: string;
    heldForMs: number;
  }>;
}
