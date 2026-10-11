"""Bound decoded frame storage for the pinned SAM 3.1 folder input path."""

import importlib
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Protocol, cast

FRAME_CACHE_SIZE = 2


class _ImageBatch(Protocol):
    def __getitem__(self, index: int) -> object: ...


type _LoadImage = Callable[..., tuple[_ImageBatch, int, int]]


class BoundedImageFrames:
    """Indexable SAM input retaining at most two decoded, normalized frames.

    SAM already supports non-tensor frame collections for its async loader.
    Unlike that loader, this collection never starts a background task or keeps
    every decoded frame. Evicted frames can be read again without changing
    indices, pixel normalization, or the tracker's continuous inference state.
    """

    def __init__(
        self,
        paths: tuple[Path, ...],
        load_image: _LoadImage,
        options: dict[str, object],
    ) -> None:
        if not paths:
            message = "No prepared frames found"
            raise ValueError(message)
        self._paths = paths
        self._load_image = load_image
        self._options = options
        self._cache: OrderedDict[int, object] = OrderedDict()
        self.video_height = 0
        self.video_width = 0
        self[0]

    def __len__(self) -> int:
        return len(self._paths)

    def __getitem__(self, index: int) -> object:
        if index < 0:
            index += len(self)
        if not 0 <= index < len(self):
            raise IndexError(index)
        if index not in self._cache:
            batch, height, width = self._load_image(
                image_path=str(self._paths[index]), **self._options
            )
            if self.video_height and (height, width) != (
                self.video_height,
                self.video_width,
            ):
                message = "Prepared frame dimensions changed"
                raise ValueError(message)
            self.video_height, self.video_width = height, width
            self._cache[index] = batch[0]
            if len(self._cache) > FRAME_CACHE_SIZE:
                self._cache.popitem(last=False)
        self._cache.move_to_end(index)
        return self._cache[index]


def install_bounded_frame_loader() -> None:
    """Adapt only the pinned multiplex module's folder loader binding."""
    module = importlib.import_module("sam3.model.sam3_multiplex_tracking")
    io = importlib.import_module("sam3.model.io_utils")
    original = module.load_resource_as_video_frames
    load_image = cast("_LoadImage", io.load_image_as_single_frame_video)
    extensions = frozenset(io.IMAGE_EXTS)

    def load_frames(**kwargs: object) -> object:
        resource = kwargs.get("resource_path")
        if not isinstance(resource, str) or not Path(resource).is_dir():
            return original(**kwargs)
        paths = tuple(
            path
            for path in Path(resource).iterdir()
            if path.suffix.lower() in extensions
        )
        try:
            paths = tuple(sorted(paths, key=lambda path: int(path.stem)))
        except ValueError:
            paths = tuple(sorted(paths))
        frames = BoundedImageFrames(
            paths,
            load_image,
            {
                key: kwargs[key]
                for key in ("image_size", "offload_video_to_cpu", "img_mean", "img_std")
            },
        )
        return frames, frames.video_height, frames.video_width

    module.load_resource_as_video_frames = load_frames
