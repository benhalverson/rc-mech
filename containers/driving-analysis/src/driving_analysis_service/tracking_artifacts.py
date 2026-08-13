# Artifact failures are mapped to canonical safe processing errors by the stage
# services; path and operating-system details never cross that boundary.
# ruff: noqa: EM101, TRY003

import errno
import gzip
import hashlib
import io
import json
import os
import stat
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from pydantic import BaseModel, ValidationError

from driving_analysis_service.processes import ProcessOutputLimitError
from driving_analysis_service.processing_deadline import (
    check_deadline,
    fsync_with_deadline,
)
from driving_analysis_service.settings import ServiceSettings

PREPARED_MEDIA_SUFFIX = ".track.mp4"
FRAME_MANIFEST_SUFFIX = ".frames.json.gz"
PREPARED_COMPLETION_SUFFIX = ".prepared.json"
PREPARED_BUNDLE_SUFFIX = ".prepared"
OBSERVATION_SEGMENT_SUFFIX = ".observations.json.gz"
OBSERVATION_COMPLETION_SUFFIX = ".observations.json"
OBSERVATION_BUNDLE_SUFFIX = ".observations"
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_COMPRESSED_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_OBSERVATION_SEGMENT_BYTES = 64 * 1024 * 1024


class ArtifactConflictError(RuntimeError):
    """An immutable output identifier belongs to different bytes."""


class InvalidArtifactError(RuntimeError):
    """A referenced local artifact does not match its immutable descriptor."""


@dataclass(frozen=True)
class PublishedArtifact:
    path: Path
    byte_count: int
    checksum: str
    created: bool


def compressed_contract(contract: BaseModel) -> bytes:
    payload = contract.model_dump(mode="json", by_alias=True)
    return gzip.compress(canonical_json(payload), compresslevel=9, mtime=0)


def canonical_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode()


def artifact_path(settings: ServiceSettings, artifact_id: str, suffix: str) -> Path:
    return settings.artifact_root / f"{artifact_id}{suffix}"


def bundle_path(settings: ServiceSettings, artifact_id: str, suffix: str) -> Path:
    return artifact_path(settings, artifact_id, suffix)


def bundle_member_path(
    settings: ServiceSettings,
    artifact_id: str,
    bundle_suffix: str,
    member_suffix: str,
) -> Path:
    bundle = bundle_path(settings, artifact_id, bundle_suffix)
    try:
        identity = bundle.stat(follow_symlinks=False)
    except OSError as error:
        raise InvalidArtifactError from error
    if not stat.S_ISDIR(identity.st_mode):
        raise InvalidArtifactError
    return bundle / f"{artifact_id}{member_suffix}"


def publish_bundle(
    destination: Path,
    members: Mapping[str, Path | bytes],
    *,
    deadline: float | None = None,
) -> bool:
    pending = Path(tempfile.mkdtemp(prefix=".pending-bundle-", dir=destination.parent))
    try:
        for name, value in members.items():
            check_deadline(deadline)
            target = pending / name
            if isinstance(value, Path):
                publish_file(value, target, deadline=deadline)
            else:
                publish_bytes(value, target, deadline=deadline)
        check_deadline(deadline)
        _fsync_directory(pending, deadline=deadline)
        try:
            pending.rename(destination)
        except OSError as error:
            if error.errno not in {errno.EEXIST, errno.ENOTEMPTY}:
                raise
            return False
        _fsync_directory(destination.parent, deadline=deadline)
        return True
    finally:
        if pending.exists():
            for child in pending.iterdir():
                child.unlink()
            pending.rmdir()


def publish_file(
    source: Path,
    destination: Path,
    *,
    deadline: float | None = None,
) -> PublishedArtifact:
    with source.open("rb") as source_file:
        return _publish_stream(source_file, destination, deadline=deadline)


def ensure_bundle_durable(destination: Path, *, deadline: float | None = None) -> None:
    identity = destination.stat(follow_symlinks=False)
    if not stat.S_ISDIR(identity.st_mode):
        raise InvalidArtifactError
    _fsync_directory(destination, deadline=deadline)
    _fsync_directory(destination.parent, deadline=deadline)


def _fsync_directory(directory: Path, *, deadline: float | None = None) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fsync_with_deadline(descriptor, deadline)
    finally:
        os.close(descriptor)


def publish_bytes(
    value: bytes,
    destination: Path,
    *,
    deadline: float | None = None,
) -> PublishedArtifact:
    with tempfile.TemporaryFile() as stream:
        stream.write(value)
        stream.seek(0)
        return _publish_stream(stream, destination, deadline=deadline)


def read_completion[ContractT: BaseModel](
    source: Path,
    contract_type: type[ContractT],
    *,
    max_bytes: int,
    deadline: float | None = None,
) -> ContractT | None:
    if not source.exists():
        return None
    raw = read_artifact(source, max_bytes=max_bytes, deadline=deadline)
    try:
        return contract_type.model_validate_json(raw)
    except ValidationError as error:
        raise InvalidArtifactError from error


