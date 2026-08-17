import json
import os
import threading
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import pytest

import chassis_notes_gpu_worker.jobs as jobs_module
from chassis_notes_gpu_worker.contracts import (
    CancelCommand,
    ExecutionIdentity,
    JobStatus,
    TrackingJobSubmission,
    TransferGrantCommand,
)
from chassis_notes_gpu_worker.executor import (
    ExecutionInput,
    ExecutionOutput,
    TrackingExecutionError,
)
from chassis_notes_gpu_worker.jobs import JobManager, JobRejectedError, _thread_starter
from chassis_notes_gpu_worker.settings import WorkerSettings
from chassis_notes_gpu_worker.transfers import TransferFailureError
from tests.conftest import (
    ATTEMPT_ID,
    MANIFEST_BYTES,
    MEDIA_BYTES,
    OUTPUT_BYTES,
    ArtifactFactory,
    SubmissionFactory,
)


class _Transfers:
    def __init__(self) -> None:
        self.downloaded_urls: list[str] = []
        self.uploaded_urls: list[str] = []
        self.fail_download = False
        self.fail_upload = False

    def download(
        self,
        url: str,
        destination: Path,
        **_bounds: object,
    ) -> None:
        self.downloaded_urls.append(url)
        if self.fail_download:
            raise TransferFailureError
        value = MANIFEST_BYTES if "frames" in destination.name else MEDIA_BYTES
        destination.write_bytes(value)

    def upload(
        self,
        url: str,
        source: Path,
        **_bounds: object,
    ) -> None:
        self.uploaded_urls.append(url)
        if self.fail_upload or source.read_bytes() != OUTPUT_BYTES:
            raise TransferFailureError


class _Executor:
    def __init__(self, artifact_factory: ArtifactFactory) -> None:
        self.artifact_factory = artifact_factory
        self.calls: list[tuple[TrackingJobSubmission, ExecutionInput]] = []
        self.fail = False
        self.fail_unexpectedly = False
        self.cancel_during_execution = False

    def execute(
        self,
        submission: TrackingJobSubmission,
        inputs: ExecutionInput,
        job_root: Path,
        cancelled: threading.Event,
    ) -> ExecutionOutput:
        self.calls.append((submission, inputs))
        if self.cancel_during_execution:
            cancelled.set()
        if self.fail:
            raise TrackingExecutionError
        if self.fail_unexpectedly:
            raise TypeError
        output = job_root / "executor-output.json.gz"
        output.write_bytes(OUTPUT_BYTES)
        return ExecutionOutput(self.artifact_factory(submission), output)


class _Tasks:
    def __init__(self) -> None:
        self.pending: list[Callable[[], None]] = []

    def start(self, task: Callable[[], None]) -> None:
        self.pending.append(task)

    def run_next(self) -> None:
        self.pending.pop(0)()


def _identity(submission: TrackingJobSubmission) -> ExecutionIdentity:
    return ExecutionIdentity(
        runId=submission.run_id,
        segmentId=submission.segment_id,
        attemptId=submission.attempt_id,
        leaseId=submission.lease_id,
        fencingToken=submission.fencing_token,
        specificationDigest=submission.specification_digest,
        profileDigest=submission.profile_digest,
    )


def _cancel(submission: TrackingJobSubmission) -> CancelCommand:
    return CancelCommand(
        contractVersion="tracking-provider.v1",
        runId=submission.run_id,
        segmentId=submission.segment_id,
        attemptId=submission.attempt_id,
        leaseId=submission.lease_id,
        fencingToken=submission.fencing_token,
        specificationDigest=submission.specification_digest,
        profileDigest=submission.profile_digest,
    )


