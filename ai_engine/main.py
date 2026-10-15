"""
EchoLog AI Engine — main.py
FastAPI server that processes raw developer conversation transcripts
through AWS Bedrock (Claude 3.5 Sonnet) and posts structured
DecisionExtraction objects back to the EchoLog Event Gateway.

Fallback Mode: If AWS credentials are absent, returns deterministic
mock data so the demo pipeline continues to function perfectly.
"""

from __future__ import annotations

import json
import logging
import os
import traceback
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ─────────────────────────────────────────────
# Load environment variables
# ─────────────────────────────────────────────
load_dotenv()

# ─────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  [AI_ENGINE] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────
GATEWAY_URL = os.getenv("GATEWAY_URL", "http://localhost:8080")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
BEDROCK_MODEL_ID = os.getenv(
    "BEDROCK_MODEL_ID", "anthropic.claude-3-5-sonnet-20241022-v2:0"
)
HAS_AWS_CREDENTIALS = bool(
    os.getenv("AWS_ACCESS_KEY_ID") and os.getenv("AWS_SECRET_ACCESS_KEY")
)

# ─────────────────────────────────────────────
# Pydantic Schemas
# ─────────────────────────────────────────────

CategoryType = Literal["Architecture", "Bug", "Action Item", "Security", "Performance"]


class DecisionExtraction(BaseModel):
    """Structured representation of a technical decision extracted from a transcript."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    category: CategoryType
    topic: str = Field(..., description="Short topic label, e.g. 'Redis Auth Cache'")
    summary: str = Field(
        ..., description="One-sentence summary of the technical observation"
    )
    decision: str = Field(
        ..., description="The concrete architectural or engineering decision made"
    )
    target_file: Optional[str] = Field(
        None,
        description="Source file most relevant to this decision (e.g. 'auth.ts'), or null",
    )
    confidence: float = Field(
        default=0.9, ge=0.0, le=1.0, description="Model confidence score (0-1)"
    )
    raw_source_preview: str = Field(
        default="", description="First 100 chars of original transcript"
    )


class ProcessRequest(BaseModel):
    transcript: str = Field(
        ..., min_length=10, description="Raw conversation transcript chunk"
    )
    session_id: str = Field(default="default")


class ProcessResponse(BaseModel):
    status: str
    decision: DecisionExtraction
    mode: Literal["bedrock", "mock"]


# ─────────────────────────────────────────────
# FastAPI Application
# ─────────────────────────────────────────────
app = FastAPI(
    title="EchoLog AI Engine",
    description="Processes raw developer transcripts into structured DevEx insights via AWS Bedrock.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────
# System Prompt for Claude
# ─────────────────────────────────────────────
SYSTEM_PROMPT = """You are an expert principal engineer and technical architect.
Your job is to extract concrete technical decisions from raw developer conversation transcripts.

Output ONLY a single valid JSON object matching this exact schema (no markdown, no explanation):
{
  "category": "<one of: Architecture | Bug | Performance | Security | Action Item>",
  "topic": "<3-6 word label for the technical topic>",
  "summary": "<one precise sentence describing what was discussed>",
  "decision": "<the specific engineering decision, recommendation, or action agreed upon>",
  "target_file": "<most relevant source file name if mentioned, e.g. auth.ts, or null>",
  "confidence": <float between 0 and 1 representing extraction confidence>
}

