#!/usr/bin/env node
/**
 * Google Calendar MCP server. Spawned per agent session by the core
 * service when the google-calendar skill is active.
 *
 * Exposes 6 tools (list/get/create/update/delete events + list_calendars) backed by the
 * Google Calendar API v3. Exchanges the long-lived refresh token for a
 * fresh access token on each call (cached ~50 min).
 *
 * Environment contract (via skill manifest mcp_servers[].env):
 *   GOOGLE_CALENDAR_CLIENT_ID
 *   GOOGLE_CALENDAR_CLIENT_SECRET
 *   GOOGLE_CALENDAR_REFRESH_TOKEN
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write(
    'google-calendar-mcp-server: missing required env (CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN)\n',
  );
  process.exit(64);
}

// ---------------------------------------------------------------------------
// OAuth token cache: fetch a fresh access_token, keep it for ~50 minutes.
// ---------------------------------------------------------------------------
let cachedToken = null; // { access_token, expires_at (ms) }

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at > now + 60_000) {
    return cachedToken.access_token;
  }
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // `invalid_grant` → token is revoked/expired; surface clearly.
    if (text.includes('invalid_grant')) {
      throw new Error(
        'Google OAuth refresh token is invalid (revoked or expired). ' +
          "Tell the principal to run `andybioticlaw skill setup google-calendar` on their VPS.",
      );
    }
    throw new Error(`OAuth token refresh failed: HTTP ${res.status} ${text}`);
  }
  const json = await res.json();
  const ttlMs = (json.expires_in ?? 3600) * 1000;
  cachedToken = {
    access_token: json.access_token,
    expires_at: now + ttlMs,
  };
  return cachedToken.access_token;
}

// ---------------------------------------------------------------------------
// Minimal Google Calendar v3 client. All methods return parsed JSON or throw.
// ---------------------------------------------------------------------------
async function gcal(method, path, query, body) {
  const token = await getAccessToken();
  const url = new URL(`https://www.googleapis.com/calendar/v3${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const msg = parsed?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Google Calendar API: ${msg}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Tool definitions — shown in system prompt + driven by callTool handler.
// ---------------------------------------------------------------------------
const SERVER_NAME = 'google-calendar';

const TOOLS = [
  {
    name: 'list_calendars',
    description:
      "List all calendars the principal has access to (own, shared, and subscribed). Returns each calendar's id, summary, primary flag, accessRole, and timeZone. Use the returned `id` as the `calendarId` argument for the other tools to operate on a non-primary calendar.",
    inputSchema: {
      type: 'object',
      properties: {
        showHidden: {
          type: 'boolean',
          description:
            'Include calendars the principal has hidden in the Google Calendar UI. Defaults to false.',
          default: false,
        },
        minAccessRole: {
          type: 'string',
          description:
            'Filter to calendars where the principal has at least this role. One of: freeBusyReader, reader, writer, owner.',
          enum: ['freeBusyReader', 'reader', 'writer', 'owner'],
        },
      },
    },
  },
  {
    name: 'list_events',
    description:
      "List events from the principal's calendar in a time window. Returns a compact summary — call `get_event` for full detail on a specific event.",
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'string',
          description:
            'Calendar id. Defaults to "primary" (the principal\'s main calendar).',
          default: 'primary',
        },
        timeMin: {
          type: 'string',
          description:
            'ISO 8601 timestamp — only events starting at or after this time. Use timezone-aware strings.',
        },
        timeMax: {
          type: 'string',
          description:
            'ISO 8601 timestamp — only events starting before this time.',
        },
        maxResults: {
          type: 'integer',
          description: 'Max events to return (1–250). Default 25.',
          minimum: 1,
          maximum: 250,
          default: 25,
        },
        q: {
          type: 'string',
          description: 'Free-text search across summary, description, location.',
        },
      },
    },
  },
  {
    name: 'get_event',
    description: 'Fetch one event by id.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', default: 'primary' },
        eventId: { type: 'string' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'create_event',
    description:
      "Create a new event on the principal's calendar. Requires the principal's explicit confirmation in the current DM before calling. `start` and `end` are Google Calendar EventDateTime objects: `{ dateTime, timeZone }` for timed events or `{ date }` for all-day.",
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', default: 'primary' },
        summary: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        start: {
          type: 'object',
          description:
            '{ dateTime: ISO, timeZone: "Europe/Zurich" } OR { date: "2026-04-25" }',
        },
        end: {
          type: 'object',
          description: 'Same shape as `start`.',
        },
        attendees: {
          type: 'array',
          items: {
            type: 'object',
            properties: { email: { type: 'string' } },
            required: ['email'],
          },
        },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'update_event',
    description:
      'Patch an existing event. Only fields provided get changed. Requires explicit principal confirmation in the current DM.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', default: 'primary' },
        eventId: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        start: { type: 'object' },
        end: { type: 'object' },
        attendees: {
          type: 'array',
          items: {
            type: 'object',
            properties: { email: { type: 'string' } },
            required: ['email'],
          },
        },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'delete_event',
    description:
      'Delete an event. IRREVERSIBLE. Requires explicit principal confirmation in the current DM before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', default: 'primary' },
        eventId: { type: 'string' },
      },
      required: ['eventId'],
    },
  },
];

// ---------------------------------------------------------------------------
// MCP server setup.
// ---------------------------------------------------------------------------
const server = new Server(
  { name: SERVER_NAME, version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: `ERROR: ${message}` }],
    isError: true,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const calendarId = args.calendarId || 'primary';

  try {
    switch (name) {
      case 'list_calendars': {
        const res = await gcal('GET', '/users/me/calendarList', {
          showHidden: args.showHidden ? 'true' : undefined,
          minAccessRole: args.minAccessRole,
        });
        const compact = (res.items ?? []).map((c) => ({
          id: c.id,
          summary: c.summary,
          summaryOverride: c.summaryOverride,
          description: c.description,
          primary: c.primary === true,
          accessRole: c.accessRole,
          timeZone: c.timeZone,
          backgroundColor: c.backgroundColor,
          selected: c.selected === true,
          hidden: c.hidden === true,
        }));
        return textResult({ calendars: compact, count: compact.length });
      }

      case 'list_events': {
        const res = await gcal('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
          timeMin: args.timeMin,
          timeMax: args.timeMax,
          maxResults: args.maxResults ?? 25,
          q: args.q,
          singleEvents: 'true',
          orderBy: 'startTime',
        });
        // Strip heavy fields the LLM doesn't need to reason.
        const compact = (res.items ?? []).map((ev) => ({
          id: ev.id,
          summary: ev.summary,
          description: ev.description,
          location: ev.location,
          start: ev.start,
          end: ev.end,
          attendees: ev.attendees?.map((a) => ({
            email: a.email,
            responseStatus: a.responseStatus,
          })),
          htmlLink: ev.htmlLink,
          status: ev.status,
        }));
        return textResult({ events: compact, count: compact.length });
      }

      case 'get_event': {
        if (!args.eventId) return errorResult('eventId is required');
        const res = await gcal(
          'GET',
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(args.eventId)}`,
        );
        return textResult(res);
      }

      case 'create_event': {
        if (!args.summary || !args.start || !args.end) {
          return errorResult('summary, start, end are required');
        }
        const body = {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: args.start,
          end: args.end,
          attendees: args.attendees,
        };
        const res = await gcal(
          'POST',
          `/calendars/${encodeURIComponent(calendarId)}/events`,
          null,
          body,
        );
        return textResult({
          id: res.id,
          htmlLink: res.htmlLink,
          summary: res.summary,
          start: res.start,
          end: res.end,
          status: res.status,
        });
      }

      case 'update_event': {
        if (!args.eventId) return errorResult('eventId is required');
        const patch = {};
        if (args.summary !== undefined) patch.summary = args.summary;
        if (args.description !== undefined) patch.description = args.description;
        if (args.location !== undefined) patch.location = args.location;
        if (args.start !== undefined) patch.start = args.start;
        if (args.end !== undefined) patch.end = args.end;
        if (args.attendees !== undefined) patch.attendees = args.attendees;
        if (Object.keys(patch).length === 0) {
          return errorResult('no fields to update');
        }
        const res = await gcal(
          'PATCH',
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(args.eventId)}`,
          null,
          patch,
        );
        return textResult({
          id: res.id,
          htmlLink: res.htmlLink,
          summary: res.summary,
          start: res.start,
          end: res.end,
          status: res.status,
        });
      }

      case 'delete_event': {
        if (!args.eventId) return errorResult('eventId is required');
        await gcal(
          'DELETE',
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(args.eventId)}`,
        );
        return textResult({ deleted: true, eventId: args.eventId });
      }

      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (e) {
    return errorResult(e?.message ?? String(e));
  }
});

// ---------------------------------------------------------------------------
// Stdio transport.
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
