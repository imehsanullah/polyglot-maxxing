from __future__ import annotations

import uvicorn

from .config import Settings


def run() -> None:
    settings = Settings.from_environment()
    uvicorn.run(
        "polyglot_maxxing.app:create_app",
        host=settings.host,
        port=settings.port,
        reload=False,
        factory=True,
    )


if __name__ == "__main__":
    run()
