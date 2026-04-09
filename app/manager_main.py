from __future__ import annotations

from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.core.settings import SETTINGS, STATIC_DIR
from app.core.version import APP_VERSION
from app.routes.access import router as access_router
from app.routes.auth import router as auth_router
from app.routes.bootstrap import router as bootstrap_router
from app.routes.files import router as files_router
from app.routes.resources import router as resources_router
from app.routes.runtime import router as runtime_router
from app.routes.servers import router as servers_router
from app.routes.system import router as system_router
from app.routes.updates import router as updates_router
from app.services import resources as resource_service
from app.services import servers as server_service


@asynccontextmanager
async def lifespan(_: FastAPI):
    await resource_service.on_startup()
    server_service.sync_local_server_record()
    try:
        yield
    finally:
        await resource_service.on_shutdown()


def create_app() -> FastAPI:
    application = FastAPI(title="File Panel Manager", version=APP_VERSION, lifespan=lifespan)
    application.include_router(system_router)
    application.include_router(auth_router)
    application.include_router(bootstrap_router)
    application.include_router(access_router)
    application.include_router(resources_router)
    application.include_router(runtime_router)
    application.include_router(servers_router)
    application.include_router(files_router)
    application.include_router(updates_router)
    application.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return application


app = create_app()


def run() -> None:
    uvicorn.run(
        "app.manager_main:app",
        host=SETTINGS.host,
        port=SETTINGS.port,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    run()
