from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.logging_config import get_logger
from app.schemas import ErrorDetail, ErrorEnvelope

logger = get_logger(__name__)


class AppError(Exception):
    """Domain-specific HTTP error that serializes to { error: { code, message } }."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.headers = headers or {}


def register_exception_handlers(app: FastAPI) -> None:
    """Register global exception handlers enforcing the { error: { code, message } } contract."""

    @app.exception_handler(AppError)
    async def handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
        payload = ErrorEnvelope(error=ErrorDetail(code=exc.code, message=exc.message))
        return JSONResponse(
            status_code=exc.status_code,
            content=payload.model_dump(),
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        first_error = exc.errors()[0] if exc.errors() else {}
        message = str(first_error.get("msg", "Invalid request payload."))
        # Strip Pydantic v2 "Value error, " prefix for clean UX messaging
        if message.startswith("Value error, "):
            message = message[len("Value error, ") :]
        payload = ErrorEnvelope(
            error=ErrorDetail(code="VALIDATION_ERROR", message=message)
        )
        return JSONResponse(status_code=422, content=payload.model_dump())

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(
        _request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        code = f"HTTP_{exc.status_code}"
        message = str(exc.detail) if exc.detail else "Request failed."
        payload = ErrorEnvelope(error=ErrorDetail(code=code, message=message))
        return JSONResponse(status_code=exc.status_code, content=payload.model_dump())

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        logger.error(
            "unhandled_exception",
            path=request.url.path,
            method=request.method,
            exc_info=exc,
        )
        payload = ErrorEnvelope(
            error=ErrorDetail(
                code="INTERNAL_SERVER_ERROR",
                message="An unexpected server error occurred. Please try again.",
            )
        )
        return JSONResponse(status_code=500, content=payload.model_dump())
