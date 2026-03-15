from __future__ import annotations

import uvicorn
from fastapi import FastAPI

from app.core.settings import SETTINGS
from app.routes.access import router as access_router
from app.routes.files import router as files_router
from app.routes.resources import router as resources_router
from app.routes.runtime import router as runtime_router
from app.routes.system import router as system_router
from app.services import resources as resource_service


def create_app() -> FastAPI:
    application = FastAPI(title="File Panel Agent", version="1.0.0")
    application.include_router(system_router)
    application.include_router(access_router)
    application.include_router(resources_router)
    application.include_router(runtime_router)
    application.include_router(files_router)
    application.add_event_handler("startup", resource_service.on_startup)
    application.add_event_handler("shutdown", resource_service.on_shutdown)
    return application


app = create_app()


def run() -> None:
    uvicorn.run(
        "app.agent_main:app",
        host=SETTINGS.host,
        port=SETTINGS.port,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    run()
