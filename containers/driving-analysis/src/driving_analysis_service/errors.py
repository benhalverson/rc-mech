from dataclasses import dataclass
from typing import Literal

from driving_analysis_service.contracts import SafeError

ErrorCode = Literal[
    "STAGED_MEDIA_NOT_FOUND",
    "STAGED_MEDIA_MISMATCH",
    "CORRUPT_MEDIA",
    "UNSUPPORTED_MEDIA",
    "MEDIA_OVER_LIMIT",
    "PROCESS_TIMEOUT",
    "INCOMPATIBLE_LAYOUT",
    "INTERNAL_ERROR",
]
ErrorStage = Literal["claim", "inspect", "probe", "decode", "cleanup"]


@dataclass(frozen=True)
class MediaValidationError(Exception):
    code: ErrorCode
    stage: ErrorStage
    safe_message: str

    def as_contract(self) -> SafeError:
        return SafeError(
            code=self.code,
            stage=self.stage,
            message=self.safe_message,
        )
