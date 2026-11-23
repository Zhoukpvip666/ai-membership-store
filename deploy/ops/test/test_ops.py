import datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import monitor
from common import Failure
from retention import retention_plan


class OperationalTests(unittest.TestCase):
    def test_retention_keeps_complete_groups_and_quarantines_partial_runs(self):
        now = dt.datetime(2026, 11, 23, tzinfo=dt.timezone.utc)
        completed = {"old": now - dt.timedelta(days=31), "new": now, "middle": now - dt.timedelta(hours=1)}
        partial = {"partial": now, "expired": now - dt.timedelta(days=10)}
        keep, expire, aged = retention_plan(completed, partial, {
            "keepHourly": 1, "keepDaily": 0, "keepWeekly": 0, "keepMonthly": 0,
        }, now)
        self.assertEqual(keep, {"new"})
        self.assertEqual(expire, {"old", "middle"})
        self.assertEqual(aged, {"expired"})

    def test_probes_worker_failure_thresholds_backup_and_site_outage(self):
        def proc(args, *_other, **_kwargs):
            if args[0] == "systemctl":
                return b"ActiveState=active\nNRestarts=2\nResult=success\n"
            if args[0] == "docker":
                return b"/\n"
            return b"Out of memory: fixture\n"

        def get(_http, path, _timeout):
            if path == "/api/v1/health":
                return {"database": "unavailable", "status": "degraded"}
            return {
                "startedAt": 1,
                "requests": {"count": 12, "errors": 10, "p95Ms": 5000},
                "workers": {
                    "subscriptionExpiry": {"secondsSinceLastSuccess": None, "consecutiveFailures": 0, "backlog": False},
                    "orderTimeout": {"secondsSinceLastSuccess": 5, "consecutiveFailures": 3, "backlog": True},
                },
            }

        class FailedHTTP:
            def open(self, *_args, **_kwargs):
                raise OSError("T233_FIXTURE_PRIVATE_MARKER")

        with tempfile.TemporaryDirectory() as path, patch.object(monitor, "fetch_json", get), \
                patch.object(monitor, "opener", return_value=FailedHTTP()), \
                patch.object(monitor, "inspect", side_effect=Failure("no database")), \
                patch.object(monitor, "command", proc):
            active, _, _ = monitor.probes({
                "thresholds": {"memoryAvailableMiB": 2**50, "diskFreePercent": 101},
                "publicOrigin": "http://nonhttps.invalid",
                "existingSites": ["https://fixture.invalid"],
            }, Path(path), {"restarts": 1}, time.time())
        self.assertTrue({
            "API_HEALTH", "MYSQL_QUERY", "MYSQL_CONTAINER", "HTTP_5XX", "HTTP_LATENCY",
            "WORKER_SUBSCRIPTIONS", "WORKER_ORDERS", "BACKLOG_ORDERS", "BACKUP_STALE",
            "MEMORY", "DISK_ROOT", "OOM", "API_RESTART", "TLS", "EXISTING_SITE_1",
        }.issubset(active))

    def test_https_webhook_timeout_status_retry_cooldown_recovery(self):
        deliveries = []
        response_status = [503]

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                deliveries.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(response_status[0])
                self.end_headers()

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory() as path:
            cert, key = str(Path(path) / "cert"), str(Path(path) / "key")
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1", "-subj", "/CN=127.0.0.1",
                "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert,
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(cert, key)
                server.socket = context.wrap_socket(server.socket, server_side=True)
                background = threading.Thread(target=server.serve_forever, daemon=True)
                background.start()
                code = {"API_HEALTH"}
                try:
                    with patch.dict(os.environ, {"SSL_CERT_FILE": cert}), patch.object(monitor, "log") as journal:
                        send = monitor.webhook(f"https://127.0.0.1:{server.server_port}/?T233_FIXTURE_PRIVATE_MARKER", 2)
                        status = monitor.notifications(code, {}, 1000, 1800, send)
                        self.assertFalse(status["API_HEALTH"]["delivered"])
                        response_status[0] = 204
                        status = monitor.notifications(code, status, 1060, 1800, send)
                        self.assertEqual(len(deliveries), 1)
                        status = monitor.notifications(code, status, 1300, 1800, send)
                        self.assertTrue(status["API_HEALTH"]["delivered"])
                        status = monitor.notifications(code, status, 1360, 1800, send)
                        self.assertEqual(len(deliveries), 2)
                        self.assertEqual(monitor.notifications(set(), status, 1361, 1800, send), {})
                        self.assertEqual([item["status"] for item in deliveries], ["firing", "firing", "recovered"])
                        self.assertNotIn("T233_FIXTURE_PRIVATE_MARKER", str(journal.call_args_list))
                finally:
                    server.shutdown()
                    background.join()


if __name__ == "__main__":
    unittest.main()