def _grant(
    submission: TrackingJobSubmission,
    status: JobStatus,
    *,
    expires_at: int = 2_000_000_000,
    url: str = "https://r2.example/object?signature=secret",
) -> TransferGrantCommand:
    transfer = status.transfer_request
    assert transfer is not None
    return TransferGrantCommand(
        contractVersion="tracking-provider.v1",
        runId=submission.run_id,
        segmentId=submission.segment_id,
        attemptId=submission.attempt_id,
        leaseId=submission.lease_id,
        fencingToken=submission.fencing_token,
        specificationDigest=submission.specification_digest,
        profileDigest=submission.profile_digest,
        transferRequestId=transfer.transfer_request_id,
        role=transfer.role,
        method=transfer.method,
        url=url,
        expiresAt=expires_at,
    )


def _manager(
    settings: WorkerSettings,
    executor: _Executor,
    transfers: _Transfers,
    *,
    start_task: Callable[[Callable[[], None]], None] = lambda task: task(),
    clock: Callable[[], float] = lambda: 1_000.0,
) -> JobManager:
    return JobManager(
        settings,
        executor,
        transfers=transfers,  # type: ignore[arg-type]
        start_task=start_task,
        clock=clock,
    )


def _advance_to_output_ready(
    manager: JobManager,
    submission: TrackingJobSubmission,
) -> JobStatus:
    first = manager.submit(submission)
    second = manager.deliver_grant(_grant(submission, first))
    return manager.deliver_grant(_grant(submission, second))


