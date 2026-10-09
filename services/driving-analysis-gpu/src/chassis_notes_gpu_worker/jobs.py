import hashlib
import json
import logging
import os
import shutil
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from driving_analysis_service.contracts import StrictContract, UuidV4String
from pydantic import Field, ValidationError

from chassis_notes_gpu_worker.contracts import (
    CancelCommand,
    ExecutionIdentity,
    JobState,
    JobStatus,
    OutputArtifact,
    SafeJobError,
    TrackingJobSubmission,
    TransferGrantCommand,
    TransferRequest,
    TransferRole,
)
from chassis_notes_gpu_worker.executor import (
    ExecutionInput,
    ExecutionOutput,
    TrackingExecutionError,
    TrackingExecutor,
)
from chassis_notes_gpu_worker.settings import WorkerSettings
from chassis_notes_gpu_worker.transfers import TransferClient, TransferFailureError

TaskStarter = Callable[[Callable[[], None]], None]
Clock = Callable[[], float]
logger = logging.getLogger(__name__)

TERMINAL_STATES: frozenset[JobState] = frozenset(
    {"completed", "cancelled", "interrupted", "failed"}
)


class JobRejectedError(RuntimeError):
    def __init__(self, error: SafeJobError) -> None:
        super().__init__(error.code)
        self.error = error


class _Journal(StrictContract):
    submission: TrackingJobSubmission
    state: JobState
    progress: int = Field(ge=0, le=99, strict=True)
    transfer_request: TransferRequest | None = Field(
        default=None, alias="transferRequest"
    )
    completed_transfer_ids: tuple[UuidV4String, ...] = Field(
        default=(), alias="completedTransferIds", strict=False
    )
    artifact: OutputArtifact | None = None
    error: SafeJobError | None = None
    last_control_at: float = Field(alias="lastControlAt", ge=0, strict=True)
    terminal_at: float | None = Field(
        default=None, alias="terminalAt", ge=0, strict=True
    )
    output_ready_at: float | None = Field(
        default=None, alias="outputReadyAt", ge=0, strict=True
    )


def _thread_starter(task: Callable[[], None]) -> None:
    threading.Thread(target=task, daemon=True).start()


