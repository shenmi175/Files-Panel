"""Route package.

This package intentionally avoids eager submodule imports so manager-only and
agent-only entrypoints can import only the routers they actually need.
"""

__all__: list[str] = []