def read_compressed_contract[ContractT: BaseModel](  # noqa: PLR0913
    source: Path,
    contract_type: type[ContractT],
    *,
    expected_bytes: int,
    expected_checksum: str,
    max_compressed_bytes: int,
    max_decompressed_bytes: int,
    deadline: float | None = None,
) -> ContractT:
    raw = read_verified_artifact(
        source,
        expected_bytes=expected_bytes,
        expected_checksum=expected_checksum,
        max_bytes=max_compressed_bytes,
        deadline=deadline,
    )
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
            decompressed = compressed.read(max_decompressed_bytes + 1)
            check_deadline(deadline)
    except (EOFError, gzip.BadGzipFile) as error:
        raise InvalidArtifactError from error
    if len(decompressed) > max_decompressed_bytes:
        raise InvalidArtifactError
    try:
        return contract_type.model_validate_json(decompressed)
    except ValidationError as error:
        raise InvalidArtifactError from error


def remove_published(artifact: PublishedArtifact) -> None:
    try:
        identity = artifact.path.stat(follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISREG(identity.st_mode):
        artifact.path.unlink()


def read_artifact(
    source: Path,
    *,
    max_bytes: int,
    deadline: float | None = None,
) -> bytes:
    descriptor = _open_artifact(source)
    result = bytearray()
    try:
        while chunk := os.read(descriptor, 1024 * 1024):
            check_deadline(deadline)
            if len(result) + len(chunk) > max_bytes:
                raise InvalidArtifactError
            result.extend(chunk)
    finally:
        os.close(descriptor)
    return bytes(result)


def read_verified_artifact(
    source: Path,
    *,
    expected_bytes: int,
    expected_checksum: str,
    max_bytes: int,
    deadline: float | None = None,
) -> bytes:
    result = read_artifact(source, max_bytes=max_bytes, deadline=deadline)
    if (
        len(result) != expected_bytes
        or hashlib.sha256(result).hexdigest() != expected_checksum
    ):
        raise InvalidArtifactError
    return result


def copy_verified_artifact(  # noqa: PLR0913
    source: Path,
    destination: Path,
    *,
    expected_bytes: int,
    expected_checksum: str,
    max_bytes: int,
    deadline: float | None = None,
) -> None:
    descriptor = _open_artifact(source)
    destination_descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    digest = hashlib.sha256()
    byte_count = 0
    verified = False
    write_limit = min(max_bytes, expected_bytes)
    try:
        while chunk := os.read(descriptor, 1024 * 1024):
            check_deadline(deadline)
            if byte_count + len(chunk) > write_limit:
                raise InvalidArtifactError
            byte_count += len(chunk)
            digest.update(chunk)
            _write_all(destination_descriptor, chunk)
        fsync_with_deadline(destination_descriptor, deadline)
        if byte_count != expected_bytes or digest.hexdigest() != expected_checksum:
            raise InvalidArtifactError
        verified = True
    finally:
        os.close(descriptor)
        os.close(destination_descriptor)
        if not verified:
            destination.unlink(missing_ok=True)


def file_digest(
    path: Path,
    *,
    max_bytes: int,
    deadline: float | None = None,
) -> tuple[str, int]:
    digest = hashlib.sha256()
    byte_count = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            check_deadline(deadline)
            byte_count += len(chunk)
            if byte_count > max_bytes:
                raise ProcessOutputLimitError
            digest.update(chunk)
    if byte_count == 0:
        raise ValueError("Artifact is empty")
    return digest.hexdigest(), byte_count


def _publish_stream(
    stream: BinaryIO,
    destination: Path,
    *,
    deadline: float | None = None,
) -> PublishedArtifact:
    descriptor, pending_name = tempfile.mkstemp(
        prefix=".pending-", dir=destination.parent
    )
    pending = Path(pending_name)
    digest = hashlib.sha256()
    byte_count = 0
    try:
        os.fchmod(descriptor, 0o600)
        while chunk := stream.read(1024 * 1024):
            check_deadline(deadline)
            byte_count += len(chunk)
            digest.update(chunk)
            _write_all(descriptor, chunk)
        fsync_with_deadline(descriptor, deadline)
        os.close(descriptor)
        descriptor = -1
        published = PublishedArtifact(
            destination,
            byte_count,
            digest.hexdigest(),
            created=True,
        )
        try:
            os.link(pending, destination)
        except FileExistsError:
            _verify_existing(published)
            return PublishedArtifact(
                published.path,
                published.byte_count,
                published.checksum,
                created=False,
            )
        return published
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        pending.unlink(missing_ok=True)


def _verify_existing(expected: PublishedArtifact) -> None:
    try:
        actual = read_artifact(expected.path, max_bytes=expected.byte_count)
    except InvalidArtifactError as error:
        raise ArtifactConflictError from error
    if (
        len(actual) != expected.byte_count
        or hashlib.sha256(actual).hexdigest() != expected.checksum
    ):
        raise ArtifactConflictError


def _open_artifact(path: Path) -> int:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        raise InvalidArtifactError from error
    identity = os.fstat(descriptor)
    if not stat.S_ISREG(identity.st_mode):
        os.close(descriptor)
        raise InvalidArtifactError
    return descriptor


def _write_all(descriptor: int, value: bytes) -> None:
    remaining = memoryview(value)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("Unable to write artifact")
        remaining = remaining[written:]
