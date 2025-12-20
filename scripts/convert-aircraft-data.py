#!/usr/bin/env python3
"""
Aircraft Dimensions Data Converter

Downloads aircraft data from FAA Aircraft Characteristics Database and converts
it to JSON for use in the application.

Usage: python scripts/convert-aircraft-data.py

Data source: https://www.faa.gov/airports/engineering/aircraft_char_database
"""

import json
import os
import urllib.request
from pathlib import Path

# Try to import pandas and openpyxl
try:
    import pandas as pd
except ImportError:
    print("Error: pandas is required. Install with: pip install pandas openpyxl")
    exit(1)

# FAA Aircraft Characteristics Database URL
FAA_URL = "https://www.faa.gov/airports/engineering/aircraft_char_database/aircraft_data"

# Output path for the JSON file
SCRIPT_DIR = Path(__file__).parent
OUTPUT_PATH = SCRIPT_DIR.parent / "src" / "renderer" / "public" / "aircraft-dimensions.json"

# Conversion factor: feet to meters
FEET_TO_METERS = 0.3048


def download_file(url: str, output_path: str) -> None:
    """Download a file from URL to the specified path."""
    print(f"Downloading from: {url}")
    urllib.request.urlretrieve(url, output_path)
    print(f"Downloaded to: {output_path}")


def convert_feet_to_meters(value) -> float | None:
    """Convert feet to meters, handling various input formats."""
    if pd.isna(value):
        return None

    try:
        # Handle string values with units or special characters
        if isinstance(value, str):
            # Remove common suffixes and clean up
            value = value.strip().replace("'", "").replace('"', "").replace("ft", "").strip()
            if not value or value == "-":
                return None

        feet = float(value)
        meters = round(feet * FEET_TO_METERS, 2)
        return meters
    except (ValueError, TypeError):
        return None


def main():
    print("Aircraft Dimensions Data Converter (FAA Source)")
    print("=" * 50)
    print()

    # Create temp file path for downloaded Excel
    temp_excel = SCRIPT_DIR / "faa_aircraft_data.xlsx"

    try:
        # Download the Excel file
        download_file(FAA_URL, str(temp_excel))

        # Read the Excel file
        print("Reading Excel file...")
        df = pd.read_excel(temp_excel, engine="openpyxl")

        print(f"Found {len(df)} rows")
        print(f"Columns: {list(df.columns)}")

        # Find the relevant columns
        # FAA columns: ICAO_Code, Wingspan_ft_with_winglets_sharklets, Length_ft
        icao_col = None
        wingspan_with_winglets_col = None
        wingspan_without_winglets_col = None
        length_col = None

        for col in df.columns:
            col_lower = str(col).lower()
            if col_lower == "icao_code":
                icao_col = col
            elif "wingspan" in col_lower and "with_winglet" in col_lower:
                wingspan_with_winglets_col = col
            elif "wingspan" in col_lower and "without_winglet" in col_lower:
                wingspan_without_winglets_col = col
            elif col_lower == "length_ft":
                length_col = col

        # Fallback detection if specific columns not found
        if not icao_col:
            for col in df.columns:
                if str(col).lower() == "aac":
                    icao_col = col
                    break

        print(f"\nDetected columns:")
        print(f"  ICAO: {icao_col}")
        print(f"  Wingspan (with winglets): {wingspan_with_winglets_col}")
        print(f"  Wingspan (without winglets): {wingspan_without_winglets_col}")
        print(f"  Length: {length_col}")

        if not icao_col:
            print("\nError: Could not find ICAO/AAC column. Available columns:")
            for col in df.columns:
                print(f"  - {col}")
            exit(1)

        # Convert to our format
        dimensions = {}
        included = 0
        skipped = 0

        for _, row in df.iterrows():
            icao = str(row[icao_col]).strip().upper() if pd.notna(row[icao_col]) else None

            if not icao or icao == "NAN" or len(icao) > 4:
                skipped += 1
                continue

            # Prefer wingspan with winglets, fall back to without
            wingspan = None
            if wingspan_with_winglets_col:
                wingspan = convert_feet_to_meters(row[wingspan_with_winglets_col])
            if wingspan is None and wingspan_without_winglets_col:
                wingspan = convert_feet_to_meters(row[wingspan_without_winglets_col])

            length = convert_feet_to_meters(row[length_col]) if length_col else None

            # Skip entries without any dimensions
            if wingspan is None and length is None:
                skipped += 1
                continue

            # If we already have this ICAO, prefer the one with more complete data
            if icao in dimensions:
                existing = dimensions[icao]
                existing_complete = existing["wingspan"] is not None and existing["length"] is not None
                new_complete = wingspan is not None and length is not None

                if existing_complete and not new_complete:
                    continue

            dimensions[icao] = {
                "wingspan": wingspan,
                "length": length
            }
            included += 1

        print(f"\nIncluded: {included} aircraft types")
        print(f"Skipped: {skipped} rows (missing ICAO or dimensions)")

        # Filter to only entries with both dimensions for the app
        complete_dimensions = {
            k: v for k, v in dimensions.items()
            if v["wingspan"] is not None and v["length"] is not None
        }

        print(f"With both dimensions: {len(complete_dimensions)}")

        # Ensure output directory exists
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

        # Write main JSON file (for the app - only wingspan/length)
        json_content = json.dumps(complete_dimensions, indent=2, sort_keys=True)
        OUTPUT_PATH.write_text(json_content)

        print(f"\nWritten to: {OUTPUT_PATH}")
        print(f"File size: {len(json_content)} bytes")

        # Also save full data for reference
        full_data_path = SCRIPT_DIR / "faa_aircraft_full_data.json"
        df_clean = df.copy()
        # Convert DataFrame to records, handling NaN values
        full_records = df_clean.to_dict(orient="records")
        # Clean up NaN values
        for record in full_records:
            for key, value in list(record.items()):
                if pd.isna(value):
                    record[key] = None
        full_data_path.write_text(json.dumps(full_records, indent=2, default=str))
        print(f"Full data saved to: {full_data_path}")

        # Show some sample entries
        print("\nSample entries:")
        sample_keys = list(complete_dimensions.keys())[:10]
        for key in sample_keys:
            print(f"  {key}: {complete_dimensions[key]}")

        # Keep the Excel file for reference
        print(f"\nKept Excel file at: {temp_excel}")

    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()
        exit(1)


if __name__ == "__main__":
    main()
