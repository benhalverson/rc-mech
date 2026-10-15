from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from driving_analysis_service import sam31_frames


def test_long_video_decodes_on_demand_and_evicts_old_frames() -> None:
    paths = tuple(Path(f"{index}.jpg") for index in range(12000))
    load = Mock(side_effect=lambda **kw: ([kw["image_path"]], 720, 1920))
    frames = sam31_frames.BoundedImageFrames(paths, load, {"image_size": 1008})
    assert len(frames) == 12000
    assert load.call_count == 1
    assert frames[0] == "0.jpg"
    for index in range(len(frames)):
        assert frames[index] == f"{index}.jpg"
        assert len(frames._cache) <= 2
    assert frames[-1] == "11999.jpg"
    assert load.call_count == 12000
    assert frames[0] == "0.jpg"
    assert load.call_count == 12001
    for index in (-12001, 12000):
        with pytest.raises(IndexError):
            frames[index]


def test_empty_and_inconsistent_frame_dimensions_fail_closed() -> None:
    with pytest.raises(ValueError, match="No prepared frames"):
        sam31_frames.BoundedImageFrames((), Mock(), {})
    frames = sam31_frames.BoundedImageFrames(
        (Path("0.jpg"), Path("1.jpg")),
        Mock(side_effect=[([object()], 720, 1920), ([object()], 1080, 1920)]),
        {},
    )
    with pytest.raises(ValueError, match="dimensions changed"):
        frames[1]


def test_folder_adapter_preserves_order_normalization_and_other_resources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = Mock(return_value="original")
    module = SimpleNamespace(load_resource_as_video_frames=original)
    load = Mock(side_effect=lambda **kw: ([kw["image_path"]], 720, 1920))
    io = SimpleNamespace(IMAGE_EXTS=[".jpg"], load_image_as_single_frame_video=load)
    modules = {"sam3.model.sam3_multiplex_tracking": module, "sam3.model.io_utils": io}
    monkeypatch.setattr(sam31_frames.importlib, "import_module", modules.__getitem__)
    sam31_frames.install_bounded_frame_loader()
    options = {
        "image_size": 1008,
        "offload_video_to_cpu": True,
        "img_mean": (0.5, 0.5, 0.5),
        "img_std": (0.5, 0.5, 0.5),
    }
    for name in ("10.jpg", "2.jpg", "manifest.json"):
        (tmp_path / name).touch()
    frames, height, width = module.load_resource_as_video_frames(
        resource_path=str(tmp_path), **options
    )
    assert (height, width) == (720, 1920)
    assert frames[0] == str(tmp_path / "2.jpg")
    assert frames[1] == str(tmp_path / "10.jpg")
    load.assert_called_with(image_path=str(tmp_path / "10.jpg"), **options)
    (tmp_path / "a.jpg").touch()
    alphabetical, _, _ = module.load_resource_as_video_frames(
        resource_path=str(tmp_path), **options
    )
    assert alphabetical[0] == str(tmp_path / "10.jpg")
    assert module.load_resource_as_video_frames(resource_path="video.mov") == "original"
    assert module.load_resource_as_video_frames(resource_path=[]) == "original"
