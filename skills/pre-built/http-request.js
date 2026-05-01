'use strict';

const MAX_RESPONSE_BYTES = 100 * 1024; // 100 KB — keeps responses context-window-safe

module.exports = {
  name: 'http-request',
  description:
    'Make an outbound HTTP or HTTPS request to any URL and return the response. ' +
    'Suitable for REST APIs, webhooks, or fetching web content. Requires user approval.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The full URL to request (http:// or https://)',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
        description: 'HTTP method (default: GET)',
      },
      headers: {
        type: 'object',
        description: 'Request headers as key-value string pairs',
        additionalProperties: { type: 'string' },
      },
      body: {
        type: 'string',
        description: 'Request body as a plain string (for POST/PUT/PATCH)',
      },
      bodyJson: {
        type: 'object',
        description: 'Request body as a JSON object — auto-serialised and sets Content-Type: application/json (use instead of body for JSON APIs)',
      },
      responseType: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'How to parse the response body (default: text; use json to auto-parse)',
      },
      timeoutMs: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 15000)',
      },
    },
    required: ['url'],
  },
  requiresApproval: true,

  execute: async ({ url, method = 'GET', headers = {}, body, bodyJson, responseType = 'text', timeoutMs = 15000 }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const reqHeaders = { 'User-Agent': 'AI-Agent-Builder/1.0', ...headers };
      let reqBody;

      if (bodyJson !== undefined) {
        reqBody = JSON.stringify(bodyJson);
        reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
        reqHeaders['Content-Length'] = String(Buffer.byteLength(reqBody));
      } else if (body) {
        reqBody = body;
        reqHeaders['Content-Length'] = String(Buffer.byteLength(body));
      }

      const fetchOptions = {
        method,
        headers: reqHeaders,
        signal: controller.signal,
        ...(reqBody && ['POST', 'PUT', 'PATCH'].includes(method) ? { body: reqBody } : {}),
      };

      const res = await fetch(url, fetchOptions);
      let rawText = await res.text();

      // Truncate oversized responses so they don't flood the context window
      let truncated = false;
      if (Buffer.byteLength(rawText) > MAX_RESPONSE_BYTES) {
        rawText = rawText.slice(0, MAX_RESPONSE_BYTES);
        truncated = true;
      }

      let parsedBody = rawText;
      if (responseType === 'json') {
        try { parsedBody = JSON.parse(rawText); }
        catch { parsedBody = rawText; }
      }

      return {
        success: res.ok,
        result: {
          url,
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          body: parsedBody,
          ...(truncated ? { truncated: true, note: `Response truncated at ${MAX_RESPONSE_BYTES} bytes` } : {}),
        },
        ...(!res.ok ? { error: `HTTP ${res.status} ${res.statusText}` } : {}),
      };
    } catch (err) {
      return {
        success: false,
        error: err.name === 'AbortError' ? `Request timed out after ${timeoutMs}ms` : err.message,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
