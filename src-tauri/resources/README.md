# FSLTL Converter Resource

The `fsltl_converter.exe` file should be placed in this directory before building the Tauri app.

## Building the Converter

From the project root:

```bash
# Install dependencies
pip install pyinstaller pillow numpy

# Build the executable
cd scripts
pyinstaller fsltl_converter.spec

# Copy to resources
cp dist/fsltl_converter.exe ../src-tauri/resources/
```

## Requirements

- Python 3.10+
- PyInstaller
- Pillow (PIL) with DDS support
- NumPy

## Notes

- The executable is ~20-30MB due to bundled Python and dependencies
- It's a console application that outputs progress to stdout/stderr
- Progress is also written to a JSON file specified by `--progress-file`
