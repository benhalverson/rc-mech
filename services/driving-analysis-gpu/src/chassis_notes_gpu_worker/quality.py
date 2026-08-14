import subprocess
import sys
from pathlib import Path


def main() -> None:
    project_root = Path(__file__).resolve().parents[2]
    commands = (
        (sys.executable, "-m", "ruff", "format", "--check", "."),
        (sys.executable, "-m", "ruff", "check", "."),
        (sys.executable, "-m", "pytest"),
    )
    for command in commands:
        subprocess.run(command, cwd=project_root, check=True)  # noqa: S603


if __name__ == "__main__":
    main()
