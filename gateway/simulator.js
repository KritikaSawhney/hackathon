/**
 * EchoLog Bee Wearable Stream Simulator — simulator.js
 * Fires transcript chunks every 15 seconds to the gateway /webhook/bee-stream endpoint.
 * Simulates real developer conversations captured by the Bee AI wearable device.
 */

const http = require('http');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const INTERVAL_MS = parseInt(process.env.SIMULATOR_INTERVAL_MS || '15000', 10);

// ─────────────────────────────────────────────
// Real-world developer conversation corpus
// These simulate genuine architectural discussions captured mid-conversation.
// ─────────────────────────────────────────────
const CONVERSATION_CORPUS = [
  {
    session_id: 'session-alpha',
    chunk: "Okay so for the auth service, let's use Redis for the session cache instead of in-memory store. " +
           "Kafka is definitely overkill here — it's a microservice boundary problem, not a streaming problem. " +
           "Redis Cluster gives us the horizontal scalability we need without the operational overhead. " +
           "Let's add this to the auth.ts service and update the config accordingly.",
  },
  {
    session_id: 'session-alpha',
    chunk: "The API gateway is becoming a bottleneck. We need to implement circuit breaker pattern using Resilience4j. " +
           "The timeout on the payment service is cascading upstream and causing the product catalog calls to fail. " +
           "Action item: set timeout to 2000ms and fallback to the cached product list in database.ts. " +
           "Sarah, can you add the Resilience4j dependency to the pom.xml?",
  },
  {
    session_id: 'session-beta',
    chunk: "We found the memory leak — it's in the event listener in socketHandler.js. " +
           "We're attaching a new listener on every reconnect but never removing the old ones. " +
           "Classic Node.js EventEmitter mistake. Fix is to call removeAllListeners before re-attaching, " +
           "or better yet, use the once() pattern instead of on(). This needs to go in as a hotfix today.",
  },
  {
    session_id: 'session-beta',
    chunk: "For the ML inference pipeline, we should decouple the preprocessing from the model serving. " +
           "Right now it's all squashed into one FastAPI endpoint which makes it impossible to scale separately. " +
           "My recommendation: separate containers — one for feature engineering, one for the ONNX model runtime. " +
           "Use a Redis queue between them. Target SLA is sub-200ms p99 latency. " +
           "Update the model_server.py and create a new feature_processor.py module.",
  },
  {
    session_id: 'session-gamma',
    chunk: "The database schema migration for user_preferences is blocking three teams. " +
           "We're adding JSON column preferences_blob to avoid the nullable columns proliferation we talked about. " +
           "PostgreSQL JSONB gives us indexing support when we eventually need to query on preference keys. " +
           "Migration file 0042_add_preferences_blob.sql needs to be reviewed by EOD. " +
           "This unblocks the personalization team completely.",
  },
  {
    session_id: 'session-gamma',
    chunk: "Security review flagged the JWT implementation in middleware.ts. " +
           "We're not validating the algorithm field — this opens us to the none algorithm attack. " +
           "Fix: explicitly pass { algorithms: ['RS256'] } to the verify call and reject anything else. " +
           "Also rotate the signing key immediately — treat the current key as compromised. " +
           "This is a severity-1 security finding, must be in production by tonight.",
  },
  {
    session_id: 'session-delta',
    chunk: "Let's talk about the CDN strategy for static assets. " +
           "Right now we're serving everything from the origin which adds 400ms on average for APAC users. " +
           "CloudFront with S3 origin is the obvious choice. We need to set Cache-Control headers properly — " +
           "immutable for hashed assets, no-cache for the HTML shell. " +
           "Expected improvement: 60-70% reduction in TTFB for international users. " +
           "Update next.config.js and the deployment scripts.",
  },
  {
    session_id: 'session-delta',
    chunk: "The GraphQL N+1 problem is killing our database. " +
           "Every user query is firing 50+ individual SQL queries for their posts and comments. " +
           "We need DataLoader implemented immediately. Create a dataloader.ts in the resolvers directory. " +
           "Batch size should be 100 per tick of the event loop. " +
           "This should reduce our RDS CPU from 94% back to something sane, probably under 30%.",
  },
  {
    session_id: 'session-epsilon',
    chunk: "Kubernetes pod autoscaling config is wrong — the HPA is configured on CPU but our service is I/O bound, " +
           "not CPU bound. We need to switch to custom metrics from Prometheus. " +
           "Specifically, scale on http_requests_in_flight metric with a target of 100 concurrent requests per pod. " +
           "Update the hpa.yaml manifest and add the Prometheus adapter config. " +
           "This will fix the latency spikes we see during business hours.",
  },
  {
    session_id: 'session-epsilon',
    chunk: "Agreed on using Event Sourcing for the order management domain. " +
           "Traditional CRUD is insufficient for our audit requirements. " +
           "We'll use EventStore DB — it's purpose-built for this pattern. " +
           "Each order state change becomes an immutable event. Projections handle the read models. " +
           "We need to rewrite the OrderService entirely. Start with OrderCreated, OrderPaid, OrderShipped events. " +
           "Target: order_service.ts refactor by end of sprint.",
  },
];

