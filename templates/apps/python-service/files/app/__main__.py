"""Entrypoint: python -m app (listens on PORT, default 8080)."""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",  # nosec B104 - the container must accept traffic from its Service
        port=int(os.getenv("PORT", "8080")),
        access_log=False,
        server_header=False,
        timeout_graceful_shutdown=20,
    )
