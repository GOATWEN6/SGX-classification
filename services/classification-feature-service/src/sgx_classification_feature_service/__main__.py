from __future__ import annotations

import uvicorn

from .app import create_app
from .config import Settings


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run(
        create_app(settings=settings),
        host=settings.bind_host,
        port=settings.bind_port,
        access_log=False,
        workers=1,
    )


if __name__ == "__main__":
    main()
