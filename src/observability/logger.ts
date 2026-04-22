import pino from 'pino';
import type { Logger, LoggerOptions, DestinationStream } from 'pino';
import { existsSync, mkdirSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Build the pino logger.
 *
 * Development (NODE_ENV !== 'production' or stdout is TTY):
 *   pretty output to stdout via pino-pretty, human-readable timestamps.
 *
 * Production:
 *   JSON-lines to `data/logs/andybioticlaw.log`. Rotation is delegated to
 *   logrotate (configured by install.sh), not done inside the app.
 *
 * Redaction:
 *   Pino's `redact` takes a list of dotted paths (with limited wildcard
 *   support). We explicitly redact the core secret keys and a handful of
 *   common patterns anyone might end up passing in a log object. Secret
 *   values should never leave this module's trusted callers anyway — redact
 *   is belt-and-suspenders.
 */

export interface LoggerOptions2 {
  level: pino.Level;
  logsDir: string;
  pretty: boolean;
}

export function buildLogger(opts: LoggerOptions2): Logger {
  const redactPaths = [
    // Top-level fields common loggers might accidentally include.
    'token',
    'secret',
    'password',
    'api_key',
    'apiKey',
    'authorization',
    // Nested convention buckets.
    '*.token',
    '*.secret',
    '*.password',
    '*.api_key',
    '*.apiKey',
    // Known core secret names (when someone logs `env.FOO`).
    'env.TELEGRAM_BOT_TOKEN',
    'env.DASHBOARD_BASIC_AUTH_PASSWORD',
    'secrets.TELEGRAM_BOT_TOKEN',
    'secrets.DASHBOARD_BASIC_AUTH_PASSWORD',
  ];

  const base: LoggerOptions = {
    level: opts.level,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    base: { svc: 'andybioticlaw' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (opts.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,svc',
          singleLine: false,
        },
      },
    });
  }

  // Prod: write JSON-lines directly to the log file.
  if (!existsSync(opts.logsDir)) mkdirSync(opts.logsDir, { recursive: true });
  const logFile = resolve(opts.logsDir, 'andybioticlaw.log');
  const stream = fileStream(logFile);
  return pino(base, stream);
}

/**
 * Minimal file-append destination stream. We don't use pino.destination() so
 * that early-boot log lines are flushed immediately and the stream survives
 * synchronous exits.
 */
function fileStream(path: string): DestinationStream {
  // Ensure file exists so first write can't ENOENT under racy conditions.
  try {
    const fd = openSync(path, 'a');
    closeSync(fd);
  } catch {
    // Intentional no-op. If this fails, the write below will surface the real error.
  }
  return {
    write(chunk) {
      appendFileSync(path, chunk);
      return true;
    },
  };
}
