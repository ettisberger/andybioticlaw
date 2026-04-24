#!/usr/bin/env node
/**
 * Philips Hue MCP server. Spawned per agent session by the core service
 * when the hue skill is active.
 *
 * Exposes seven tools (list_lights, get_light, set_light_state,
 * list_rooms, set_room_state, list_scenes, activate_scene) backed by
 * the Hue Remote API v2 (https://api.meethue.com/route/api/{username}/…).
 * Exchanges the long-lived refresh token for a fresh access token on
 * demand (cached ~50 min).
 *
 * Environment contract (via skill manifest mcp_servers[].env):
 *   HUE_CLIENT_ID
 *   HUE_CLIENT_SECRET
 *   HUE_REDIRECT_URI
 *   HUE_ACCESS_TOKEN
 *   HUE_REFRESH_TOKEN
 *   HUE_BRIDGE_ID
 *   HUE_USERNAME
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const CLIENT_ID = process.env.HUE_CLIENT_ID;
const CLIENT_SECRET = process.env.HUE_CLIENT_SECRET;
const REDIRECT_URI = process.env.HUE_REDIRECT_URI;
const INITIAL_ACCESS_TOKEN = process.env.HUE_ACCESS_TOKEN;
const INITIAL_REFRESH_TOKEN = process.env.HUE_REFRESH_TOKEN;
const BRIDGE_ID = process.env.HUE_BRIDGE_ID;
const USERNAME = process.env.HUE_USERNAME;

if (
  !CLIENT_ID ||
  !CLIENT_SECRET ||
  !REDIRECT_URI ||
  !INITIAL_ACCESS_TOKEN ||
  !INITIAL_REFRESH_TOKEN ||
  !BRIDGE_ID ||
  !USERNAME
) {
  process.stderr.write(
    'hue-mcp-server: missing required env (CLIENT_ID / CLIENT_SECRET / REDIRECT_URI / ACCESS_TOKEN / REFRESH_TOKEN / BRIDGE_ID / USERNAME)\n',
  );
  process.exit(64);
}

// ---------------------------------------------------------------------------
// OAuth token cache.
//
// The initial access token comes from .env and is valid for ~7 days. We
// cache it in memory with a conservative expiry (the expires_in from the
// token exchange isn't in .env, so we assume 1 h on boot — the refresh
// path kicks in if it actually expired earlier). Refresh tokens rotate on
// each use (~100-day lifetime); we keep the latest in memory only. If
// the service restarts after a refresh, we fall back to the initial
// refresh token from .env — which is still valid unless we're past the
// 100-day mark. If the whole chain expires, the operator re-runs
// `andybioticlaw skill setup hue`.
// ---------------------------------------------------------------------------
let tokenState = {
  access_token: INITIAL_ACCESS_TOKEN,
  refresh_token: INITIAL_REFRESH_TOKEN,
  // Boot-time guess — 1 h from now. Gets replaced on the first successful refresh.
  expires_at: Date.now() + 60 * 60 * 1000,
};

async function refreshToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokenState.refresh_token,
    redirect_uri: REDIRECT_URI,
  });
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.meethue.com/v2/oauth2/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (text.includes('invalid_grant')) {
      throw new Error(
        'Hue OAuth refresh token is invalid (revoked or expired). ' +
          "Tell the principal to run `andybioticlaw skill setup hue` on their VPS.",
      );
    }
    throw new Error(`Hue OAuth refresh failed: HTTP ${res.status} ${text}`);
  }
  const json = await res.json();
  const ttlMs = (json.expires_in ?? 3600) * 1000;
  tokenState = {
    access_token: json.access_token,
    // Philips rotates refresh_token on each use. If they omit it in the
    // response (shouldn't happen, but defensive) we keep the current.
    refresh_token: json.refresh_token ?? tokenState.refresh_token,
    expires_at: Date.now() + ttlMs,
  };
}

async function getAccessToken() {
  // Refresh if we're within 60 s of expiry.
  if (tokenState.expires_at <= Date.now() + 60_000) {
    await refreshToken();
  }
  return tokenState.access_token;
}

// ---------------------------------------------------------------------------
// Minimal Hue Remote API client. All methods return parsed JSON or throw.
//
// The Hue API wraps every call in the /route/api/{username}/… path. Error
// responses are a quirky shape — instead of non-2xx, the bridge returns
// 200 with a body like `[{"error":{"type":3,"description":"…"}}]` for
// some failures. We normalise both to thrown errors.
// ---------------------------------------------------------------------------
async function hue(method, path, body) {
  const token = await getAccessToken();
  const url = `https://api.meethue.com/route/api/${encodeURIComponent(USERNAME)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Hue Remote API: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  // Bridge-level errors: array with first element `{error: {description}}`.
  if (Array.isArray(parsed) && parsed[0]?.error?.description) {
    throw new Error(`Hue bridge: ${parsed[0].error.description}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Tool definitions.
// ---------------------------------------------------------------------------
const SERVER_NAME = 'hue';

const TOOLS = [
  {
    name: 'list_lights',
    description:
      "List all lights on the principal's bridge with their current state (on, brightness, reachability, colour mode).",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_light',
    description:
      'Fetch the full state for one specific light by its Hue id. Use after list_lights when you need more detail.',
    inputSchema: {
      type: 'object',
      properties: { lightId: { type: 'string', description: 'Hue light id (a small integer string, e.g. "3").' } },
      required: ['lightId'],
    },
  },
  {
    name: 'set_light_state',
    description:
      'Change the state of one light. Only include the fields you want to change. `brightness` is 1-254 (254 = max). `color_temp_mireds` is 153 (cool/6500K) to 500 (warm/2000K). `color_xy` is CIE xyY as [x, y].',
    inputSchema: {
      type: 'object',
      properties: {
        lightId: { type: 'string' },
        on: { type: 'boolean' },
        brightness: { type: 'integer', minimum: 1, maximum: 254 },
        color_xy: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
        },
        color_temp_mireds: { type: 'integer', minimum: 153, maximum: 500 },
        transitiontime: {
          type: 'integer',
          minimum: 0,
          description: 'Deciseconds (tenths of a second). Default 4 = 400ms.',
        },
      },
      required: ['lightId'],
    },
  },
  {
    name: 'list_rooms',
    description:
      'List Hue rooms (groups with type "Room"). Returns id, name, member lights, and whether any/all lights are on. Prefer this + set_room_state for "turn off the kitchen" over looping through individual lights.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_room_state',
    description:
      'Change the state of every light in one room simultaneously. Same argument shape as set_light_state but targets a group.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string' },
        on: { type: 'boolean' },
        brightness: { type: 'integer', minimum: 1, maximum: 254 },
        color_xy: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
        },
        color_temp_mireds: { type: 'integer', minimum: 153, maximum: 500 },
        transitiontime: { type: 'integer', minimum: 0 },
      },
      required: ['roomId'],
    },
  },
  {
    name: 'list_scenes',
    description:
      "List saved scenes. Pass `roomId` to scope the list to one room's scenes.",
    inputSchema: {
      type: 'object',
      properties: { roomId: { type: 'string' } },
    },
  },
  {
    name: 'activate_scene',
    description:
      "Activate a scene. Applies the scene's saved state to every light in its associated room.",
    inputSchema: {
      type: 'object',
      properties: { sceneId: { type: 'string' } },
      required: ['sceneId'],
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

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errorResult(message) {
  return {
    content: [{ type: 'text', text: `ERROR: ${message}` }],
    isError: true,
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/**
 * Translate Hue's raw `state` / `action` object into a compact shape
 * that's easier for the agent to reason about. The raw form mixes
 * `bri` (brightness), `xy` (colour), `ct` (colour-temp in mireds),
 * `colormode` and more — we surface only what matters for chat UX.
 */
