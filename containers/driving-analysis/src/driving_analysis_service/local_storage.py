# Local storage is a deployment-owned capability.  Callers receive an open
# directory descriptor so validation and the protected operation share one
# directory identity.
# ruff: noqa: EM101, TRY003

import ctypes
import errno
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from driving_analysis_service.processes import ProcessOutputLimitError

_PRIVATE_DIRECTORY_MODE = 0o700
_UNTRUSTED_PERMISSION_BITS = 0o077
_FALLOC_FL_KEEP_SIZE = 0x01
_LIBC = ctypes.CDLL(None, use_errno=True)
_FALLOCATE = _LIBC.fallocate
_FALLOCATE.argtypes = (ctypes.c_int, ctypes.c_int, ctypes.c_longlong, ctypes.c_longlong)
_FALLOCATE.restype = ctypes.c_int


def prepare_private_root(path: Path) -> None:
    if not path.is_absolute():
        raise PermissionError("Storage roots must be absolute")
    path.mkdir(mode=_PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
    with open_private_root(path):
        return


@contextmanager
def open_private_root(path: Path) -> Iterator[int]:
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
    )
    try:
        identity = os.fstat(descriptor)
        _validate_root_identity(identity, path.stat(follow_symlinks=False))
        yield descriptor
        _validate_root_identity(identity, path.stat(follow_symlinks=False))
    finally:
        os.close(descriptor)


def _validate_root_identity(identity: os.stat_result, current: os.stat_result) -> None:
    if not stat.S_ISDIR(identity.st_mode):
        raise PermissionError("Storage root is not a directory")
    if identity.st_uid != os.geteuid():
        raise PermissionError("Storage root has an unexpected owner")
    if identity.st_mode & _UNTRUSTED_PERMISSION_BITS:
        raise PermissionError("Storage root grants group or other access")
    if identity.st_mode & _PRIVATE_DIRECTORY_MODE != _PRIVATE_DIRECTORY_MODE:
        raise PermissionError("Storage root is not owner accessible")
    if (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
        raise PermissionError("Storage root identity changed")


def reserve_file_capacity(descriptor: int, byte_count: int) -> None:
    if byte_count < 0:
        raise ValueError("Reserved capacity cannot be negative")
    if byte_count == 0:
        return
    result = _FALLOCATE(descriptor, _FALLOC_FL_KEEP_SIZE, 0, byte_count)
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number in {errno.ENOSPC, errno.EDQUOT}:
        raise ProcessOutputLimitError
    raise OSError(error_number, os.strerror(error_number))
