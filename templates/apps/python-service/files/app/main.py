"""HTTP service built from the Orbit python-service template."""

import os
import time

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    GCCollector,
    Histogram,
    PlatformCollector,
    ProcessCollector,
    generate_latest,
)

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
}

LATENCY_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10)


def create_app(service_name: str | None = None) -> FastAPI:
    """Build the app. Every instance gets its own metrics registry, so tests can create many."""
    service_name = service_name or os.getenv("ORBIT_APP", "{{APP_NAME}}")
    registry = CollectorRegistry()
    ProcessCollector(registry=registry)
    PlatformCollector(registry=registry)
    GCCollector(registry=registry)

    http_requests = Counter(
        "http_requests",
        "HTTP requests handled, by method, matched route and status code",
        ["method", "route", "status"],
        registry=registry,
    )
    http_duration = Histogram(
        "http_request_duration_seconds",
        "HTTP request latency in seconds, by method, matched route and status code",
        ["method", "route", "status"],
        buckets=LATENCY_BUCKETS,
        registry=registry,
    )

    # The interactive docs pages need scripts from a CDN, which the strict CSP blocks.
    app = FastAPI(title=service_name, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.ready = True

    @app.middleware("http")
    async def observe(request: Request, call_next):
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers.update(SECURITY_HEADERS)
            return response
        finally:
            # Label by the matched route pattern (e.g. /items/{item_id}), never the raw URL.
            route = getattr(request.scope.get("route"), "path", None) or "unmatched"
            labels = {"method": request.method, "route": route, "status": str(status)}
            http_requests.labels(**labels).inc()
            http_duration.labels(**labels).observe(time.perf_counter() - start)

    @app.get("/")
    def index() -> dict:
        return {"service": service_name, "status": "ok", "environment": os.getenv("ORBIT_ENV", "local")}

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> Response:
        if app.state.ready:
            return JSONResponse({"status": "ready"})
        return JSONResponse({"status": "shutting-down"}, status_code=503)

    @app.get("/metrics")
    def metrics() -> Response:
        return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)

    return app


app = create_app()
