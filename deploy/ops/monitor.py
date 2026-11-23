#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import socket
import ssl
import sys
import time
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener

from common import CONFIG, IMAGE_ROOT, STATE, Failure, command, configuration, inspect, lock, log, read_json, write_json


LIMITS = {
    "httpTimeoutSeconds": 3, "healthLatencyMs": 1000, "requestP95Ms": 500,
    "minimumRequests": 10, "max5xxPercent": 5, "workerFailureCount": 2,
    "workerMaxAgeSeconds": 180, "loadPerCpu": 2, "cpuPercent": 95,
    "memoryAvailableMiB": 256, "swapUsedMiB": 768, "swapPercent": 80, "diskFreePercent": 15,
    "inodeFreePercent": 10, "backupMaxAgeSeconds": 21600,
    "repositoryCheckMaxAgeSeconds": 108000, "repositoryDataMaxAgeSeconds": 777600, "journalMaxMiB": 85,
    "certificateDays": 14, "alertTimeoutSeconds": 5, "alertCooldownSeconds": 1800,
}
LOCAL = "http://127.0.0.1:3101"
NAMESPACE = "ai-membership-store"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def https_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.fragment):
        raise Failure("HTTPS_REQUIRED")
    return parsed


def opener():
    return build_opener(ProxyHandler({}), NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))


def age(value, now):
    if not value:
        return float("inf")
    return now - dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def fetch_json(http, path, timeout):
    try:
        response = http.open(LOCAL + path, timeout=timeout)
    except HTTPError as error:
        if path != "/api/v1/health" or error.code != 503:
            raise
        response = error
    with response:
        return json.loads(response.read(65537))


def unit_properties(name, properties="ActiveState,Result"):
    output = command(["systemctl", "show", name, "--property=" + properties], "SYSTEMD", timeout=4)
    return dict(line.split("=", 1) for line in output.decode().splitlines())


def unit_failed(name):
    values = unit_properties(name)
    return values["ActiveState"] == "failed" or values["Result"] != "success"


def journal_below_limit(directory, max_mib):
    if not directory.is_dir():
        return False
    size = sum(path.stat().st_blocks * 512 for path in directory.glob("*.journal*"))
    return size < max_mib * 1024 * 1024


