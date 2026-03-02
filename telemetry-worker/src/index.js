// Cloudflare Worker — CW CAT telemetry ingest
// Receives JSON POST from beta clients, stores to R2 bucket

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'POST only' }, { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/ingest' && url.pathname !== '/cwcat/ingest') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 });
    }

    // Validate required fields
    if (!body.v || !body.betaId || !body.sessionId) {
      return Response.json({ error: 'missing required fields: v, betaId, sessionId' }, { status: 400 });
    }

    // Store to R2
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const ts = Date.now();
    const app = url.pathname.startsWith('/cwcat/') ? 'cwcat' : 'potacat';
    const key = `${app}/${date}/${body.betaId}/${body.sessionId}-${ts}.json`;

    await env.TELEMETRY.put(key, JSON.stringify(body), {
      httpMetadata: { contentType: 'application/json' },
    });

    return Response.json({ ok: true }, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  },
};
