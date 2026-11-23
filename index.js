#!/usr/bin/env node
/**
 * cellmath-mcp — a minimal stdio <-> Streamable HTTP bridge for a CellMath MCP endpoint.
 *
 * Reads newline-delimited JSON-RPC 2.0 messages from stdin, forwards each one to the
 * Streamable HTTP endpoint given in CELLMATH_MCP_URL, and writes whatever comes back
 * (plain JSON or `text/event-stream`) to stdout as newline-delimited JSON.
 *
 * Configuration (environment variables):
 *   CELLMATH_MCP_URL        Streamable HTTP endpoint, e.g. https://<your-mcp-endpoint>/api/mcp
 *   CELLMATH_API_KEY        API key, sent as `Authorization: Bearer <key>`
 *   CELLMATH_MCP_TIMEOUT_MS Optional per-request timeout in milliseconds (default 120000)
 *
 * Requires Node.js 18 or newer. No external dependencies.
 */

import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY = 500;

const endpoint = (process.env.CELLMATH_MCP_URL ?? '').trim();
const apiKey = (process.env.CELLMATH_API_KEY ?? '').trim();
const parsedTimeout = Number(process.env.CELLMATH_MCP_TIMEOUT_MS);
const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;

const missing = [];
if (!endpoint) missing.push('CELLMATH_MCP_URL');
if (!apiKey) missing.push('CELLMATH_API_KEY');

if (missing.length > 0) {
  process.stderr.write(
    [
      `cellmath-mcp: missing required environment variable(s): ${missing.join(', ')}`,
      '',
      'Set both variables before starting the bridge, for example:',
      '',
      '  CELLMATH_MCP_URL="https://<your-mcp-endpoint>/api/mcp" \\',
      '  CELLMATH_API_KEY="sk_live_<your_api_key>" \\',
      '  cellmath-mcp',
      '',
      'MCP clients can pass them in the "env" block of their server configuration.',
      'See .env.example for a local shell setup. The API key is never written to disk.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

let target;
try {
  target = new URL(endpoint);
} catch {
  process.stderr.write(`cellmath-mcp: CELLMATH_MCP_URL is not a valid URL: ${endpoint}\n`);
  process.exit(1);
}

if (target.protocol !== 'https:' && target.protocol !== 'http:') {
  process.stderr.write('cellmath-mcp: CELLMATH_MCP_URL must use http:// or https://\n');
  process.exit(1);
}

if (target.protocol === 'http:' && !isLoopback(target.hostname)) {
  process.stderr.write(
    'cellmath-mcp: warning: CELLMATH_MCP_URL is plain http on a non-local host; your API key will travel unencrypted.\n',
  );
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function log(message) {
  process.stderr.write(`cellmath-mcp: ${message}\n`);
}

function redact(text) {
  const value = String(text);
  return apiKey ? value.split(apiKey).join('[redacted]') : value;
}

function truncate(text, limit) {
  const value = String(text).trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function writeOut(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    log(`could not write to stdout: ${redact(error instanceof Error ? error.message : error)}`);
  }
}

// Session id handed out by the server (optional in the Streamable HTTP transport).
let sessionId = null;

/**
 * Send one JSON-RPC payload to the endpoint and return the JSON-RPC messages it produced.
 * Returns an empty array for notifications (202/204 or an empty body).
 */
async function forward(payload) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${apiKey}`,
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const response = await fetch(target, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const issuedSessionId = response.headers.get('mcp-session-id');
  if (issuedSessionId) {
    sessionId = issuedSessionId;
  }

  if (response.status === 202 || response.status === 204) {
    if (response.body) {
      await response.body.cancel().catch(() => {});
    }
    return [];
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (!response.ok) {
    const detail = truncate(await safeText(response), MAX_ERROR_BODY);
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`upstream returned HTTP ${response.status} ${response.statusText}${suffix}`);
  }

  if (contentType.includes('text/event-stream')) {
    return parseSse(await response.text());
  }

  const text = await response.text();
  if (!text.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Some servers answer with SSE even without a matching Content-Type header.
    const events = parseSse(text);
    if (events.length > 0) {
      return events;
    }
    throw new Error('upstream response could not be parsed as JSON or SSE');
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Parse a `text/event-stream` body into the JSON-RPC messages carried in its `data:` fields. */
function parseSse(text) {
  const messages = [];
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        messages.push(...parsed);
      } else {
        messages.push(parsed);
      }
    } catch {
      log(`ignoring an SSE event that was not JSON (${truncate(raw, 120)})`);
    }
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  flush();

  return messages;
}

function requestIds(payload) {
  const items = Array.isArray(payload) ? payload : [payload];
  return items
    .filter((item) => item && typeof item === 'object' && item.id !== undefined && item.id !== null)
    .map((item) => item.id);
}

async function handlePayload(payload) {
  const ids = requestIds(payload);

  let messages;
  try {
    messages = await forward(payload);
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : error);
    log(`request failed: ${message}`);
    for (const id of ids) {
      writeOut({ jsonrpc: '2.0', id, error: { code: -32603, message } });
    }
    return;
  }

  if (messages.length === 0) {
    for (const id of ids) {
      writeOut({ jsonrpc: '2.0', id, error: { code: -32603, message: 'upstream returned no response payload' } });
    }
    return;
  }

  for (const message of messages) {
    writeOut(message);
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Messages are forwarded one at a time so that ordering is preserved
// (initialize before the calls that depend on it).
let chain = Promise.resolve();

reader.on('line', (line) => {
  const text = line.trim();
  if (!text) return;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    writeOut({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: stdin line was not valid JSON' } });
    return;
  }

  chain = chain.then(() => handlePayload(payload));
});

reader.on('close', () => {
  chain.then(() => setImmediate(() => process.exit(0)));
});

process.on('unhandledRejection', (reason) => {
  log(`unhandled error: ${redact(reason instanceof Error ? reason.message : reason)}`);
});

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
