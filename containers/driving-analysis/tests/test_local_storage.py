import errno
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from driving_analysis_service import local_storage
from driving_analysis_service.processes import ProcessOutputLimitError


def test_private_roots_require_absolute_owner_only_directories(tmp_path: Path) -> None:
    with pytest.raises(PermissionError, match="absolute"):
        local_storage.prepare_private_root(Path("relative"))

    public = tmp_path / "public"
    public.mkdir(mode=0o755)
    with pytest.raises(PermissionError, match="group or other"):
        local_storage.prepare_private_root(public)

    target = tmp_path / "target"
    target.mkdir(mode=0o700)
    linked = tmp_path / "linked"
    linked.symlink_to(target, target_is_directory=True)
    with pytest.raises(OSError, match=r"symbolic links|Not a directory"):
        local_storage.prepare_private_root(linked)


def test_open_private_root_detects_parent_replacement(tmp_path: Path) -> None:
    root = tmp_path / "root"
    moved = tmp_path / "moved"
    root.mkdir(mode=0o700)

    def replace_root() -> None:
        with local_storage.open_private_root(root):
            root.rename(moved)
            root.mkdir(mode=0o700)

    with pytest.raises(PermissionError, match="identity changed"):
        replace_root()


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"st_mode": stat.S_IFREG | 0o700}, "not a directory"),
        ({"st_uid": os.geteuid() + 1}, "unexpected owner"),
        ({"st_mode": stat.S_IFDIR | 0o710}, "group or other"),
        ({"st_mode": stat.S_IFDIR | 0o600}, "not owner accessible"),
        ({"st_ino": 2}, "identity changed"),
    ],
)
def test_root_identity_rejects_each_untrusted_property(
    changes: dict[str, int],
    message: str,
) -> None:
    values = {
        "st_mode": stat.S_IFDIR | 0o700,
        "st_uid": os.geteuid(),
        "st_dev": 1,
        "st_ino": 1,
    }
    identity = SimpleNamespace(**(values | changes))
    current = SimpleNamespace(**values)
    with pytest.raises(PermissionError, match=message):
        local_storage._validate_root_identity(identity, current)

    local_storage._validate_root_identity(
        SimpleNamespace(**values),
        SimpleNamespace(**values),
    )


def test_capacity_reservation_maps_storage_exhaustion_and_other_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[int, int, int, int]] = []

    def fallocate(
        descriptor: int,
        flags: int,
        offset: int,
        byte_count: int,
    ) -> int:
        calls.append((descriptor, flags, offset, byte_count))
        return 0

    monkeypatch.setattr(local_storage, "_FALLOCATE", fallocate)
    local_storage.reserve_file_capacity(7, 8)
    assert calls == [(7, local_storage._FALLOC_FL_KEEP_SIZE, 0, 8)]
    local_storage.reserve_file_capacity(7, 0)
    with pytest.raises(ValueError, match="negative"):
        local_storage.reserve_file_capacity(7, -1)

    monkeypatch.setattr(local_storage, "_FALLOCATE", lambda *_args: -1)
    for error_number in (errno.ENOSPC, errno.EDQUOT):
        monkeypatch.setattr(
            local_storage.ctypes,
            "get_errno",
            lambda error_number=error_number: error_number,
        )
        with pytest.raises(ProcessOutputLimitError):
            local_storage.reserve_file_capacity(7, 8)

    monkeypatch.setattr(local_storage.ctypes, "get_errno", lambda: errno.EPERM)
    with pytest.raises(OSError, match="Operation not permitted") as raised:
        local_storage.reserve_file_capacity(7, 8)
    assert raised.value.errno == errno.EPERM
