# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for FSLTL Converter

Build with: pyinstaller fsltl_converter.spec

Requirements:
    pip install pyinstaller pillow numpy

Output:
    dist/fsltl_converter.exe (single file executable)
"""

a = Analysis(
    ['convert_fsltl_batch.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'PIL',
        'PIL.Image',
        'PIL.DdsImagePlugin',
        'numpy',
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
    console=True,  # Keep console for progress output
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
