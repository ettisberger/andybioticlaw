export class SecretMissingError extends Error {
  readonly missing: string;
}

export function resolveSecrets(text: string): {
  text: string;
  usedSecret: boolean;
};
