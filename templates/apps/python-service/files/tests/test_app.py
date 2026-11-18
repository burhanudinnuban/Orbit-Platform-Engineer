import json
import re

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app(service_name="test-service"))


def test_index_describes_the_service(client: TestClient) -> None:
    res = client.get("/")
    assert res.status_code == 200
    assert res.json()["service"] == "test-service"


def test_health_and_readiness(client: TestClient) -> None:
    assert client.get("/healthz").status_code == 200
    assert client.get("/readyz").status_code == 200


def test_security_headers(client: TestClient) -> None:
    headers = client.get("/").headers
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["x-frame-options"] == "DENY"
    assert "default-src 'none'" in headers["content-security-policy"]
    assert headers["cache-control"] == "no-store"


def test_unknown_path_is_404(client: TestClient) -> None:
    res = client.get("/no-such-page")
    assert res.status_code == 404
    assert json.loads(res.text) == {"detail": "Not Found"}


def test_metrics_are_labeled_by_route_not_raw_url(client: TestClient) -> None:
    client.get("/")
    client.get("/unknown-path-12345")
    body = client.get("/metrics").text
    assert re.search(r'http_requests_total\{method="GET",route="/",status="200"\} \d', body)
    assert re.search(r'http_request_duration_seconds_bucket\{le="[^"]+",method="GET",route="/",status="200"\}', body) or re.search(
        r'http_request_duration_seconds_bucket\{method="GET",route="/",status="200",le="[^"]+"\}', body
    )
    assert 'route="unmatched",status="404"' in body
    assert "unknown-path-12345" not in body
    assert "process_cpu_seconds_total" in body or "python_info" in body
