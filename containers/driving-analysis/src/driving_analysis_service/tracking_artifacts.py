# Artifact failures are mapped to canonical safe processing errors by the stage
# services; path and operating-system details never cross that boundary.
# ruff: noqa: EM101, TRY003

import ctypes
import errno
import gzip
import hashlib
import io
import json
import os
import re
import secrets
import stat
import sys
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import BinaryIO, Self, cast

from pydantic import BaseModel, ValidationError

from driving_analysis_service.local_storage import (
    open_private_root,
    reserve_file_capacity,
)
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


@dataclass(frozen=True)
class BundleMember:
    root: Path
    bundle_name: str
    member_name: str

    @property
    def path(self) -> Path:
        return self.root / self.bundle_name / self.member_name


ArtifactSource = Path | BundleMember
_RENAME_NOREPLACE = 1
_SAFE_NAME_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,255}\Z", re.ASCII)
_LIBC = ctypes.CDLL(None, use_errno=True)
_RENAMEAT2 = _LIBC.renameat2
_RENAMEAT2.argtypes = (
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_uint,
)
_RENAMEAT2.restype = ctypes.c_int


class BundleReservation:
    def __init__(
        self,
        destination: Path,
        capacities: Mapping[str, int],
        *,
        deadline: float | None = None,
    ) -> None:
        self._destination_name = _validate_name(destination.name)
        validated_capacities: dict[str, int] = {}
        for name, capacity in capacities.items():
            safe_name = _validate_name(name)
            if capacity < 0:
                raise ValueError("Bundle member capacity cannot be negative")
            validated_capacities[safe_name] = capacity
        self.destination = destination
        self.capacities = validated_capacities
        self.deadline = deadline
        self._root_scope = open_private_root(destination.parent)
        self._root_descriptor: int | None = None
        self._pending_descriptor: int | None = None
        self._pending_name = f".pending-bundle-{secrets.token_hex(16)}"
        self._pending_created = False
        self._committed = False

    def __enter__(self) -> Self:
        self._root_descriptor = self._root_scope.__enter__()
        try:
            root_descriptor = self._root()
            os.mkdir(self._pending_name, 0o700, dir_fd=root_descriptor)
            self._pending_created = True
            self._pending_descriptor = os.open(
                self._pending_name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=root_descriptor,
            )
            for name, capacity in self.capacities.items():
                check_deadline(self.deadline)
                descriptor = os.open(
                    name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=self._pending(),
                )
                try:
                    reserve_file_capacity(descriptor, capacity)
                finally:
                    os.close(descriptor)
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise
        else:
            return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exception_type, exception, traceback
        try:
            if not self._committed:
                self._remove_pending()
        finally:
            if self._pending_descriptor is not None:
                os.close(self._pending_descriptor)
                self._pending_descriptor = None
            if self._root_descriptor is not None:
                self._root_scope.__exit__(None, None, None)
                self._root_descriptor = None

    def publish(self, members: Mapping[str, Path | bytes]) -> bool:
        if set(members) != set(self.capacities):
            raise ValueError("Published members must match reserved members")
        for name, value in members.items():
            check_deadline(self.deadline)
            self._write_member(name, value)
        fsync_with_deadline(self._pending(), self.deadline)
        _verify_directory_entry(
            self._root(),
            self._pending_name,
            self._pending(),
        )
        try:
            _rename_noreplace(
                self._root(),
                self._pending_name,
                self._destination_name,
            )
        except FileExistsError:
            return False
        self._committed = True
        fsync_with_deadline(self._root(), self.deadline)
        return True

    def _write_member(self, name: str, value: Path | bytes) -> None:
        descriptor = os.open(
            name,
            os.O_WRONLY | os.O_NOFOLLOW,
            dir_fd=self._pending(),
        )
        try:
            if isinstance(value, Path):
                source_descriptor = _open_artifact(value)
                try:
                    byte_count = _copy_descriptors(
                        source_descriptor,
                        descriptor,
                        self.capacities[name],
                        self.deadline,
                    )
                finally:
                    os.close(source_descriptor)
            else:
                if len(value) > self.capacities[name]:
                    raise ProcessOutputLimitError
                _write_all(descriptor, value)
                byte_count = len(value)
            os.ftruncate(descriptor, byte_count)
            fsync_with_deadline(descriptor, self.deadline)
        finally:
            os.close(descriptor)

    def _remove_pending(self) -> None:
        if self._root_descriptor is None or not self._pending_created:
            return
        if self._pending_descriptor is not None:
            for name in os.listdir(  # noqa: PTH208 - dirfd is required
                self._pending()
            ):
                os.unlink(name, dir_fd=self._pending())
        os.rmdir(self._pending_name, dir_fd=self._root())

    def _root(self) -> int:
        if self._root_descriptor is None:
            raise RuntimeError("Bundle reservation is not open")
        return self._root_descriptor

    def _pending(self) -> int:
        if self._pending_descriptor is None:
            raise RuntimeError("Bundle reservation is not open")
        return self._pending_descriptor


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
) -> BundleMember:
    bundle_name = _validate_name(f"{artifact_id}{bundle_suffix}")
    member_name = _validate_name(f"{artifact_id}{member_suffix}")
    with open_private_root(settings.artifact_root) as root_descriptor:
        bundle_descriptor = _open_bundle(root_descriptor, bundle_name)
        os.close(bundle_descriptor)
    return BundleMember(settings.artifact_root, bundle_name, member_name)