def probes(settings, state, prior, now):
    limits = {**LIMITS, **settings.get("thresholds", {})}
    if any(type(limits[key]) not in (int, float) or limits[key] <= 0 for key in LIMITS):
        raise Failure("MONITOR_THRESHOLDS")
    timeout = limits["httpTimeoutSeconds"]
    http = opener()
    active = set()
    sample = {}

    def check(code, callback):
        try:
            if not callback():
                active.add(code)
        except (Failure, OSError, ValueError, TypeError, KeyError, IndexError):
            active.add(code)

    def api_unit():
        values = unit_properties("ai-membership-store.service", "ActiveState,NRestarts,Result")
        sample["restarts"] = int(values["NRestarts"])
        if sample["restarts"] > prior.get("restarts", sample["restarts"]):
            active.add("API_RESTART")
        if values.get("Result") == "oom-kill":
            active.add("OOM")
        return values["ActiveState"] == "active"

    def health():
        start = time.monotonic()
        health = fetch_json(http, "/api/v1/health", timeout)
        if (time.monotonic() - start) * 1000 > limits["healthLatencyMs"]:
            active.add("HEALTH_LATENCY")
        if health.get("database") != "ready":
            active.add("MYSQL_QUERY")
        return health.get("status") == "ok"

    def metrics():
        data = fetch_json(http, "/internal/ops/metrics", timeout)
        requests = data["requests"]
        if requests["count"] >= limits["minimumRequests"]:
            if requests["errors"] * 100 / requests["count"] >= limits["max5xxPercent"]:
                active.add("HTTP_5XX")
            if (requests["p95Ms"] or 0) >= limits["requestP95Ms"]:
                active.add("HTTP_LATENCY")
        for name, code in (("subscriptionExpiry", "SUBSCRIPTIONS"), ("orderTimeout", "ORDERS")):
            worker = data["workers"][name]
            last = worker["secondsSinceLastSuccess"]
            if last is None:
                last = now - data["startedAt"] / 1000
            if last >= limits["workerMaxAgeSeconds"] or worker["consecutiveFailures"] >= limits["workerFailureCount"]:
                active.add("WORKER_" + code)
            if worker["backlog"]:
                active.add("BACKLOG_" + code)
        return True

    def mysql():
        obj = inspect("ai-membership-store-production-mysql-1")
        status = obj["State"]
        sample["mysqlRestarts"] = obj["RestartCount"]
        if sample["mysqlRestarts"] > prior.get("mysqlRestarts", sample["mysqlRestarts"]):
            active.add("MYSQL_RESTART")
        if status.get("OOMKilled"):
            active.add("OOM")
        return status["Running"] and status.get("Health", {}).get("Status") == "healthy"

    def resources():
        mem = {fields[0].rstrip(":"): int(fields[1]) for line in Path("/proc/meminfo").read_text().splitlines()
               if (fields := line.split()) and fields[1].isdecimal()}
        sample["availableMiB"] = mem["MemAvailable"] // 1024
        sample["swapMiB"] = (mem["SwapTotal"] - mem["SwapFree"]) // 1024
        if sample["availableMiB"] < limits["memoryAvailableMiB"]:
            active.add("MEMORY")
        if mem["SwapTotal"] and sample["swapMiB"] >= min(
            limits["swapUsedMiB"], mem["SwapTotal"] * limits["swapPercent"] / 102400
        ):
            active.add("SWAP")
        sample["load"] = round(os.getloadavg()[0], 2)
        if sample["load"] > (os.cpu_count() or 1) * limits["loadPerCpu"]:
            active.add("LOAD")
        cpu = list(map(int, Path("/proc/stat").read_text().splitlines()[0].split()[1:9]))
        busy, total = sum(cpu) - cpu[3] - cpu[4], sum(cpu)
        sample["cpuTicks"] = [busy, total]
        old_busy, old_total = prior.get("cpuTicks", (busy, total))
        if total > old_total and 100 * (busy - old_busy) / (total - old_total) >= limits["cpuPercent"]:
            active.add("CPU")
        return True

    def space(path, code):
        stats = os.statvfs(path)
        if stats.f_bavail * 100 < limits["diskFreePercent"] * stats.f_blocks:
            active.add("DISK_" + code)
        if stats.f_files and stats.f_favail * 100 < limits["inodeFreePercent"] * stats.f_files:
            active.add("INODES_" + code)
        return True

    def backup_status():
        backup = read_json(state / "backup.json", {})
        if backup.get("result") == "failed" or unit_failed("ai-membership-store-backup.service"):
            active.add("BACKUP_FAILED")
        if age(backup.get("lastSuccessAt"), now) >= limits["backupMaxAgeSeconds"]:
            active.add("BACKUP_STALE")
        return True

    def repository_status(unit, filename, max_age):
        if unit_failed(unit):
            return False
        saved = read_json(state / filename, {})
        return saved.get("result") == "success" and age(saved.get("checkedAt"), now) < max_age

    def journal():
        directory = Path("/var/log/journal") / (Path("/etc/machine-id").read_text().strip() + "." + NAMESPACE)
        if not journal_below_limit(directory, limits["journalMaxMiB"]):
            active.add("LOG_STORAGE")
        return True

    def kernel():
        output = command(
            ["journalctl", "-k", "-b", "--since", "2 minutes ago", "--no-pager", "-o", "cat"],
            "KERNEL_JOURNAL", timeout=4,
        )
        if re.search(rb"Out of memory:|oom-kill:|Memory cgroup out of memory", output):
            active.add("OOM")
        return True

    def tls():
        parsed = https_url(settings["publicOrigin"])
        with socket.create_connection((parsed.hostname, parsed.port or 443), timeout=timeout) as tcp:
            with ssl.create_default_context().wrap_socket(tcp, server_hostname=parsed.hostname) as secure:
                expires = ssl.cert_time_to_seconds(secure.getpeercert()["notAfter"])
        return expires - now > limits["certificateDays"] * 86400

    check("API_UNIT", api_unit)
    check("API_HEALTH", health)
    check("API_METRICS", metrics)
    check("MYSQL_CONTAINER", mysql)
    check("SYSTEM_RESOURCES", resources)
    check("DISK_ROOT_PROBE", lambda: space("/", "ROOT"))
    check("DISK_IMAGE_PROBE", lambda: space(IMAGE_ROOT, "IMAGES"))
    check("DISK_DOCKER_PROBE", lambda: space(command(
        ["docker", "info", "--format", "{{.DockerRootDir}}"], "DOCKER_ROOT", timeout=4).decode().strip(), "DOCKER"))
    check("BACKUP_STATUS", backup_status)
    check("REPOSITORY_CHECK", lambda: repository_status(
        "ai-membership-store-repository.service", "repository.json", limits["repositoryCheckMaxAgeSeconds"]))
    check("REPOSITORY_DATA_CHECK", lambda: repository_status(
        "ai-membership-store-repository-data.service", "repository-data.json", limits["repositoryDataMaxAgeSeconds"]))
    check("JOURNAL_PROBE", journal)
    check("KERNEL_PROBE", kernel)
    check("TLS", tls)

    sites = settings.get("existingSites", [])
    if not isinstance(sites, list) or len(sites) > 8:
        raise Failure("SITE_CONFIG")
    def site(url):
        https_url(url)
        with http.open(Request(url, method="GET"), timeout=timeout) as response:
            return 200 <= response.status < 300
    for index, url in enumerate(sites):
        check("EXISTING_SITE_" + str(index + 1), lambda: site(url))
    return active, sample, limits