Rules:
- Be specific. Prefer technical nouns (Redis, HPA, DataLoader) over vague language.
- If no concrete decision was made, still extract the strongest recommendation.
- target_file must be a simple filename with extension (e.g. "middleware.ts"), or null.
- confidence should reflect how clearly a decision was captured (0.6-0.95 typical range).
"""

# ─────────────────────────────────────────────
# Mock Decision Corpus (deterministic fallback)
# ─────────────────────────────────────────────
MOCK_DECISIONS = [
    {
        "category": "Architecture",
        "topic": "Redis Auth Session Cache",
        "summary": "Team decided to replace in-memory session store with Redis Cluster for horizontal scalability.",
        "decision": "Use Redis Cluster for auth session caching instead of in-memory store; update auth service configuration.",
        "target_file": "auth.ts",
        "confidence": 0.92,
    },
    {
        "category": "Bug",
        "topic": "Node.js EventEmitter Memory Leak",
        "summary": "Memory leak identified in socket handler due to unbounded event listener accumulation on reconnect.",
        "decision": "Call removeAllListeners() before re-attaching or switch to the once() pattern in socketHandler.js.",
        "target_file": "socketHandler.js",
        "confidence": 0.95,
    },
    {
        "category": "Performance",
        "topic": "GraphQL N+1 DataLoader Fix",
        "summary": "GraphQL resolver causing N+1 SQL query explosion; DataLoader batching identified as solution.",
        "decision": "Implement DataLoader in resolvers/dataloader.ts with batch size 100 to reduce RDS CPU from 94% to ~30%.",
        "target_file": "dataloader.ts",
        "confidence": 0.91,
    },
    {
        "category": "Security",
        "topic": "JWT Algorithm Validation Vulnerability",
        "summary": "JWT middleware vulnerable to none-algorithm attack due to missing algorithm whitelist.",
        "decision": "Explicitly pass { algorithms: ['RS256'] } to JWT verify() in middleware.ts and rotate signing key immediately.",
        "target_file": "middleware.ts",
        "confidence": 0.97,
    },
    {
        "category": "Architecture",
        "topic": "ML Pipeline Decoupling",
        "summary": "ML inference monolith decided to be split into separate feature engineering and model serving containers.",
        "decision": "Create separate Docker containers for feature_processor.py and model_server.py, connected via Redis queue.",
        "target_file": "model_server.py",
        "confidence": 0.88,
    },
    {
        "category": "Action Item",
        "topic": "CDN CloudFront Static Assets",
        "summary": "Team agreed to deploy CloudFront CDN to reduce TTFB for APAC users by 60-70%.",
        "decision": "Configure CloudFront with S3 origin, set immutable Cache-Control for hashed assets, update next.config.js.",
        "target_file": "next.config.js",
        "confidence": 0.89,
    },
    {
        "category": "Architecture",
        "topic": "Kubernetes HPA Custom Metrics",
        "summary": "HPA misconfigured on CPU metric for I/O-bound service; switch to Prometheus custom metrics recommended.",
        "decision": "Update hpa.yaml to scale on http_requests_in_flight metric (target: 100 concurrent/pod) via Prometheus adapter.",
        "target_file": "hpa.yaml",
        "confidence": 0.87,
    },
    {
        "category": "Architecture",
        "topic": "Event Sourcing Order Management",
        "summary": "Team decided traditional CRUD is insufficient for audit requirements; Event Sourcing pattern adopted.",
        "decision": "Rewrite OrderService using EventStore DB with OrderCreated, OrderPaid, OrderShipped events; update order_service.ts.",
        "target_file": "order_service.ts",
        "confidence": 0.93,
    },
]

_mock_index = 0


def get_next_mock_decision(transcript: str, session_id: str) -> DecisionExtraction:
    """Returns a deterministic mock decision cycling through MOCK_DECISIONS corpus."""
    global _mock_index
    base = MOCK_DECISIONS[_mock_index % len(MOCK_DECISIONS)]
    _mock_index += 1

    return DecisionExtraction(
        id=str(uuid.uuid4()),
        timestamp=datetime.now(timezone.utc).isoformat(),
        category=base["category"],
        topic=base["topic"],
        summary=base["summary"],
        decision=base["decision"],
        target_file=base.get("target_file"),
        confidence=base["confidence"],
        raw_source_preview=transcript[:100],
    )


# ─────────────────────────────────────────────
# AWS Bedrock Client (lazy-loaded)
# ─────────────────────────────────────────────
_bedrock_client = None


def get_bedrock_client():
    """Lazily initializes and returns the boto3 Bedrock runtime client."""
    global _bedrock_client
    if _bedrock_client is None:
        import boto3
        _bedrock_client = boto3.client(
            service_name="bedrock-runtime",
            region_name=AWS_REGION,
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
            aws_session_token=os.getenv("AWS_SESSION_TOKEN"),
        )
        logger.info(f"✓ Bedrock client initialized — model: {BEDROCK_MODEL_ID}, region: {AWS_REGION}")
    return _bedrock_client


def call_bedrock(transcript: str) -> dict:
    """
    Calls AWS Bedrock Claude 3.5 Sonnet with the transcript and returns the parsed JSON dict.
    Raises on any Bedrock or JSON parsing error.
    """
    client = get_bedrock_client()

    request_body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [
            {
                "role": "user",
                "content": f"Extract the technical decision from the following transcript:\n\n<transcript>\n{transcript}\n</transcript>",
            }
        ],
        "system": SYSTEM_PROMPT,
        "temperature": 0.1,
        "top_p": 0.9,
    }

    logger.info(f"Calling Bedrock ({BEDROCK_MODEL_ID}) — transcript length: {len(transcript)} chars")

    response = client.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(request_body),
    )

    response_body = json.loads(response["body"].read())
    raw_text = response_body["content"][0]["text"].strip()

    logger.info(f"Bedrock raw response: {raw_text[:200]}")

    # Strip any accidental markdown code fences
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        raw_text = "\n".join(lines[1:-1]) if len(lines) > 2 else raw_text

    parsed = json.loads(raw_text)
    return parsed


def build_decision_from_bedrock(
    parsed: dict, transcript: str
) -> DecisionExtraction:
    """Validates and constructs a DecisionExtraction from Bedrock-parsed JSON."""
    return DecisionExtraction(
        id=str(uuid.uuid4()),
        timestamp=datetime.now(timezone.utc).isoformat(),
        category=parsed.get("category", "Architecture"),
        topic=parsed.get("topic", "Technical Discussion"),
        summary=parsed.get("summary", ""),
        decision=parsed.get("decision", ""),
        target_file=parsed.get("target_file") or None,
        confidence=float(parsed.get("confidence", 0.85)),
        raw_source_preview=transcript[:100],
    )


# ─────────────────────────────────────────────
# Gateway Broadcast Helper
# ─────────────────────────────────────────────
async def broadcast_to_gateway(decision: DecisionExtraction, session_id: str) -> None:
    """POSTs the structured decision to the Gateway's /internal/broadcast endpoint."""
    payload = {
        "type": "decision",
        "session_id": session_id,
        **decision.model_dump(),
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{GATEWAY_URL}/internal/broadcast",
                json=payload,
            )
            resp.raise_for_status()
            logger.info(
                f"✓ Broadcast successful — {resp.json().get('clients', 0)} VS Code client(s) notified"
            )
    except httpx.RequestError as e:
        logger.error(f"✗ Failed to reach Gateway at {GATEWAY_URL}: {e}")
    except httpx.HTTPStatusError as e:
        logger.error(f"✗ Gateway returned error {e.response.status_code}: {e.response.text}")