function compactLightState(raw) {
  if (!raw) return {};
  return {
    on: raw.on === true,
    brightness: typeof raw.bri === 'number' ? raw.bri : null,
    reachable: raw.reachable !== false,
    color_mode: raw.colormode ?? null,
    color_xy: Array.isArray(raw.xy) ? raw.xy : null,
    color_temp_mireds: typeof raw.ct === 'number' ? raw.ct : null,
  };
}

/**
 * Convert agent-facing fields to Hue's native state object:
 *   on                → on
 *   brightness        → bri
 *   color_xy          → xy
 *   color_temp_mireds → ct
 *   transitiontime    → transitiontime
 * Omits undefined keys so "only change what I asked for" semantics hold.
 */
function toHueState(args) {
  const s = {};
  if (args.on !== undefined) s.on = args.on;
  if (args.brightness !== undefined) s.bri = args.brightness;
  if (args.color_xy !== undefined) s.xy = args.color_xy;
  if (args.color_temp_mireds !== undefined) s.ct = args.color_temp_mireds;
  if (args.transitiontime !== undefined) s.transitiontime = args.transitiontime;
  return s;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case 'list_lights': {
        const res = await hue('GET', '/lights');
        // Hue returns lights as `{ id: { name, state, … } }`. Flatten.
        const lights = Object.entries(res ?? {}).map(([id, l]) => ({
          id,
          name: l.name,
          ...compactLightState(l.state),
        }));
        return textResult({ lights, count: lights.length });
      }

      case 'get_light': {
        if (!args.lightId) return errorResult('lightId is required');
        const l = await hue('GET', `/lights/${encodeURIComponent(args.lightId)}`);
        return textResult({
          id: args.lightId,
          name: l?.name,
          type: l?.type,
          modelid: l?.modelid,
          ...compactLightState(l?.state),
        });
      }

      case 'set_light_state': {
        if (!args.lightId) return errorResult('lightId is required');
        const state = toHueState(args);
        if (Object.keys(state).length === 0) {
          return errorResult('no state fields to change');
        }
        const res = await hue(
          'PUT',
          `/lights/${encodeURIComponent(args.lightId)}/state`,
          state,
        );
        return textResult({ applied: state, raw: res });
      }

      case 'list_rooms': {
        const res = await hue('GET', '/groups');
        const rooms = Object.entries(res ?? {})
          .filter(([, g]) => g.type === 'Room')
          .map(([id, g]) => ({
            id,
            name: g.name,
            type: g.type,
            light_ids: g.lights ?? [],
            any_on: g.state?.any_on === true,
            all_on: g.state?.all_on === true,
            brightness: typeof g.action?.bri === 'number' ? g.action.bri : null,
          }));
        return textResult({ rooms, count: rooms.length });
      }

      case 'set_room_state': {
        if (!args.roomId) return errorResult('roomId is required');
        const state = toHueState(args);
        if (Object.keys(state).length === 0) {
          return errorResult('no state fields to change');
        }
        const res = await hue(
          'PUT',
          `/groups/${encodeURIComponent(args.roomId)}/action`,
          state,
        );
        return textResult({ applied: state, raw: res });
      }

      case 'list_scenes': {
        const res = await hue('GET', '/scenes');
        let scenes = Object.entries(res ?? {}).map(([id, s]) => ({
          id,
          name: s.name,
          group_id: s.group,
          type: s.type,
        }));
        if (args.roomId) {
          scenes = scenes.filter((s) => s.group_id === args.roomId);
        }
        return textResult({ scenes, count: scenes.length });
      }

      case 'activate_scene': {
        if (!args.sceneId) return errorResult('sceneId is required');
        // The scene's group is required to activate it, so fetch first.
        const scene = await hue('GET', `/scenes/${encodeURIComponent(args.sceneId)}`);
        const groupId = scene?.group;
        if (!groupId) {
          return errorResult('scene has no associated group — cannot activate');
        }
        const res = await hue(
          'PUT',
          `/groups/${encodeURIComponent(groupId)}/action`,
          { scene: args.sceneId },
        );
        return textResult({ activated: args.sceneId, group: groupId, raw: res });
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