let currentIndex = 0;

/**
 * Posts a transcript chunk to the gateway via HTTP POST.
 * @param {object} payload - { chunk, session_id }
 */
function postChunkToGateway(payload) {
  const bodyData = JSON.stringify(payload);

  const options = {
    hostname: 'localhost',
    port: 8080,
    path: '/webhook/bee-stream',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyData),
      'X-EchoLog-Source': 'simulator-v1',
    },
  };

  const req = http.request(options, (res) => {
    let responseBody = '';
    res.on('data', (chunk) => { responseBody += chunk; });
    res.on('end', () => {
      if (res.statusCode === 202) {
        console.log(`[SIMULATOR] ✓ Chunk #${currentIndex} accepted by Gateway (session: ${payload.session_id})`);
      } else {
        console.warn(`[SIMULATOR] ⚠ Gateway responded with ${res.statusCode}: ${responseBody}`);
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[SIMULATOR] ✗ Failed to post to Gateway: ${err.message}`);
    console.error(`[SIMULATOR]   Is the gateway running on port 8080?`);
  });

  req.setTimeout(5000, () => {
    console.error(`[SIMULATOR] ✗ Request timed out after 5s`);
    req.destroy();
  });

  req.write(bodyData);
  req.end();
}

/**
 * Main simulation loop — fires a new conversation chunk every INTERVAL_MS milliseconds.
 */
function startSimulator() {
  console.log(`\n[SIMULATOR] 🎙  Bee Wearable AI Stream Simulator started`);
  console.log(`[SIMULATOR]    Firing chunks every ${INTERVAL_MS / 1000}s`);
  console.log(`[SIMULATOR]    Corpus size: ${CONVERSATION_CORPUS.length} conversations\n`);

  // Fire the first chunk immediately
  const fireChunk = () => {
    const payload = CONVERSATION_CORPUS[currentIndex % CONVERSATION_CORPUS.length];
    console.log(`\n[SIMULATOR] 🔊 Sending chunk ${currentIndex + 1}/${CONVERSATION_CORPUS.length}:`);
    console.log(`[SIMULATOR]    Session: ${payload.session_id}`);
    console.log(`[SIMULATOR]    Preview: "${payload.chunk.substring(0, 80)}..."`);
    postChunkToGateway(payload);
    currentIndex++;
  };

  fireChunk();
  const intervalHandle = setInterval(fireChunk, INTERVAL_MS);

  // Expose stop function for graceful shutdown
  process.on('SIGINT', () => {
    clearInterval(intervalHandle);
    console.log('\n[SIMULATOR] Stopped.');
  });
  process.on('SIGTERM', () => {
    clearInterval(intervalHandle);
    console.log('\n[SIMULATOR] Stopped.');
  });
}

// Auto-start when required by server.js
startSimulator();
