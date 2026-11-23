import datetime as dt

from common import Failure, log, utc, write_json


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise Failure("REPOSITORY_TIME_INVALID")
    return parsed.astimezone(dt.timezone.utc)


def retention_plan(completed, partial, settings, now):
    # Select the newest complete run in each of the last N populated UTC
    # windows. An incomplete run never takes a retention slot.
    recent = sorted(completed, key=completed.get, reverse=True)
    windows = (
        ("keepHourly", 24, lambda at: (at.date(), at.hour)),
        ("keepDaily", 14, lambda at: at.date()),
        ("keepWeekly", 8, lambda at: at.isocalendar()[:2]),
        ("keepMonthly", 12, lambda at: (at.year, at.month)),
    )
    retain = set(recent[:1])
    for name, fallback, window in windows:
        budget = settings.get(name, fallback)
        if type(budget) is not int or budget < 0:
            raise Failure("RETENTION_CONFIG")
        populated = set()
        for run in recent:
            if len(populated) >= budget:
                break
            slot = window(completed[run])
            if slot not in populated:
                retain.add(run)
                populated.add(slot)
    grace = settings.get("incompleteDays", 7)
    if type(grace) is not int or grace < 1:
        raise Failure("RETENTION_CONFIG")
    aged = {run for run, at in partial.items() if now - at > dt.timedelta(days=grace)}
    return retain, set(completed) - retain, aged


def maintain(repo, settings, state, operation):
    from backup import groups, load_manifest

    args = ["check"] + (["--read-data"] if operation == "check-data" else [])
    check = operation in {"check", "check-data"}
    status_file = state / ("repository-data.json" if operation == "check-data" else "repository.json")
    try:
        repo.call(*args, error="REPOSITORY_CHECK_FAILED")
        snapshots = groups(repo)
        completed, partial = {}, {}
        for run, parts in snapshots.items():
            if "manifest" in parts:
                meta = load_manifest(repo, run, parts)
                completed[run] = timestamp(meta["completedAt"])
            else:
                partial[run] = max(timestamp(entry["time"]) for entry in parts.values())
        if not completed:
            raise Failure("NO_COMPLETE_BACKUP")
    except (Failure, ValueError, KeyError, TypeError) as exc:
        if check:
            write_json(status_file, {"checkedAt": utc(), "result": "failed"})
        if isinstance(exc, Failure):
            raise
        raise Failure("REPOSITORY_METADATA_INVALID") from None

    if check:
        write_json(status_file, {"checkedAt": utc(), "result": "success",
                                  "completeRuns": len(completed), "partialRuns": len(partial)})
        log("repository_checked", completeRuns=len(completed), partialRuns=len(partial), full=operation == "check-data")
        return
    if operation in {"plan-prune", "prune"}:
        repo.call("prune", *(["--dry-run"] if operation == "plan-prune" else []),
                  error="REPOSITORY_PRUNE_FAILED")
        log("repository_prune", dryRun=operation == "plan-prune")
        return

    preserve, expired, aged = retention_plan(completed, partial, settings, timestamp(utc()))
    remove = expired | aged
    if operation == "apply-retention":
        for run in sorted(remove):
            parts = snapshots[run]
            # Forget the marker first. An interrupted operation leaves an
            # incomplete group, never a manifest referencing deleted data.
            if "manifest" in parts:
                repo.call("forget", parts["manifest"]["id"], error="REPOSITORY_FORGET_FAILED")
            repo.call("forget", *(entry["id"] for part, entry in parts.items() if part != "manifest"),
                      error="REPOSITORY_FORGET_FAILED")
    elif remove:
        repo.call("forget", "--dry-run", *(entry["id"] for run in sorted(remove)
                  for entry in snapshots[run].values()), error="REPOSITORY_FORGET_PLAN_FAILED")
    log("repository_retention", dryRun=operation == "plan-retention",
        preserve=sorted(preserve), removeComplete=sorted(expired), removeIncomplete=sorted(aged))
