/**
 * EchoLog Event Gateway — server.js
 * HTTP port: 8080   WebSocket port: 8081
 * Handles Bee Wearable stream ingestion and VS Code client broadcasting.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const HTTP_PORT = 8080;
const WS_PORT = 8081;
const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://localhost:5000';

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// In-memory transcript buffer per session
const transcriptBuffer = [];

/**
 * POST /webhook/bee-stream
 * Receives transcript chunks from the Bee Wearable / simulator.
 * Accumulates chunks and forwards to the AI Engine for processing.
 */
app.post('/webhook/bee-stream', async (req, res) => {
  const { chunk, session_id = 'default' } = req.body;

  if (!chunk || typeof chunk !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "chunk" field in request body.' });
  }

  transcriptBuffer.push({ chunk, session_id, received_at: new Date().toISOString() });

  console.log(`[GATEWAY] Bee stream chunk received (session: ${session_id}): "${chunk.substring(0, 60)}..."`);

  // Fire-and-forget to AI Engine — don't block the response
  setImmediate(async () => {
    try {
      const response = await axios.post(`${AI_ENGINE_URL}/process`, {
        transcript: chunk,
        session_id,
      }, { timeout: 30000 });

      console.log(`[GATEWAY] AI Engine processed successfully: ${JSON.stringify(response.data).substring(0, 120)}`);
    } catch (err) {
      const msg = err.response
        ? `AI Engine returned ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : `Failed to reach AI Engine at ${AI_ENGINE_URL}: ${err.message}`;
      console.error(`[GATEWAY] ${msg}`);
    }
  });

  return res.status(202).json({ status: 'accepted', message: 'Chunk queued for AI processing.' });
});

/**
 * POST /internal/broadcast
 * Receives structured JSON decisions from the AI Engine
 * and broadcasts them to all connected VS Code WebSocket clients.
 */
app.post('/internal/broadcast', (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid payload. Expected a JSON object.' });
  }

  const message = JSON.stringify(payload);
  let broadcastCount = 0;

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
        broadcastCount++;
      } catch (sendErr) {
        console.error(`[GATEWAY] Failed to send to WS client: ${sendErr.message}`);
      }
    }
  });

  console.log(`[GATEWAY] Broadcasted decision to ${broadcastCount} VS Code client(s).`);
  return res.status(200).json({ status: 'broadcasted', clients: broadcastCount });
});

/**
 * GET /health
 * Basic health check for monitoring.
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    gateway: 'EchoLog Event Gateway',
    http_port: HTTP_PORT,
    ws_port: WS_PORT,
    connected_clients: wss ? wss.clients.size : 0,
    uptime_seconds: Math.floor(process.uptime()),
    transcript_buffer_size: transcriptBuffer.length,
  });
});

/**
 * GET /buffer
 * Returns the current in-memory transcript buffer (debugging / demo).
 */
app.get('/buffer', (req, res) => {
  res.json({ buffer: transcriptBuffer });
});

// ─────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────
const httpServer = http.createServer(app);

httpServer.listen(HTTP_PORT, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║       EchoLog Event Gateway           ║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  HTTP  → http://localhost:${HTTP_PORT}       ║`);
  console.log(`║  WS    → ws://localhost:${WS_PORT}         ║`);
  console.log(`║  AI    → ${AI_ENGINE_URL.padEnd(27)}  ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);
});

// ─────────────────────────────────────────────
// WebSocket Server (for VS Code Extension clients)
// ─────────────────────────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[GATEWAY] VS Code client connected from ${clientIp}. Total clients: ${wss.clients.size}`);

  // Send a welcome / handshake message
  ws.send(JSON.stringify({
    type: 'handshake',
    message: 'Connected to EchoLog Gateway',
    timestamp: new Date().toISOString(),
  }));

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      console.log(`[GATEWAY] Message from VS Code client: ${JSON.stringify(parsed).substring(0, 200)}`);

      // Handle export acknowledgement or any client commands here
      if (parsed.type === 'export_ack') {
        console.log(`[GATEWAY] VS Code client confirmed export: ${parsed.filepath}`);
      }
    } catch (parseErr) {
      console.warn(`[GATEWAY] Received non-JSON message from client: ${data.toString().substring(0, 100)}`);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[GATEWAY] VS Code client disconnected (code: ${code}). Remaining clients: ${wss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error(`[GATEWAY] WebSocket client error: ${err.message}`);
  });
});

wss.on('error', (err) => {
  console.error(`[GATEWAY] WebSocket server error: ${err.message}`);
});

// ─────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n[GATEWAY] Received ${signal}. Shutting down gracefully...`);
  wss.close(() => {
    httpServer.close(() => {
      console.log('[GATEWAY] All connections closed. Bye!');
      process.exit(0);
    });
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the simulator automatically if not in test mode
if (process.env.NO_SIMULATOR !== 'true') {
  // Delay simulator start slightly to ensure server is ready
  setTimeout(() => {
    try {
      require('./simulator');
    } catch (simErr) {
      console.error(`[GATEWAY] Failed to start simulator: ${simErr.message}`);
    }
  }, 2000);
}
