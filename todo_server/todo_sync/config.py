import os
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - useful when imported before deps install
    load_dotenv = None


def _bool_from_env(name, default=False):
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    DEFAULT_TODO_DIRECTORY: ClassVar[Path] = Path("/data/todo_files")

    todo_directory: Path
    caldav_url: str = "https://radicale:5232/"
    caldav_username: str = "todo"
    caldav_password: str = "todo"
    caldav_verify_ssl: bool = False
    caldav_collection_prefix: str = ""
    sync_state_file: Path | None = None
    api_host: str = "0.0.0.0"
    api_port: int = 5000
    enable_cors: bool = True

    @classmethod
    def from_env(cls, env_file=None):
        if load_dotenv is not None:
            load_dotenv(env_file)

        todo_directory = Path(os.getenv("TODO_DIRECTORY", cls.DEFAULT_TODO_DIRECTORY))
        sync_state_file = os.getenv("SYNC_STATE_FILE")

        return cls(
            todo_directory=todo_directory,
            caldav_url=os.getenv("CALDAV_URL", "https://radicale:5232/"),
            caldav_username=os.getenv("CALDAV_USERNAME", "todo"),
            caldav_password=os.getenv("CALDAV_PASSWORD", "todo"),
            caldav_verify_ssl=_bool_from_env("CALDAV_VERIFY_SSL", False),
            caldav_collection_prefix=os.getenv("CALDAV_COLLECTION_PREFIX", ""),
            sync_state_file=Path(sync_state_file) if sync_state_file else todo_directory / ".todo-sync-state.json",
            api_host=os.getenv("API_HOST", "0.0.0.0"),
            api_port=int(os.getenv("API_PORT", "5000")),
            enable_cors=_bool_from_env("API_ENABLE_CORS", True),
        )
