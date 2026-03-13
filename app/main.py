from __future__ import annotations

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.core.settings import SETTINGS, STATIC_DIR
from app.routes import access_router, files_router, resources_router, runtime_router, system_router
from app.services import resources as resource_service


def create_app() -> FastAPI:
    application = FastAPI(title="Files Agent", version="1.0.0")
    application.include_router(system_router)
    application.include_router(access_router)
    application.include_router(resources_router)
    application.include_router(runtime_router)
    application.include_router(files_router)
    application.add_event_handler("startup", resource_service.on_startup)
    application.add_event_handler("shutdown", resource_service.on_shutdown)
    application.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return application


app = create_app()


def run() -> None:
    uvicorn.run(
        "app.main:app",
        host=SETTINGS.host,
        port=SETTINGS.port,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
