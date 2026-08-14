import pytest
from fastapi.testclient import TestClient

import chassis_notes_gpu_worker.api as api_module
from chassis_notes_gpu_worker.api import create_app
from chassis_notes_gpu_worker.contracts import JobStatus
from chassis_notes_gpu_worker.jobs import JobManager
from chassis_notes_gpu_worker.settings import WorkerSettings
from tests.conftest import SEGMENT_ID, ArtifactFactory, SubmissionFactory
from tests.test_jobs import _cancel, _Executor, _grant, _Transfers


def test_api_exposes_safe_pull_protocol(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    manager = JobManager(
        worker_settings,
        _Executor(artifact_factory),
        transfers=_Transfers(),
        start_task=lambda task: task(),
        clock=lambda: 1_000.0,
    )
    app = create_app(worker_settings, manager, ready=lambda: True)
    submission = submission_factory()
    body = submission.model_dump(mode="json", by_alias=True)

    with TestClient(app) as client:
        health = client.get("/health")
        submitted = client.post("/v1/jobs", json=body)
        submitted_status = JobStatus.model_validate(submitted.json())
        transferred = client.post(
            f"/v1/jobs/{SEGMENT_ID}/transfer-grants",
            json=_grant(submission, submitted_status).model_dump(
                mode="json", by_alias=True
            ),
        )
        status = client.get(
            f"/v1/jobs/{SEGMENT_ID}",
            params={
                "runId": submission.run_id,
                "attemptId": submission.attempt_id,
                "leaseId": submission.lease_id,
                "fencingToken": submission.fencing_token,
                "specificationDigest": submission.specification_digest,
                "profileDigest": submission.profile_digest,
            },
        )

    assert health.status_code == 200
    assert health.json()["status"] == "ready"
    assert health.json()["capacity"] == "available"
    assert submitted.status_code == 202
    assert submitted.json()["state"] == "transfer-grant-required"
    assert transferred.status_code == 202
    assert transferred.json()["transferRequest"]["role"] == "frame-manifest"
    assert status.status_code == 200
    assert status.json()["segmentId"] == SEGMENT_ID


def test_api_maps_validation_capacity_and_authority_errors_safely(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    manager = JobManager(
        worker_settings,
        _Executor(artifact_factory),
        transfers=_Transfers(),
        start_task=lambda task: task(),
    )
    app = create_app(worker_settings, manager, ready=lambda: False)
    first = submission_factory()
    second = submission_factory(attemptId="77777777-7777-4777-8777-777777777777")

    with TestClient(app) as client:
        unavailable = client.get("/health")
        invalid = client.post("/v1/jobs", json={})
        client.post(
            "/v1/jobs",
            json=first.model_dump(mode="json", by_alias=True),
        )
        busy = client.post(
            "/v1/jobs",
            json=second.model_dump(mode="json", by_alias=True),
        )
        wrong_path = client.post(
            "/v1/jobs/77777777-7777-4777-8777-777777777777/cancel",
            json=_cancel(first).model_dump(mode="json", by_alias=True),
        )
        cancelled = client.post(
            f"/v1/jobs/{SEGMENT_ID}/cancel",
            json=_cancel(first).model_dump(mode="json", by_alias=True),
        )

    assert unavailable.json()["status"] == "unavailable"
    assert invalid.status_code == 422
    assert invalid.json()["error"] == {
        "code": "INVALID_REQUEST",
        "message": "request does not match the execution contract",
    }
    assert busy.status_code == 409
    assert busy.json()["error"]["code"] == "GPU_CAPACITY_BUSY"
    assert wrong_path.status_code == 409
    assert wrong_path.json()["error"]["code"] == "AUTHORITY_MISMATCH"
    assert cancelled.status_code == 202
    assert cancelled.json()["state"] == "cancelled"


def test_api_rejects_wrong_grant_paths_and_maps_profile_and_missing_jobs(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    manager = JobManager(
        worker_settings,
        _Executor(artifact_factory),
        transfers=_Transfers(),
        start_task=lambda task: task(),
        clock=lambda: 1_000.0,
    )
    app = create_app(worker_settings, manager)
    submission = submission_factory()
    status = manager.submit(submission)
    grant = _grant(submission, status)

    with TestClient(app) as client:
        wrong_grant_path = client.post(
            "/v1/jobs/77777777-7777-4777-8777-777777777777/transfer-grants",
            json=grant.model_dump(mode="json", by_alias=True),
        )
        missing_manager = JobManager(
            WorkerSettings(
                state_root=worker_settings.state_root.parent / "missing",
                checkpoint_path=worker_settings.checkpoint_path,
                installed_profile=worker_settings.installed_profile,
            ),
            _Executor(artifact_factory),
            transfers=_Transfers(),
        )
        missing_app = create_app(worker_settings, missing_manager)
        with TestClient(missing_app) as missing_client:
            missing = missing_client.get(
                f"/v1/jobs/{SEGMENT_ID}",
                params={
                    "runId": submission.run_id,
                    "attemptId": submission.attempt_id,
                    "leaseId": submission.lease_id,
                    "fencingToken": submission.fencing_token,
                    "specificationDigest": submission.specification_digest,
                    "profileDigest": submission.profile_digest,
                },
            )
            unavailable = missing_client.post(
                "/v1/jobs",
                json=submission_factory(profileDigest="f" * 64).model_dump(
                    mode="json", by_alias=True
                ),
            )

    assert wrong_grant_path.status_code == 409
    assert wrong_grant_path.json()["error"]["code"] == "AUTHORITY_MISMATCH"
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "JOB_NOT_FOUND"
    assert unavailable.status_code == 503
    assert unavailable.json()["error"]["code"] == "PROFILE_UNAVAILABLE"


class _DefaultExecutor:
    def __init__(self, *_configuration: object) -> None:
        self.ready_calls = 0

    def ready(self) -> bool:
        self.ready_calls += 1
        return False


def test_default_app_composition_and_watchdog_loop(
    worker_settings: WorkerSettings,
    artifact_factory: ArtifactFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = JobManager(
        worker_settings,
        _Executor(artifact_factory),
        transfers=_Transfers(),
        start_task=lambda task: task(),
    )
    executors: list[_DefaultExecutor] = []

    def create_executor(*configuration: object) -> _DefaultExecutor:
        executor = _DefaultExecutor(*configuration)
        executors.append(executor)
        return executor

    monkeypatch.setattr(api_module, "Sam31TrackingExecutor", create_executor)
    monkeypatch.setattr(api_module, "JobManager", lambda *_arguments: manager)

    with TestClient(create_app(worker_settings)) as client:
        health = client.get("/health")

    assert health.json()["status"] == "unavailable"
    assert executors[0].ready_calls == 1

    class Stopped:
        def __init__(self) -> None:
            self.responses = iter((False, True))

        def wait(self, seconds: float) -> bool:
            assert seconds == 1
            return next(self.responses)

    expired: list[bool] = []
    monkeypatch.setattr(manager, "expire_stale", lambda: expired.append(True))
    api_module._watchdog_loop(manager, Stopped())
    assert expired == [True]
