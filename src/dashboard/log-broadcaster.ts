import { createReadStream, existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';

/**
 * Tails the JSON-lines log file at `logPath` and emits each appended line
 * as a `line` event. The WebSocket route subscribes to this stream and
 * forwards lines to connected browsers.
 *
 * Uses fs.watch (change events) + a rolling read offset. Simpler than a
 * real `tail -F` but does the job for a single-writer log.
 */
export interface LogBroadcaster extends EventEmitter {
  start(): void;
  stop(): void;
  on(event: 'line', listener: (line: string) => void): this;
}

export function createLogBroadcaster(logPath: string, logger: Logger): LogBroadcaster {
  const emitter = new EventEmitter() as LogBroadcaster;
  let offset = 0;
  let watcher: FSWatcher | null = null;
  let buffer = '';

  function seekToEnd(): void {
    if (!existsSync(logPath)) {
      offset = 0;
      return;
    }
    try {
      offset = statSync(logPath).size;
    } catch {
      offset = 0;
    }
  }

  function readAppended(): void {
    if (!existsSync(logPath)) return;
    let size: number;
    try {
      size = statSync(logPath).size;
    } catch {
      return;
    }
    if (size < offset) {
      // File truncated (logrotate). Reset offset and keep going.
      offset = 0;
      buffer = '';
    }
    if (size <= offset) return;
    const stream = createReadStream(logPath, { start: offset, end: size - 1 });
    let chunkBytes = 0;
    stream.on('data', (chunk) => {
      chunkBytes += chunk.length;
      buffer += chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) emitter.emit('line', line);
        nl = buffer.indexOf('\n');
      }
    });
    stream.on('end', () => {
      offset += chunkBytes;
    });
    stream.on('error', (e) => {
      logger.debug({ err: e.message }, 'log broadcaster read error');
    });
  }

  emitter.start = () => {
    if (watcher) return;
    seekToEnd();
    try {
      watcher = watch(logPath, { persistent: false }, () => readAppended());
    } catch (e) {
      logger.warn(
        { err: (e as Error).message, logPath },
        'could not start log watcher; live-log view will be empty',
      );
    }
  };
  emitter.stop = () => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  };
  return emitter;
}
