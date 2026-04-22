import type { FastifyPluginAsync } from 'fastify';
import type { LogBroadcaster } from '../log-broadcaster.js';

export interface LogsRoutesDeps {
  broadcaster: LogBroadcaster;
}

/**
 * WebSocket endpoint at `/api/logs/stream`: every JSON-line appended to
 * `data/logs/andybioticlaw.log` is forwarded to every connected client.
 * No back-buffer — clients see only lines appended after they connect.
 */
export const logsRoutes =
  (deps: LogsRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/logs/stream', { websocket: true }, (socket) => {
      const listener = (line: string) => {
        if (socket.readyState === socket.OPEN) {
          try {
            socket.send(line);
          } catch {
            /* socket gone — listener removed on close */
          }
        }
      };
      deps.broadcaster.on('line', listener);
      socket.on('close', () => {
        deps.broadcaster.off('line', listener);
      });
    });
  };