class JobManager:
    def __init__(
        self,
        settings: WorkerSettings,
        executor: TrackingExecutor,
        *,
        transfers: TransferClient | None = None,
        start_task: TaskStarter = _thread_starter,
        clock: Clock = time.time,
    ) -> None:
        self.settings = settings
        self.executor = executor
        self.transfers = transfers or TransferClient()
        self._start_task = start_task
        self._clock = clock
        self._lock = threading.RLock()
        self._cancelled = threading.Event()
        self._worker_running = False
        self._physical_busy = False
        self._journal: _Journal | None = None
        self.settings.prepare_root()
        self._restore()
        self.cleanup_expired()

    @property
    def capacity(self) -> Literal["available", "busy"]:
        with self._lock:
            return "busy" if self._physical_busy else "available"

    def submit(self, submission: TrackingJobSubmission) -> JobStatus:
        with self._lock:
            if submission.profile_digest != self.settings.installed_profile.digest:
                raise JobRejectedError(_safe_error("PROFILE_UNAVAILABLE"))
            if self._journal is not None and self._same_identity(
                submission, self._journal.submission
            ):
                if submission != self._journal.submission:
                    raise JobRejectedError(_safe_error("AUTHORITY_MISMATCH"))
                self._touch()
                return self._status()
            if self._physical_busy or (
                self._journal is not None and self._journal.state not in TERMINAL_STATES
            ):
                raise JobRejectedError(_safe_error("GPU_CAPACITY_BUSY"))
            self._cancelled = threading.Event()
            self._physical_busy = True
            self._journal = _Journal(
                submission=submission,
                state="transfer-grant-required",
                progress=0,
                transferRequest=_transfer_request("prepared-media"),
                lastControlAt=self._clock(),
            )
            self._persist()
            self._log_event("job-submitted", capacity="busy")
            return self._status()

    def status(self, identity: ExecutionIdentity) -> JobStatus:
        with self._lock:
            self._require_identity(identity)
            self._touch()
            return self._status()

    def deliver_grant(self, command: TransferGrantCommand) -> JobStatus:
        with self._lock:
            journal = self._require_identity(command)
            if command.transfer_request_id in journal.completed_transfer_ids:
                self._touch()
                return self._status()
            requested = journal.transfer_request
            if (
                requested is None
                or requested.transfer_request_id != command.transfer_request_id
                or requested.role != command.role
                or requested.method != command.method
            ):
                raise JobRejectedError(_safe_error("AUTHORITY_MISMATCH"))
            if command.expires_at <= int(self._clock()):
                raise JobRejectedError(_safe_error("TRANSFER_FAILED"))
            if journal.state == "transferring":
                self._touch()
                return self._status()
            if journal.state not in {"transfer-grant-required", "output-ready"}:
                raise JobRejectedError(_safe_error("AUTHORITY_MISMATCH"))
            self._journal = journal.model_copy(
                update={"state": "transferring", "error": None}
            )
            self._worker_running = True
            self._touch()
            url = command.url
            role = command.role
        self._start_task(lambda: self._transfer(url, role, command.transfer_request_id))
        return self.status(command)

    def cancel(self, command: CancelCommand) -> JobStatus:
        with self._lock:
            journal = self._require_identity(command)
            self._touch()
            if journal.state in {"cancelled", "completed"}:
                return self._status()
            if journal.state in {"interrupted", "failed"}:
                return self._status()
            self._cancelled.set()
            state: JobState = (
                "cancel-requested" if self._worker_running else "cancelled"
            )
            self._physical_busy = self._worker_running
            self._journal = journal.model_copy(
                update={
                    "state": state,
                    "transfer_request": None,
                    "error": None,
                    "terminal_at": self._clock() if state == "cancelled" else None,
                }
            )
            self._persist()
            self._log_event("job-cancel-requested", state=state)
            return self._status()

    def expire_stale(self) -> bool:
        with self._lock:
            journal = self._journal
            if journal is None or journal.state in TERMINAL_STATES:
                return False
            if self._clock() - journal.last_control_at < self.settings.watchdog_seconds:
                return False
            self._cancelled.set()
            self._journal = journal.model_copy(
                update={
                    "state": "interrupted",
                    "transfer_request": None,
                    "error": _safe_error("JOB_INTERRUPTED"),
                    "terminal_at": self._clock(),
                }
            )
            self._physical_busy = self._worker_running
            self._persist()
            self._log_event("watchdog-interrupted", state="interrupted")
            return True

    def cleanup_expired(self) -> int:
        """Remove only old, non-active job workspaces from the state volume."""
        jobs_root = self.settings.state_root / "jobs"
        if not jobs_root.is_dir():
            return 0
        now = self._clock()
        active_attempt = (
            self._journal.submission.attempt_id
            if self._journal is not None
            and self._journal.state not in TERMINAL_STATES
            and self._journal.state != "output-ready"
            else None
        )
        removed = 0
        for candidate in jobs_root.iterdir():
            if not candidate.is_dir() or candidate.name == active_attempt:
                continue
            if (
                self._journal is not None
                and candidate.name == self._journal.submission.attempt_id
            ):
                terminal_at = self._journal.terminal_at or self._journal.output_ready_at
                if (
                    terminal_at is None
                    or now - terminal_at < self.settings.retention_seconds
                ):
                    continue
                if self._journal.state == "output-ready":
                    self._journal = self._journal.model_copy(
                        update={
                            "state": "interrupted",
                            "transfer_request": None,
                            "error": _safe_error("JOB_INTERRUPTED"),
                            "terminal_at": now,
                        }
                    )
                    self._physical_busy = False
                    self._persist()
                    self._log_event("output-retention-expired", state="interrupted")
            try:
                age = now - candidate.stat().st_mtime
                if age >= self.settings.retention_seconds:
                    shutil.rmtree(candidate)
                    removed += 1
            except OSError:
                logger.info(self._event_json("cleanup-skipped", outcome="unavailable"))
        if removed:
            self._log_event("cleanup-completed", removed=removed)
        return removed

    def _transfer(
        self,
        url: str,
        role: TransferRole,
        transfer_request_id: str,
    ) -> None:
        start_execution = False
        try:
            with self._lock:
                journal = self._require_journal()
                submission = journal.submission
                job_root = self._job_root(submission.attempt_id)
                job_root.mkdir(mode=0o700, parents=True, exist_ok=True)
            if role == "prepared-media":
                prepared = submission.tracking_request.prepared
                destination = job_root / "prepared.track.mp4"
                self.transfers.download(
                    url,
                    destination,
                    expected_bytes=prepared.byte_count,
                    expected_checksum=prepared.checksum_sha256,
                    max_bytes=self.settings.max_input_bytes,
                    timeout_seconds=self.settings.transfer_timeout_seconds,
                    cancelled=self._cancelled.is_set,
                )
            elif role == "frame-manifest":
                prepared = submission.tracking_request.prepared
                destination = job_root / "prepared.frames.json.gz"
                self.transfers.download(
                    url,
                    destination,
                    expected_bytes=prepared.frame_manifest_byte_count,
                    expected_checksum=prepared.frame_manifest_checksum_sha256,
                    max_bytes=self.settings.max_input_bytes,
                    timeout_seconds=self.settings.transfer_timeout_seconds,
                    cancelled=self._cancelled.is_set,
                )
            else:
                artifact = _require_artifact(journal)
                segment = artifact.segment
                self.transfers.upload(
                    url,
                    self._output_path(submission.attempt_id),
                    expected_bytes=segment.byte_count,
                    expected_checksum=segment.checksum_sha256,
                    max_bytes=self.settings.max_output_bytes,
                    timeout_seconds=self.settings.transfer_timeout_seconds,
                    cancelled=self._cancelled.is_set,
                )
            with self._lock:
                journal = self._require_journal()
                if self._cancelled.is_set() or journal.state != "transferring":
                    self._finish_cancelled_or_interrupted()
                    return
                completed = (*journal.completed_transfer_ids, transfer_request_id)
                if role == "prepared-media":
                    self._journal = journal.model_copy(
                        update={
                            "state": "transfer-grant-required",
                            "progress": 10,
                            "transfer_request": _transfer_request("frame-manifest"),
                            "completed_transfer_ids": completed,
                        }
                    )
                elif role == "frame-manifest":
                    self._journal = journal.model_copy(
                        update={
                            "state": "processing",
                            "progress": 20,
                            "transfer_request": None,
                            "completed_transfer_ids": completed,
                        }
                    )
                    start_execution = True
                else:
                    self._journal = journal.model_copy(
                        update={
                            "state": "completed",
                            "progress": 99,
                            "transfer_request": None,
                            "completed_transfer_ids": completed,
                            "terminal_at": self._clock(),
                        }
                    )
                    self._physical_busy = False
                self._worker_running = False
                self._persist()
                self._log_event("transfer-completed", role=role)
        except (JobRejectedError, TransferFailureError):
            with self._lock:
                self._transfer_failed()
        finally:
            url = ""
        if start_execution:
            with self._lock:
                self._worker_running = True
            self._start_task(self._execute)

    def _execute(self) -> None:
        try:
            with self._lock:
                journal = self._require_journal()
                submission = journal.submission
                job_root = self._job_root(submission.attempt_id)
            result = self.executor.execute(
                submission,
                ExecutionInput(
                    prepared_media=job_root / "prepared.track.mp4",
                    frame_manifest=job_root / "prepared.frames.json.gz",
                ),
                job_root,
                self._cancelled,
            )
            self._publish_output(result)
            with self._lock:
                journal = self._require_journal()
                if self._cancelled.is_set() or journal.state != "processing":
                    self._finish_cancelled_or_interrupted()
                    return
                self._journal = journal.model_copy(
                    update={
                        "state": "output-ready",
                        "progress": 90,
                        "transfer_request": _transfer_request("observation-artifact"),
                        "artifact": result.artifact,
                        "output_ready_at": self._clock(),
                    }
                )
                self._worker_running = False
                self._persist()
        # The executor is a third-party model boundary. No model exception may
        # strand physical GPU capacity or leave an active journal indefinitely.
        except Exception:  # noqa: BLE001
            with self._lock:
                if self._cancelled.is_set():
                    self._finish_cancelled_or_interrupted()
                else:
                    journal = self._require_journal()
                    self._journal = journal.model_copy(
                        update={
                            "state": "failed",
                            "transfer_request": None,
                            "error": _safe_error("TRACKING_FAILED"),
                            "terminal_at": self._clock(),
                        }
                    )
                    self._worker_running = False
                    self._physical_busy = False
                    self._persist()
                    self._log_event("execution-failed", outcome="failed")

    def _publish_output(self, result: ExecutionOutput) -> None:
        destination = self._output_path(result.artifact.attempt_id)
        pending = destination.with_suffix(".pending")
        value = result.path.read_bytes()
        segment = result.artifact.segment
        if (
            len(value) != segment.byte_count
            or len(value) > self.settings.max_output_bytes
            or hashlib.sha256(value).hexdigest() != segment.checksum_sha256
        ):
            raise TrackingExecutionError
        pending.write_bytes(value)
        descriptor = os.open(pending, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        pending.replace(destination)

    def _transfer_failed(self) -> None:
        journal = self._require_journal()
        self._worker_running = False
        if self._cancelled.is_set():
            self._finish_cancelled_or_interrupted()
            return
        state: JobState = (
            "output-ready"
            if journal.transfer_request is not None
            and journal.transfer_request.role == "observation-artifact"
            else "transfer-grant-required"
        )
        self._journal = journal.model_copy(
            update={"state": state, "error": _safe_error("TRANSFER_FAILED")}
        )
        self._persist()
        self._log_event("transfer-failed", outcome="retryable")

    def _finish_cancelled_or_interrupted(self) -> None:
        journal = self._require_journal()
        state: JobState = (
            "interrupted" if journal.state == "interrupted" else "cancelled"
        )
        self._journal = journal.model_copy(
            update={
                "state": state,
                "transfer_request": None,
                "terminal_at": self._clock(),
            }
        )
        self._worker_running = False
        self._physical_busy = False
        self._persist()
        self._log_event("job-terminal", state=state, capacity="available")

    def _touch(self) -> None:
        journal = self._require_journal()
        self._journal = journal.model_copy(update={"last_control_at": self._clock()})
        self._persist()

    def _status(self) -> JobStatus:
        journal = self._require_journal()
        submission = journal.submission
        return JobStatus(
            contractVersion="tracking-provider.v1",
            runId=submission.run_id,
            segmentId=submission.segment_id,
            attemptId=submission.attempt_id,
            leaseId=submission.lease_id,
            fencingToken=submission.fencing_token,
            specificationDigest=submission.specification_digest,
            profileDigest=submission.profile_digest,
            state=journal.state,
            resolvedProfileDigest=self.settings.installed_profile.digest,
            progress=journal.progress,
            transferRequest=journal.transfer_request,
            artifact=journal.artifact,
            error=journal.error,
        )

    def _require_identity(self, identity: ExecutionIdentity) -> _Journal:
        journal = self._require_journal()
        if not self._same_identity(identity, journal.submission):
            raise JobRejectedError(_safe_error("AUTHORITY_MISMATCH"))
        return journal

    def _require_journal(self) -> _Journal:
        if self._journal is None:
            raise JobRejectedError(_safe_error("JOB_NOT_FOUND"))
        return self._journal

    @staticmethod
    def _same_identity(
        first: ExecutionIdentity,
        second: ExecutionIdentity,
    ) -> bool:
        return (
            first.run_id,
            first.segment_id,
            first.attempt_id,
            first.lease_id,
            first.fencing_token,
            first.specification_digest,
            first.profile_digest,
        ) == (
            second.run_id,
            second.segment_id,
            second.attempt_id,
            second.lease_id,
            second.fencing_token,
            second.specification_digest,
            second.profile_digest,
        )

    def _job_root(self, attempt_id: str) -> Path:
        return self.settings.state_root / "jobs" / attempt_id

    def _output_path(self, attempt_id: str) -> Path:
        return self._job_root(attempt_id) / "observations.json.gz"

    @property
    def _journal_path(self) -> Path:
        return self.settings.state_root / "execution-state.json"

    def _persist(self) -> None:
        journal = self._require_journal()
        value = (
            json.dumps(
                journal.model_dump(mode="json", by_alias=True),
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n"
        ).encode()
        pending = self._journal_path.with_suffix(".pending")
        descriptor = os.open(
            pending,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        try:
            offset = 0
            while offset < len(value):
                written = os.write(descriptor, value[offset:])
                if written <= 0:
                    raise OSError
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        pending.replace(self._journal_path)

    def _restore(self) -> None:
        if not self._journal_path.exists():
            return
        try:
            journal = _Journal.model_validate_json(self._journal_path.read_bytes())
        except (OSError, ValidationError) as error:
            message = "GPU execution journal is invalid"
            raise ValueError(message) from error
        self._journal = journal
        if journal.state == "output-ready" and self._valid_recovered_output(journal):
            self._physical_busy = True
            return
        if journal.state in TERMINAL_STATES:
            if journal.terminal_at is None:
                try:
                    terminal_at = self._journal_path.stat().st_mtime
                except OSError:
                    terminal_at = self._clock()
                self._journal = journal.model_copy(update={"terminal_at": terminal_at})
                self._persist()
            return
        self._journal = journal.model_copy(
            update={
                "state": "interrupted",
                "transfer_request": None,
                "error": _safe_error("JOB_INTERRUPTED"),
                "terminal_at": self._clock(),
            }
        )
        self._persist()

    def _valid_recovered_output(self, journal: _Journal) -> bool:
        artifact = journal.artifact
        if artifact is None:
            return False
        try:
            value = self._output_path(journal.submission.attempt_id).read_bytes()
        except OSError:
            return False
        return (
            len(value) == artifact.segment.byte_count
            and len(value) <= self.settings.max_output_bytes
            and hashlib.sha256(value).hexdigest() == artifact.segment.checksum_sha256
        )

    @staticmethod
    def _event_json(event: str, **fields: object) -> str:
        allowed = {"event": event}
        allowed.update(
            {
                key: value
                for key, value in fields.items()
                if key
                in {
                    "attemptId",
                    "capacity",
                    "event",
                    "outcome",
                    "role",
                    "runId",
                    "segmentId",
                    "state",
                    "removed",
                }
            }
        )
        return json.dumps(allowed, separators=(",", ":"), sort_keys=True)

    def _log_event(self, event: str, **fields: object) -> None:
        journal = self._journal
        if journal is not None:
            fields = {
                "runId": journal.submission.run_id,
                "segmentId": journal.submission.segment_id,
                "attemptId": journal.submission.attempt_id,
                **fields,
            }
        logger.info(self._event_json(event, **fields))


def _transfer_request(role: TransferRole) -> TransferRequest:
    return TransferRequest(
        transferRequestId=str(uuid.uuid4()),
        role=role,
        method="PUT" if role == "observation-artifact" else "GET",
    )


def _safe_error(code: str) -> SafeJobError:
    messages = {
        "GPU_CAPACITY_BUSY": "GPU execution capacity is busy",
        "PROFILE_UNAVAILABLE": "requested inference profile is unavailable",
        "JOB_NOT_FOUND": "Tracking job was not found",
        "AUTHORITY_MISMATCH": "Tracking authority does not match",
        "TRANSFER_FAILED": "artifact transfer failed safely",
        "TRACKING_FAILED": "Tracking execution failed safely",
        "JOB_INTERRUPTED": "Tracking execution was interrupted",
        "INVALID_REQUEST": "request does not match the execution contract",
    }
    return SafeJobError.model_validate({"code": code, "message": messages[code]})


def _require_artifact(journal: _Journal) -> OutputArtifact:
    if journal.artifact is None:
        raise TransferFailureError
    return journal.artifact
