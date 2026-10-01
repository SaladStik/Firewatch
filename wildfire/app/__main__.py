"""Run the dashboard: python -m app"""

import uvicorn

from app.config import Settings


def main() -> None:
    settings = Settings.load()
    uvicorn.run("app.main:app", host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
