#!/usr/bin/env python3
"""
Build the FSLTL converter executable using PyInstaller.

This script builds convert_fsltl_batch.py into a standalone executable
that can be bundled with the Tauri application.

Usage:
    python scripts/build_converter.py

Output:
    src-tauri/resources/fsltl_converter.exe
"""

import subprocess
import sys
import shutil
from pathlib import Path


def main():
    # Paths
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    converter_script = script_dir / "convert_fsltl_batch.py"
    output_dir = project_root / "src-tauri" / "resources"

    # Ensure output directory exists
    output_dir.mkdir(parents=True, exist_ok=True)

    # Check if PyInstaller is available
    try:
        import PyInstaller
        print(f"[build_converter] PyInstaller version: {PyInstaller.__version__}")
    except ImportError:
        print("[build_converter] PyInstaller not found. Installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller"])

    # Check dependencies
    try:
        import PIL
        print(f"[build_converter] Pillow available")
    except ImportError:
        print("[build_converter] Pillow not found. Installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"])

    try:
        import numpy
        print(f"[build_converter] NumPy available: {numpy.__version__}")
    except ImportError:
        print("[build_converter] NumPy not found. Installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "numpy"])

    # Build the executable using the spec file
    print(f"[build_converter] Building {converter_script.name}...")

    spec_file = script_dir / "fsltl_converter.spec"

    # PyInstaller command - use spec file which has all hidden imports defined
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--distpath", str(output_dir),        # Output directory
        "--workpath", str(project_root / "build" / "pyinstaller"),  # Work directory
        "--clean",                            # Clean before building
        "--noconfirm",                        # Don't ask for confirmation
        str(spec_file)                        # Use spec file for hidden imports
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