def bundle_exists(settings: ServiceSettings, artifact_id: str, suffix: str) -> bool:
    name = _validate_name(f"{artifact_id}{suffix}")
    with open_private_root(settings.artifact_root) as root_descriptor:
        try:
            identity = os.stat(  # noqa: PTH116 - descriptor-stable proc path
                _directory_entry_path(root_descriptor, name),
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return False
        if not stat.S_ISDIR(identity.st_mode):
            raise ArtifactConflictError
        return True


def reserve_bundle(
    destination: Path,
    capacities: Mapping[str, int],
    *,
    deadline: float | None = None,
) -> BundleReservation:
    return BundleReservation(destination, capacities, deadline=deadline)


def publish_bundle(
    destination: Path,
    members: Mapping[str, Path | bytes],
    *,
    deadline: float | None = None,
) -> bool:
    capacities = {name: _member_size(value) for name, value in members.items()}
    with reserve_bundle(destination, capacities, deadline=deadline) as reservation:
        return reservation.publish(members)


def ensure_bundle_durable(destination: Path, *, deadline: float | None = None) -> None:
    name = _validate_name(destination.name)
    with open_private_root(destination.parent) as root_descriptor:
        bundle_descriptor = _open_bundle(root_descriptor, name)
        try:
            fsync_with_deadline(bundle_descriptor, deadline)
            fsync_with_deadline(root_descriptor, deadline)
        finally:
            os.close(bundle_descriptor)


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
    source: ArtifactSource,
    contract_type: type[ContractT],
    *,
    max_bytes: int,
    deadline: float | None = None,
) -> ContractT | None:
    descriptor = _try_open_artifact(source)
    if descriptor is None:
        return None
    raw = _read_artifact_descriptor(
        descriptor,
        max_bytes=max_bytes,
        deadline=deadline,
    )
    try:
        return contract_type.model_validate_json(raw)
    except ValidationError as error:
        raise InvalidArtifactError from error


def read_compressed_contract[ContractT: BaseModel](  # noqa: PLR0913
    source: ArtifactSource,
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
    source: ArtifactSource,
    *,
    max_bytes: int,
    deadline: float | None = None,
) -> bytes:
    descriptor = _open_artifact(source)
    return _read_artifact_descriptor(
        descriptor,
        max_bytes=max_bytes,
        deadline=deadline,
    )