def test_full_job_flow_keeps_grants_out_of_journal(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    transfers = _Transfers()
    executor = _Executor(artifact_factory)
    manager = _manager(worker_settings, executor, transfers)

    submitted = manager.submit(submission)
    media_transfer_id = submitted.transfer_request.transfer_request_id  # type: ignore[union-attr]
    after_media = manager.deliver_grant(_grant(submission, submitted))
    manifest_transfer_id = after_media.transfer_request.transfer_request_id  # type: ignore[union-attr]
    output_ready = manager.deliver_grant(_grant(submission, after_media))
    output_transfer_id = output_ready.transfer_request.transfer_request_id  # type: ignore[union-attr]
    completed = manager.deliver_grant(_grant(submission, output_ready))

    assert completed.state == "completed"
    assert completed.progress == 99
    assert completed.artifact == artifact_factory(submission)
    assert manager.capacity == "available"
    assert len(executor.calls) == 1
    assert transfers.downloaded_urls == [
        "https://r2.example/object?signature=secret",
        "https://r2.example/object?signature=secret",
    ]
    assert transfers.uploaded_urls == ["https://r2.example/object?signature=secret"]
    journal_text = (worker_settings.state_root / "execution-state.json").read_text()
    assert "signature=secret" not in journal_text
    journal = json.loads(journal_text)
    assert journal["completedTransferIds"] == [
        media_transfer_id,
        manifest_transfer_id,
        output_transfer_id,
    ]


def test_submit_is_idempotent_but_rejects_mutated_or_competing_work(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    submission = submission_factory()

    first = manager.submit(submission)
    duplicate = manager.submit(submission)

    assert duplicate.transfer_request == first.transfer_request
    mutated_body = submission.model_dump(mode="json", by_alias=True)
    mutated_body["trackingRequest"]["subjectSeed"]["identity"] = "other"  # type: ignore[index]
    mutated = TrackingJobSubmission.model_validate(mutated_body)
    with pytest.raises(JobRejectedError) as mismatch:
        manager.submit(mutated)
    assert mismatch.value.error.code == "AUTHORITY_MISMATCH"

    competing = submission_factory(attemptId="77777777-7777-4777-8777-777777777777")
    with pytest.raises(JobRejectedError) as busy:
        manager.submit(competing)
    assert busy.value.error.code == "GPU_CAPACITY_BUSY"


def test_submit_rejects_an_uninstalled_profile(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    submission = submission_factory(profileDigest="f" * 64)

    with pytest.raises(JobRejectedError) as rejected:
        manager.submit(submission)

    assert rejected.value.error.code == "PROFILE_UNAVAILABLE"


def test_status_requires_every_authority_field(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    with pytest.raises(JobRejectedError) as missing:
        manager.status(_identity(submission))
    assert missing.value.error.code == "JOB_NOT_FOUND"

    manager.submit(submission)
    stale = _identity(submission).model_copy(update={"fencing_token": 8})
    with pytest.raises(JobRejectedError) as mismatch:
        manager.status(stale)
    assert mismatch.value.error.code == "AUTHORITY_MISMATCH"


def test_grants_are_idempotent_and_reject_mismatch_or_expiry(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
        clock=lambda: 1_000.0,
    )
    status = manager.submit(submission)
    grant = _grant(submission, status)
    advanced = manager.deliver_grant(grant)

    duplicate = manager.deliver_grant(grant)
    assert duplicate.transfer_request == advanced.transfer_request

    wrong = _grant(submission, advanced).model_copy(
        update={"transfer_request_id": "99999999-9999-4999-8999-999999999999"}
    )
    with pytest.raises(JobRejectedError) as mismatch:
        manager.deliver_grant(wrong)
    assert mismatch.value.error.code == "AUTHORITY_MISMATCH"

    with pytest.raises(JobRejectedError) as expired:
        manager.deliver_grant(_grant(submission, advanced, expires_at=1_000))
    assert expired.value.error.code == "TRANSFER_FAILED"

    journal = manager._journal
    assert journal is not None
    manager._journal = journal.model_copy(update={"state": "processing"})
    with pytest.raises(JobRejectedError) as invalid_state:
        manager.deliver_grant(_grant(submission, advanced))
    assert invalid_state.value.error.code == "AUTHORITY_MISMATCH"


def test_duplicate_grant_while_transfer_is_running_does_not_duplicate_work(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    tasks = _Tasks()
    transfers = _Transfers()
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        transfers,
        start_task=tasks.start,
    )
    status = manager.submit(submission)
    grant = _grant(submission, status)

    transferring = manager.deliver_grant(grant)
    duplicate = manager.deliver_grant(grant)

    assert transferring.state == "transferring"
    assert duplicate.state == "transferring"
    assert len(tasks.pending) == 1
    tasks.run_next()
    assert len(transfers.downloaded_urls) == 1


@pytest.mark.parametrize("failure_stage", ["download", "upload"])
def test_failed_transfer_keeps_the_same_request_for_reissue(
    failure_stage: str,
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    transfers = _Transfers()
    executor = _Executor(artifact_factory)
    manager = _manager(worker_settings, executor, transfers)
    status = manager.submit(submission)
    if failure_stage == "upload":
        status = manager.deliver_grant(_grant(submission, status))
        status = manager.deliver_grant(_grant(submission, status))
        transfers.fail_upload = True
    else:
        transfers.fail_download = True
    assert status.transfer_request is not None
    transfer_id = status.transfer_request.transfer_request_id

    failed = manager.deliver_grant(_grant(submission, status))

    assert failed.error is not None
    assert failed.error.code == "TRANSFER_FAILED"
    assert failed.transfer_request is not None
    assert failed.transfer_request.transfer_request_id == transfer_id
    assert failed.state == (
        "output-ready" if failure_stage == "upload" else "transfer-grant-required"
    )


def test_cancellation_is_idempotent_and_releases_nonrunning_job(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    manager.submit(submission)

    cancelled = manager.cancel(_cancel(submission))
    duplicate = manager.cancel(_cancel(submission))

    assert cancelled.state == "cancelled"
    assert duplicate.state == "cancelled"
    assert manager.capacity == "available"


def test_cancellation_waits_for_running_transfer_to_exit(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    tasks = _Tasks()
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
        start_task=tasks.start,
    )
    status = manager.submit(submission)
    manager.deliver_grant(_grant(submission, status))

    requested = manager.cancel(_cancel(submission))
    assert requested.state == "cancel-requested"
    assert manager.capacity == "busy"

    tasks.run_next()
    assert manager.status(_identity(submission)).state == "cancelled"
    assert manager.capacity == "available"


def test_failed_transfer_finishes_a_pending_cancellation(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    tasks = _Tasks()
    transfers = _Transfers()
    transfers.fail_download = True
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        transfers,
        start_task=tasks.start,
    )
    status = manager.submit(submission)
    manager.deliver_grant(_grant(submission, status))
    manager.cancel(_cancel(submission))

    tasks.run_next()

    assert manager.status(_identity(submission)).state == "cancelled"
    assert manager.capacity == "available"


def test_watchdog_interrupts_only_stale_active_work(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    now = [100.0]
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
        clock=lambda: now[0],
    )
    assert manager.expire_stale() is False
    manager.submit(submission)
    now[0] = 105.0
    assert manager.expire_stale() is False
    now[0] = 111.0

    assert manager.expire_stale() is True
    interrupted = manager.status(_identity(submission))
    assert interrupted.state == "interrupted"
    assert interrupted.error is not None
    assert interrupted.error.code == "JOB_INTERRUPTED"
    assert manager.expire_stale() is False


def test_execution_failure_and_cooperative_abort_release_capacity(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    for index, failure in enumerate(("failed", "cancelled")):
        settings = replace(
            worker_settings,
            state_root=worker_settings.state_root.parent / f"failure-{index}",
        )
        submission = submission_factory(
            attemptId=(
                ATTEMPT_ID
                if failure == "failed"
                else "77777777-7777-4777-8777-777777777777"
            )
        )
        executor = _Executor(artifact_factory)
        executor.fail = failure == "failed"
        executor.cancel_during_execution = failure == "cancelled"
        manager = _manager(settings, executor, _Transfers())
        first = manager.submit(submission)
        second = manager.deliver_grant(_grant(submission, first))

        result = manager.deliver_grant(_grant(submission, second))

        assert result.state == failure
        assert manager.capacity == "available"
        if failure == "failed":
            assert manager.cancel(_cancel(submission)).state == "failed"


def test_execution_failure_after_cancellation_finishes_cancelled(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    executor = _Executor(artifact_factory)
    executor.cancel_during_execution = True
    executor.fail = True
    manager = _manager(worker_settings, executor, _Transfers())
    first = manager.submit(submission)
    second = manager.deliver_grant(_grant(submission, first))

    result = manager.deliver_grant(_grant(submission, second))

    assert result.state == "cancelled"
    assert manager.capacity == "available"


def test_unexpected_execution_failure_fails_safely_and_releases_capacity(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    executor = _Executor(artifact_factory)
    executor.fail_unexpectedly = True
    manager = _manager(worker_settings, executor, _Transfers())
    first = manager.submit(submission)
    second = manager.deliver_grant(_grant(submission, first))

    result = manager.deliver_grant(_grant(submission, second))

    assert result.state == "failed"
    assert result.error is not None
    assert result.error.code == "TRACKING_FAILED"
    assert manager.capacity == "available"


def test_invalid_executor_output_fails_safely(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    settings = replace(worker_settings, max_output_bytes=1)
    submission = submission_factory()
    manager = _manager(
        settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    first = manager.submit(submission)
    second = manager.deliver_grant(_grant(submission, first))

    result = manager.deliver_grant(_grant(submission, second))

    assert result.state == "failed"
    assert result.error is not None
    assert result.error.code == "TRACKING_FAILED"


def test_restart_interrupts_unfinished_work_and_recovers_output_ready(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    manager.submit(submission)

    restarted = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    assert restarted.status(_identity(submission)).state == "interrupted"
    assert restarted.cancel(_cancel(submission)).state == "interrupted"

    fresh_settings = WorkerSettings(
        state_root=worker_settings.state_root.parent / "output-ready",
        checkpoint_path=worker_settings.checkpoint_path,
        installed_profile=worker_settings.installed_profile,
        max_input_bytes=1024,
        max_output_bytes=1024,
    )
    ready_manager = _manager(
        fresh_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    ready = _advance_to_output_ready(ready_manager, submission)
    assert ready.state == "output-ready"

    recovered = _manager(
        fresh_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    assert recovered.status(_identity(submission)).state == "output-ready"
    assert recovered.capacity == "busy"


def test_restart_rejects_corrupt_journal_and_invalid_output(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    worker_settings.prepare_root()
    journal = worker_settings.state_root / "execution-state.json"
    journal.write_text("not-json")
    with pytest.raises(ValueError, match="GPU execution journal is invalid"):
        _manager(
            worker_settings,
            _Executor(artifact_factory),
            _Transfers(),
        )

    journal.unlink()
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    _advance_to_output_ready(manager, submission)
    output = worker_settings.state_root / "jobs" / ATTEMPT_ID / "observations.json.gz"
    output.write_bytes(b"corrupt")

    restarted = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    assert restarted.status(_identity(submission)).state == "interrupted"


@pytest.mark.parametrize("recovery_failure", ["missing-artifact", "missing-output"])
def test_restart_interrupts_incomplete_output_ready_state(
    recovery_failure: str,
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    settings = replace(
        worker_settings,
        state_root=worker_settings.state_root.parent / recovery_failure,
    )
    submission = submission_factory()
    manager = _manager(settings, _Executor(artifact_factory), _Transfers())
    _advance_to_output_ready(manager, submission)
    if recovery_failure == "missing-artifact":
        journal_path = settings.state_root / "execution-state.json"
        journal = json.loads(journal_path.read_text())
        journal["artifact"] = None
        journal_path.write_text(json.dumps(journal))
    else:
        (settings.state_root / "jobs" / ATTEMPT_ID / "observations.json.gz").unlink()

    restarted = _manager(settings, _Executor(artifact_factory), _Transfers())

    assert restarted.status(_identity(submission)).state == "interrupted"


def test_output_transfer_without_an_artifact_fails_safely(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    manager.submit(submission)

    manager._transfer(
        "https://r2.example/output",
        "observation-artifact",
        "99999999-9999-4999-8999-999999999999",
    )

    status = manager.status(_identity(submission))
    assert status.state == "transfer-grant-required"
    assert status.error is not None
    assert status.error.code == "TRANSFER_FAILED"


def test_persistence_rejects_a_zero_progress_write(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    monkeypatch.setattr(jobs_module.os, "write", lambda *_arguments: 0)

    with pytest.raises(OSError, match=r"^$"):
        manager.submit(submission_factory())


def test_default_task_starter_runs_in_a_daemon_thread() -> None:
    completed = threading.Event()

    _thread_starter(completed.set)

    assert completed.wait(1)


def test_completed_job_is_idempotently_reportable_after_restart(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    ready = _advance_to_output_ready(manager, submission)
    manager.deliver_grant(_grant(submission, ready))

    restarted = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    assert restarted.status(_identity(submission)).state == "completed"
    assert restarted.cancel(_cancel(submission)).state == "completed"


def test_terminal_timestamp_is_persisted_and_old_terminal_workspace_is_pruned(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    now = [1_000.0]
    settings = replace(worker_settings, retention_seconds=10)
    submission = submission_factory()
    manager = _manager(
        settings,
        _Executor(artifact_factory),
        _Transfers(),
        clock=lambda: now[0],
    )
    ready = _advance_to_output_ready(manager, submission)
    manager.deliver_grant(_grant(submission, ready))

    journal = json.loads((settings.state_root / "execution-state.json").read_text())
    assert journal["terminalAt"] == 1_000.0
    assert (settings.state_root / "jobs" / ATTEMPT_ID).exists()
    os.utime(settings.state_root / "jobs" / ATTEMPT_ID, (0, 0))

    now[0] = 1_011.0
    assert manager.cleanup_expired() == 1
    assert not (settings.state_root / "jobs" / ATTEMPT_ID).exists()


def test_cleanup_protects_active_and_output_ready_workspaces(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    now = [1_000.0]
    settings = replace(worker_settings, retention_seconds=10)
    submission = submission_factory()
    manager = _manager(
        settings,
        _Executor(artifact_factory),
        _Transfers(),
        clock=lambda: now[0],
    )
    manager.submit(submission)
    job_root = settings.state_root / "jobs" / ATTEMPT_ID
    job_root.mkdir(parents=True, exist_ok=True)
    now[0] = 1_011.0
    assert manager.cleanup_expired() == 0
    assert job_root.exists()

    ready = _advance_to_output_ready(
        _manager(
            replace(settings, state_root=settings.state_root.parent / "ready"),
            _Executor(artifact_factory),
            _Transfers(),
            clock=lambda: now[0],
        ),
        submission_factory(attemptId="77777777-7777-4777-8777-777777777777"),
    )
    assert ready.state == "output-ready"


def test_cleanup_interrupts_and_prunes_expired_output_ready_workspace(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    now = [1_000.0]
    settings = replace(worker_settings, retention_seconds=10)
    submission = submission_factory()
    manager = _manager(
        settings,
        _Executor(artifact_factory),
        _Transfers(),
        clock=lambda: now[0],
    )
    ready = _advance_to_output_ready(manager, submission)
    assert ready.state == "output-ready"
    os.utime(settings.state_root / "jobs" / ATTEMPT_ID, (0, 0))

    now[0] = 1_011.0
    assert manager.cleanup_expired() == 1
    assert manager.status(_identity(submission)).state == "interrupted"
    assert not (settings.state_root / "jobs" / ATTEMPT_ID).exists()


def test_terminal_journal_without_timestamp_is_backfilled_on_restart(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    manager = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    ready = _advance_to_output_ready(manager, submission)
    manager.deliver_grant(_grant(submission, ready))
    journal_path = worker_settings.state_root / "execution-state.json"
    journal = json.loads(journal_path.read_text())
    journal.pop("terminalAt")
    journal_path.write_text(json.dumps(journal))

    restarted = _manager(
        worker_settings,
        _Executor(artifact_factory),
        _Transfers(),
    )
    assert restarted._journal is not None
    assert restarted._journal.terminal_at is not None


def test_terminal_timestamp_falls_back_to_clock_when_journal_stat_fails(
    worker_settings: WorkerSettings,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    submission = submission_factory()
    manager = _manager(worker_settings, _Executor(artifact_factory), _Transfers())
    ready = _advance_to_output_ready(manager, submission)
    manager.deliver_grant(_grant(submission, ready))
    journal_path = worker_settings.state_root / "execution-state.json"
    journal = json.loads(journal_path.read_text())
    journal.pop("terminalAt")
    journal_path.write_text(json.dumps(journal))
    original_stat = jobs_module.Path.stat
    stat_calls = 0

    def fail_journal_stat(
        path: Path, *args: object, **kwargs: object
    ) -> os.stat_result:
        nonlocal stat_calls
        if path == journal_path:
            stat_calls += 1
        if path == journal_path and stat_calls > 1:
            error = "unavailable"
            raise OSError(error)
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(jobs_module.Path, "stat", fail_journal_stat)
    restarted = _manager(worker_settings, _Executor(artifact_factory), _Transfers())
    assert restarted._journal is not None
    assert restarted._journal.terminal_at is not None


def test_cleanup_skips_a_workspace_that_disappears_during_removal(
    worker_settings: WorkerSettings,
    artifact_factory: ArtifactFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = replace(worker_settings, retention_seconds=1)
    manager = _manager(settings, _Executor(artifact_factory), _Transfers())
    stale = settings.state_root / "jobs" / "stale"
    stale.mkdir(parents=True)
    os.utime(stale, (0, 0))
    (settings.state_root / "jobs" / "fresh").mkdir()
    original_rmtree = jobs_module.shutil.rmtree

    def disappear(path: Path) -> None:
        if path == stale:
            error = "gone"
            raise OSError(error)
        original_rmtree(path)

    monkeypatch.setattr(jobs_module.shutil, "rmtree", disappear)
    assert manager.cleanup_expired() == 0


def test_safe_event_without_job_context_is_still_structured(
    worker_settings: WorkerSettings,
    artifact_factory: ArtifactFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO")
    manager = _manager(worker_settings, _Executor(artifact_factory), _Transfers())
    manager._log_event("host-started")
    assert '"event":"host-started"' in caplog.text
