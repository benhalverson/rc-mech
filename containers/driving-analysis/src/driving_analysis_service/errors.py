from dataclasses import dataclass

from driving_analysis_service.contracts import ErrorCode, ErrorStage, SafeError


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
