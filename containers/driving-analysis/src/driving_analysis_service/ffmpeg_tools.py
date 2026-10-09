"""Bounded FFmpeg runtime identity probing shared by media stages."""
# ruff: noqa: EM101, TRY003

from driving_analysis_service.processes import run_bounded_process
from driving_analysis_service.processing_deadline import remaining_seconds
from driving_analysis_service.settings import ServiceSettings

FFMPEG_VERSION_OUTPUT_BYTES = 16 * 1024


class FfmpegVersionError(ValueError):
    """FFmpeg could not report a valid bounded runtime identity."""


def probe_ffmpeg_version(settings: ServiceSettings, deadline: float) -> str:
    """Read bounded FFmpeg identity for preparation and rendering provenance.

    Uses the caller's remaining deadline and an output cap; malformed output or
    process failure raises FfmpegVersionError for the stage to map safely.
    """

    result = run_bounded_process(
        settings.ffmpeg_executable,
        ("-version",),
        timeout_seconds=remaining_seconds(deadline),
        max_output_bytes=FFMPEG_VERSION_OUTPUT_BYTES,
    )
    if result.return_code != 0:
        raise FfmpegVersionError("FFmpeg version is unavailable")
    try:
        first_line = result.stdout.decode("utf-8", errors="strict").splitlines()[0]
        prefix, version, *rest = first_line.split()
    except (IndexError, UnicodeDecodeError, ValueError) as error:
        raise FfmpegVersionError("FFmpeg version is invalid") from error
    if prefix != "ffmpeg" or version != "version" or not rest:
        raise FfmpegVersionError("FFmpeg version is invalid")
    return rest[0]
