#!/usr/bin/env python3
"""
Build the FSLTL converter executable using PyInstaller.

This script builds convert_fsltl_batch.py into a standalone executable
that can be bundled with the Tauri application.

Uses a virtual environment to avoid affecting the global Python installation.

Usage:
    python scripts/build_converter.py

Output:
    src-tauri/resources/fsltl_converter.exe
"""

import subprocess
import sys
import shutil
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
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    converter_script = script_dir / "convert_fsltl_batch.py"
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

    # Verify output
    output_exe = output_dir / "fsltl_converter.exe"
    if not output_exe.exists():
        print(f"[build_converter] ERROR: Output file not found at {output_exe}")
        return 1

    size_mb = output_exe.stat().st_size / (1024 * 1024)
    print(f"[build_converter] SUCCESS: {output_exe} ({size_mb:.1f} MB)")

    # Copy texconv.exe alongside the converter
    texconv_src = script_dir / "texconv.exe"
    texconv_dest = output_dir / "texconv.exe"
    if texconv_src.exists():
        shutil.copy2(texconv_src, texconv_dest)
        print(f"[build_converter] Copied texconv.exe to {texconv_dest}")
    else:
        print(f"[build_converter] WARNING: texconv.exe not found at {texconv_src}")
        print("[build_converter] BC7/DXT10 texture conversion will not work!")

    return 0


if __name__ == "__main__":
    sys.exit(main())
