# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for FSLTL Converter

Build with: pyinstaller fsltl_converter.spec

Requirements:
    pip install pyinstaller pillow numpy

Output:
    dist/fsltl_converter.exe (single file executable)
"""

from PyInstaller.utils.hooks import collect_all, collect_submodules

# Collect ALL numpy components - submodules, binaries, and data files
# This is required because numpy has a complex structure with C extensions
numpy_datas, numpy_binaries, numpy_hiddenimports = collect_all('numpy')

# Also collect PIL properly
pil_datas, pil_binaries, pil_hiddenimports = collect_all('PIL')

a = Analysis(
    ['convert_fsltl_batch.py'],
    pathex=[],
    binaries=numpy_binaries + pil_binaries,
    datas=numpy_datas + pil_datas,
    hiddenimports=numpy_hiddenimports + pil_hiddenimports + [
        'PIL.DdsImagePlugin',  # Ensure DDS support is included
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'scipy',
        'pandas',
        'cv2',
        'IPython',
        'jupyter',
        # Exclude numpy test modules to reduce size
        'numpy.testing',
        'numpy.tests',
        'numpy.f2py',
        'numpy.distutils',
    ],
    noarchive=False,
    optimize=2,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='fsltl_converter',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # Console mode - enables error output for debugging
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
