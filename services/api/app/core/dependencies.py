"""The small dependencies every router needs (work package A02).

Application-scoped objects -- the settings, the engine -- live on ``app.state`` and are reached
from a request rather than imported, so two applications can run in one process (which is exactly
what the test suite does: one per throwaway database).

``now`` is a dependency too. A request that reads the clock in four places can compute four
different answers, and "the session expired between the check and the row that records the check"
is not a bug anybody enjoys finding. One value per request, passed down.
"""

from __future__ import annotations

import datetime as dt
from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session as OrmSession
from starlette.requests import Request

from app.core.database import Database, session_dependency
from app.core.logging import request_id
from app.core.settings import Settings

__all__ = [
    'ClientAddress',
    'DatabaseDep',
    'Now',
    'RequestId',
    'SessionDep',
    'SettingsDep',
    'client_address',
    'get_database',
    'get_now',
    'get_request_id',
    'get_settings',
]


def get_settings(request: Request) -> Settings:
    """This process's settings."""
    settings: Settings = request.app.state.settings
    return settings


def get_database(request: Request) -> Database:
    """This process's metadata store."""
    database: Database = request.app.state.database
    return database


def get_request_id(request: Request) -> str:
    """The request id bound by :class:`app.core.logging.RequestContextMiddleware`."""
    return request_id(request.scope)


def client_address(request: Request) -> str | None:
    """The caller's address, as resolved for logging and rate limiting."""
    state = request.scope.get('state')
    address = state.get('client_address') if isinstance(state, dict) else None
    if isinstance(address, str) and address:
        return address
    return request.client.host if request.client is not None else None


def get_now() -> dt.datetime:
    """One UTC timestamp for the whole request."""
    return dt.datetime.now(dt.UTC)


SessionDep = Annotated[OrmSession, Depends(session_dependency)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
DatabaseDep = Annotated[Database, Depends(get_database)]
RequestId = Annotated[str, Depends(get_request_id)]
ClientAddress = Annotated[str | None, Depends(client_address)]
Now = Annotated[dt.datetime, Depends(get_now)]