def notifications(active, previous, now, cooldown, send):
    states = {}
    attempted_this_run = 0
    for code in sorted(active | previous.keys(), key=lambda code: (previous.get(code, {}).get("attemptedAt", 0), code)):
        prior = previous.get(code, {})
        failing = code in active
        if prior.get("observed", False) != failing:
            log("monitor_transition", code=code, status="firing" if failing else "recovered")
        delivered = prior.get("delivered", False)
        sent = prior.get("sentAt", 0)
        attempted = prior.get("attemptedAt", 0)
        changed = prior.get("observed", False) != failing
        due = delivered != failing or (failing and now - sent >= cooldown)
        if due and attempted_this_run < 6 and (changed or now - attempted >= min(cooldown, 300)):
            attempted_this_run += 1
            attempted = now
            if send(code, "firing" if failing else "recovered"):
                delivered, sent = failing, now
        if failing or delivered:
            states[code] = {"observed": failing, "delivered": delivered,
                            "sentAt": sent, "attemptedAt": attempted}
    return states


def webhook(url, timeout):
    def send(code, status):
        if not url:
            return True
        try:
            https_url(url)
            data = json.dumps({"service": NAMESPACE, "code": code, "status": status}).encode()
            request = Request(url, data=data, headers={"Content-Type": "application/json"})
            with opener().open(request, timeout=timeout) as response:
                return 200 <= response.status < 300
        except (Failure, OSError, ValueError) as error:
            if isinstance(error, HTTPError):
                error.close()
            log("webhook_delivery_failed", code=code, status=status)
            return False
    return send


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG)
    args = parser.parse_args()
    os.umask(0o077)
    if os.geteuid() != 0:
        raise Failure("LOCAL_ROOT_OPERATOR_REQUIRED")
    settings = configuration(args.config)
    with lock(STATE, "monitor"):
        file = STATE / "monitor.json"
        previous = read_json(file, {})
        now = time.time()
        active, sample, limits = probes(settings, STATE, previous.get("sample", {}), now)
        states = notifications(active, previous.get("alerts", {}), now, limits["alertCooldownSeconds"],
                               webhook(os.environ.get("ALERT_WEBHOOK_URL"), limits["alertTimeoutSeconds"]))
        write_json(file, {"checkedAt": now, "sample": sample, "alerts": states})
        log("monitor_checked", activeCount=len(active))


if __name__ == "__main__":
    try:
        main()
    except (Failure, OSError, ValueError, TypeError, KeyError) as exc:
        log("monitor_failed", errorCode=str(exc) if isinstance(exc, Failure) else "MONITOR_INTERNAL")
        sys.exit(1)
