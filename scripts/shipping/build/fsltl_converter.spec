# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for FSLTL Converter

Build with: pyinstaller fsltl_converter.spec

Requirements:
    pip install pyinstaller pillow numpy

Output:
    dist/fsltl_converter.exe (single file executable)
"""

from PyInstaller.utils.hooks import collect_submodules

# Let PyInstaller's built-in numpy hook handle most of the work
# Just add PIL DDS plugin as hidden import
a = Analysis(
    ['../conversion/convert_fsltl_batch.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'PIL.DdsImagePlugin',  # Ensure DDS support is included
    ] + collect_submodules('PIL'),
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
        # Exclude numpy test/build modules to reduce size
        'numpy.testing',
        'numpy.tests',
        'numpy.f2py',
        'numpy.distutils',
    ],
    noarchive=False,
    optimize=0,  # Required: numpy internals need docstrings preserved
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
