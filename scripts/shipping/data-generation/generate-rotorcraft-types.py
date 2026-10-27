#!/usr/bin/env python3
"""
Generate src/renderer/constants/rotorcraftTypes.ts, the ICAO type designators of rotorcraft.

Data source: yaat's copy of the ICAO Doc 8643 aircraft type list, tests/Yaat.Sim.Tests/TestData/AircraftSpecs.json in
the yaat repository: a JSON array of one object per model, several models per designator. Every designator with a row
whose AircraftDescription is Helicopter, Gyrocopter or Tiltrotor is a rotorcraft.

Usage:
    python scripts/shipping/data-generation/generate-rotorcraft-types.py <path to AircraftSpecs.json>

Standard library only. Writes the output with LF line endings.
"""

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent.parent
OUTPUT_PATH = PROJECT_ROOT / "src" / "renderer" / "constants" / "rotorcraftTypes.ts"
SOURCE_NAME = "yaat tests/Yaat.Sim.Tests/TestData/AircraftSpecs.json"
SCRIPT_NAME = "scripts/shipping/data-generation/generate-rotorcraft-types.py"
ROTORCRAFT_DESCRIPTIONS = {"Helicopter", "Gyrocopter", "Tiltrotor"}


def rotorcraft_designators(specs_path: Path) -> list[str]:
    """The sorted, deduplicated designators of every rotorcraft entry in the specs file."""
    entries = json.loads(specs_path.read_text(encoding="utf-8-sig"))
    if not isinstance(entries, list):
        raise SystemExit(f"{specs_path}: expected a JSON array of aircraft entries")
    designators = set()
    for index, entry in enumerate(entries):
        if entry.get("AircraftDescription") not in ROTORCRAFT_DESCRIPTIONS:
            continue
        designator = entry.get("Designator")
        if not isinstance(designator, str) or not designator.strip():
            raise SystemExit(f"{specs_path}: rotorcraft entry {index} has no Designator: {entry}")
        designators.add(designator.strip())
    return sorted(designators)


def render(designators: list[str]) -> str:
    """The TypeScript module holding the designators."""
    lines = [
        "/**",
        " * ICAO type designators of rotorcraft: every designator with a helicopter, gyrocopter or tiltrotor entry.",
        " *",
        f" * GENERATED from {SOURCE_NAME}",
        f" * by {SCRIPT_NAME} ({len(designators)} designators).",
        " * Do not edit by hand; rerun the script on the file instead.",
        " */",
        "",
        "export const ROTORCRAFT_TYPES: ReadonlySet<string> = new Set([",
        *[f"  '{d}'," for d in designators],
        "])",
        "",
        "/** Whether an ICAO type designator is a rotorcraft's; an unknown, null or undefined type is not. */",
        "export function isRotorcraftType(type: string | null | undefined): boolean {",
        "  return type !== null && type !== undefined && ROTORCRAFT_TYPES.has(type)",
        "}",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: python {SCRIPT_NAME} <path to AircraftSpecs.json>")
    specs_path = Path(sys.argv[1])
    if not specs_path.is_file():
        raise SystemExit(f"{specs_path}: no such file (pass yaat's tests/Yaat.Sim.Tests/TestData/AircraftSpecs.json)")
    designators = rotorcraft_designators(specs_path)
    with open(OUTPUT_PATH, "w", encoding="utf-8", newline="\n") as out:
        out.write(render(designators))
    print(f"Wrote {len(designators)} rotorcraft designators to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