# ─────────────────────────────────────────────
# API Routes
# ─────────────────────────────────────────────

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "service": "EchoLog AI Engine",
        "mode": "bedrock" if HAS_AWS_CREDENTIALS else "mock",
        "bedrock_model": BEDROCK_MODEL_ID,
        "aws_region": AWS_REGION,
        "gateway_url": GATEWAY_URL,
    }


@app.post("/process", response_model=ProcessResponse)
async def process_transcript(req: ProcessRequest):
    """
    Main processing endpoint. Accepts a raw transcript, extracts a structured
    technical decision via Bedrock (or fallback mock), and broadcasts to Gateway.
    """
    logger.info(f"Processing transcript (session: {req.session_id}) — {len(req.transcript)} chars")

    mode: Literal["bedrock", "mock"] = "bedrock" if HAS_AWS_CREDENTIALS else "mock"
    decision: DecisionExtraction

    if HAS_AWS_CREDENTIALS:
        try:
            parsed = call_bedrock(req.transcript)
            decision = build_decision_from_bedrock(parsed, req.transcript)
            logger.info(f"✓ Bedrock extraction: [{decision.category}] {decision.topic}")
        except Exception as bedrock_exc:
            logger.warning(
                f"Bedrock call failed ({type(bedrock_exc).__name__}: {bedrock_exc}). "
                f"Falling back to mock mode."
            )
            logger.debug(traceback.format_exc())
            decision = get_next_mock_decision(req.transcript, req.session_id)
            mode = "mock"
    else:
        logger.info("AWS credentials not present — using mock fallback mode")
        decision = get_next_mock_decision(req.transcript, req.session_id)

    # Broadcast to Gateway asynchronously
    await broadcast_to_gateway(decision, req.session_id)

    return ProcessResponse(status="success", decision=decision, mode=mode)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch-all exception handler to prevent unhandled crashes."""
    logger.error(f"Unhandled exception on {request.url}: {exc}")
    logger.debug(traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal server error",
            "detail": str(exc),
            "path": str(request.url),
        },
    )


# ─────────────────────────────────────────────
# Startup / Shutdown Events
# ─────────────────────────────────────────────

@app.on_event("startup")
async def on_startup():
    logger.info("═" * 50)
    logger.info("  EchoLog AI Engine  v1.0.0")
    logger.info("═" * 50)
    logger.info(f"  Mode      : {'🟢 AWS Bedrock (Live)' if HAS_AWS_CREDENTIALS else '🟡 Mock Fallback (No AWS Credentials)'}")
    logger.info(f"  Model     : {BEDROCK_MODEL_ID}")
    logger.info(f"  Region    : {AWS_REGION}")
    logger.info(f"  Gateway   : {GATEWAY_URL}")
    logger.info("═" * 50)
    if not HAS_AWS_CREDENTIALS:
        logger.warning(
            "AWS_ACCESS_KEY_ID not found in environment. "
            "Running in mock mode — all responses use deterministic corpus data. "
            "Add credentials to ai_engine/.env to enable live Bedrock inference."
        )


@app.on_event("shutdown")
async def on_shutdown():
    logger.info("AI Engine shutting down. Goodbye!")