def _read_artifact_descriptor(
    descriptor: int,
    *,
    max_bytes: int,
    deadline: float | None,
) -> bytes:
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
    source: ArtifactSource,
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
    source: ArtifactSource,
    destination: Path,
    *,
    expected_bytes: int,
    expected_checksum: str,
    max_bytes: int,
    deadline: float | None = None,
) -> None:
    if expected_bytes < 0 or expected_bytes > max_bytes:
        raise InvalidArtifactError
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
        reserve_file_capacity(destination_descriptor, expected_bytes)
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
    path: ArtifactSource,
    *,
    max_bytes: int,
    deadline: float | None = None,
) -> tuple[str, int]:
    digest = hashlib.sha256()
    byte_count = 0
    descriptor = _open_artifact(path)
    try:
        while chunk := os.read(descriptor, 1024 * 1024):
            check_deadline(deadline)
            byte_count += len(chunk)
            if byte_count > max_bytes:
                raise ProcessOutputLimitError
            digest.update(chunk)
    finally:
        os.close(descriptor)
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


def _open_artifact(path: ArtifactSource) -> int:
    descriptor = _try_open_artifact(path)
    if descriptor is None:
        raise InvalidArtifactError
    return descriptor


def _try_open_artifact(path: ArtifactSource) -> int | None:
    if isinstance(path, BundleMember):
        return _try_open_bundle_member(path)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
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


def _validate_name(name: str) -> str:
    if name in {".", ".."} or _SAFE_NAME_PATTERN.fullmatch(name) is None:
        raise ValueError("Artifact names must be one path component")
    return name


def _directory_entry_path(parent_descriptor: int, name: str) -> str:
    safe_name = _validate_name(name)
    base_path = f"/proc/self/fd/{parent_descriptor}/"
    # This follows CodeQL's normalize-then-check path-injection pattern while
    # retaining the open directory descriptor as the authoritative parent.
    full_path = os.path.normpath(
        os.path.join(base_path, safe_name)  # noqa: PTH118
    )
    if not full_path.startswith(base_path):
        raise ValueError("Artifact path escaped its trusted directory")
    return full_path


def _member_size(value: Path | bytes) -> int:
    if isinstance(value, bytes):
        return len(value)
    descriptor = _open_artifact(value)
    try:
        return os.fstat(descriptor).st_size
    finally:
        os.close(descriptor)


def _copy_descriptors(
    source: int,
    destination: int,
    max_bytes: int,
    deadline: float | None,
) -> int:
    byte_count = 0
    while chunk := os.read(source, 1024 * 1024):
        check_deadline(deadline)
        byte_count += len(chunk)
        if byte_count > max_bytes:
            raise ProcessOutputLimitError
        _write_all(destination, chunk)
    return byte_count


def _open_bundle(root_descriptor: int, name: str) -> int:
    try:
        return os.open(
            _directory_entry_path(root_descriptor, name),
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
    except OSError as error:
        raise InvalidArtifactError from error


def _try_open_bundle_member(member: BundleMember) -> int | None:
    descriptor: int | None = None
    try:
        with open_private_root(member.root) as root_descriptor:
            try:
                bundle_descriptor = _open_bundle(root_descriptor, member.bundle_name)
            except InvalidArtifactError as error:
                if isinstance(error.__cause__, FileNotFoundError):
                    return None
                raise
            try:
                try:
                    descriptor = os.open(
                        _directory_entry_path(
                            bundle_descriptor,
                            member.member_name,
                        ),
                        os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                    )
                except FileNotFoundError:
                    return None
                except OSError as error:
                    raise InvalidArtifactError from error
            finally:
                os.close(bundle_descriptor)
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        raise
    descriptor = cast("int", descriptor)
    identity = os.fstat(descriptor)
    if not stat.S_ISREG(identity.st_mode):
        os.close(descriptor)
        raise InvalidArtifactError
    return descriptor


def _verify_directory_entry(
    parent_descriptor: int,
    name: str,
    expected_descriptor: int,
) -> None:
    expected = os.fstat(expected_descriptor)
    current = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (
        expected.st_dev,
        expected.st_ino,
    ):
        raise OSError("Pending bundle identity changed")


def _rename_noreplace(
    parent_descriptor: int,
    source_name: str,
    destination_name: str,
) -> None:
    result = _RENAMEAT2(
        parent_descriptor,
        os.fsencode(source_name),
        parent_descriptor,
        os.fsencode(destination_name),
        _RENAME_NOREPLACE,
    )
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number == errno.EEXIST:
        raise FileExistsError(error_number, os.strerror(error_number), destination_name)
    raise OSError(error_number, os.strerror(error_number), destination_name)
