from .auth import router as auth_router
from .access import router as access_router
from .files import router as files_router
from .resources import router as resources_router
from .runtime import router as runtime_router
from .servers import router as servers_router
from .system import router as system_router

__all__ = [
    "auth_router",
    "access_router",
    "files_router",
    "resources_router",
    "runtime_router",
    "servers_router",
    "system_router",
]
