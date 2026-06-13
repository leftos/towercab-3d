#!/usr/bin/env python3
"""
Build the FSLTL converter executable using PyInstaller.

This script builds convert_fsltl_batch.py into a standalone executable
that can be bundled with the Tauri application.

Uses a virtual environment to avoid affecting the global Python installation.

Usage:
    python scripts/shipping/build/build_converter.py

Output:
    src-tauri/resources/fsltl_converter        (macOS/Linux)
    src-tauri/resources/fsltl_converter.exe     (Windows)
"""

import subprocess
import sys
import venv
from pathlib import Path


def get_venv_python(venv_dir: Path) -> Path:
    """Get the Python executable path for a venv."""
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def setup_venv(venv_dir: Path, requirements_file: Path) -> Path:
    """Create venv and install requirements. Returns path to venv Python."""
    python_exe = get_venv_python(venv_dir)

    # Create venv if it doesn't exist
    if not python_exe.exists():
        print(f"[build_converter] Creating virtual environment at {venv_dir}")
        venv.create(venv_dir, with_pip=True)

    # Install/upgrade requirements
    print(f"[build_converter] Installing requirements from {requirements_file.name}")
    subprocess.check_call([
        str(python_exe), "-m", "pip", "install", "-q", "--upgrade",
        "-r", str(requirements_file)
    ])

    return python_exe


def main():
    # Paths
    script_dir = Path(__file__).parent  # scripts/shipping/build
    shipping_dir = script_dir.parent     # scripts/shipping
    project_root = shipping_dir.parent.parent  # project root
    converter_script = shipping_dir / "conversion" / "convert_fsltl_batch.py"
    requirements_file = script_dir / "converter-requirements.txt"
    output_dir = project_root / "src-tauri" / "resources"
    venv_dir = project_root / "build" / "converter-venv"

    # Ensure output directory exists
    output_dir.mkdir(parents=True, exist_ok=True)

    # Setup venv with requirements
    venv_python = setup_venv(venv_dir, requirements_file)

    # Print versions from venv
    result = subprocess.run(
        [str(venv_python), "-c",
         "import PyInstaller, PIL, numpy; "
         "print(f'PyInstaller {PyInstaller.__version__}, ')"
         "print(f'Pillow {PIL.__version__}, ')"
         "print(f'NumPy {numpy.__version__}')"],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        versions = result.stdout.replace('\n', '')
        print(f"[build_converter] Venv packages: {versions}")

    # Build the executable using the spec file
    print(f"[build_converter] Building {converter_script.name}...")

    spec_file = script_dir / "fsltl_converter.spec"

    # PyInstaller command - use spec file which has all hidden imports defined
    cmd = [
        str(venv_python), "-m", "PyInstaller",
        "--distpath", str(output_dir),
        "--workpath", str(project_root / "build" / "pyinstaller"),
        "--clean",
        "--noconfirm",
        str(spec_file)
    ]

    print(f"[build_converter] Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=project_root)

    if result.returncode != 0:
        print(f"[build_converter] ERROR: PyInstaller failed with code {result.returncode}")
        return 1

    # Verify output (PyInstaller appends .exe on Windows, no extension elsewhere)
    output_name = "fsltl_converter.exe" if sys.platform == "win32" else "fsltl_converter"
    output_bin = output_dir / output_name
    if not output_bin.exists():
        print(f"[build_converter] ERROR: Output file not found at {output_bin}")
        return 1

    size_mb = output_bin.stat().st_size / (1024 * 1024)
    print(f"[build_converter] SUCCESS: {output_bin} ({size_mb:.1f} MB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
