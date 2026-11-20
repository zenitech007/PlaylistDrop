from __future__ import annotations

import math
import time
import uuid
from collections import defaultdict, deque
from typing import Awaitable, Callable

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.logging_config import get_logger, request_id_ctx
from app.schemas import ErrorDetail, ErrorEnvelope

logger = get_logger(__name__)


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Attaches a unique X-Request-ID header and emits structured access logs."""

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        req_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        token = request_id_ctx.set(req_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            response.headers["X-Request-ID"] = req_id
            logger.info(
                "http_request",
                method=request.method,
                path=request.url.path,
                status_code=response.status_code,
                duration_ms=elapsed_ms,
                client_ip=_extract_client_ip(request),
            )
            return response
        finally:
            request_id_ctx.reset(token)


class InMemoryRateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window per-IP rate limiter (default 30 req/min across all API routes)."""

    def __init__(
        self,
        app: ASGIApp,
        max_requests: int = 30,
        window_seconds: float = 60.0,
    ) -> None:
        super().__init__(app)
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._buckets: dict[str, deque[float]] = defaultdict(deque)

    def reset(self) -> None:
        self._buckets.clear()

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.method == "OPTIONS" or request.url.path == "/health":
            return await call_next(request)

        client_ip = _extract_client_ip(request)
        now = time.monotonic()
        cutoff = now - self.window_seconds
        bucket = self._buckets[client_ip]

        while bucket and bucket[0] <= cutoff:
            bucket.popleft()

        if len(bucket) >= self.max_requests:
            retry_after = max(1, math.ceil(self.window_seconds - (now - bucket[0])))
            payload = ErrorEnvelope(
                error=ErrorDetail(
                    code="RATE_LIMITED",
                    message=(
                        f"Rate limit exceeded ({self.max_requests} requests/minute). "
                        f"Please retry in {retry_after} seconds."
                    ),
                )
            )
            return JSONResponse(
                status_code=429,
                content=payload.model_dump(),
                headers={"Retry-After": str(retry_after)},
            )

        bucket.append(now)
        return await call_next(request)


def _extract_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        first_ip = forwarded.split(",")[0].strip()
        if first_ip:
            return first_ip
    if request.client and request.client.host:
        return request.client.host
    return "unknown"
