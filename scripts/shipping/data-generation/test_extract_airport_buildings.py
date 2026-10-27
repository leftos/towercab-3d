"""Tests for extract-airport-buildings.py over small hand-built OSM XML fixtures.

Run:
    uv run --no-project --python 3.12 --with osmium python -m unittest discover \
        -s scripts/shipping/data-generation -p "test_extract_airport_buildings.py" -v
"""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parent / "extract-airport-buildings.py"
_spec = importlib.util.spec_from_file_location("extract_airport_buildings", SCRIPT)
eab = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eab)


def _tags(tags: dict) -> str:
    return "".join(f'<tag k="{k}" v="{v}"/>' for k, v in tags.items())


class OsmXml:
    """Collects nodes, ways and relations and writes them as an .osm XML file."""

    def __init__(self):
        self.nodes: list[str] = []
        self.ways: list[str] = []
        self.relations: list[str] = []
        self._next_node = 1

    def node(self, lon: float, lat: float) -> int:
        node_id = self._next_node
        self._next_node += 1
        self.nodes.append(f'<node id="{node_id}" version="1" lat="{lat}" lon="{lon}"/>')
        return node_id

    def way(self, way_id: int, coords: list[tuple[float, float]], tags: dict, closed: bool = True) -> None:
        refs = [self.node(lon, lat) for lon, lat in coords]
        if closed:
            refs.append(refs[0])
        nds = "".join(f'<nd ref="{r}"/>' for r in refs)
        self.ways.append(f'<way id="{way_id}" version="1">{nds}{_tags(tags)}</way>')

    def relation(self, rel_id: int, members: list[tuple[str, int, str]], tags: dict) -> None:
        mems = "".join(f'<member type="{t}" ref="{r}" role="{role}"/>' for t, r, role in members)
        self.relations.append(f'<relation id="{rel_id}" version="1">{mems}{_tags(tags)}</relation>')

    def write(self, path: Path) -> Path:
        body = "".join(self.nodes + self.ways + self.relations)
        path.write_text(f'<?xml version="1.0" encoding="UTF-8"?><osm version="0.6">{body}</osm>', encoding="utf-8")
        return path


def square(lon0: float, lat0: float, size: float) -> list[tuple[float, float]]:
    return [(lon0, lat0), (lon0 + size, lat0), (lon0 + size, lat0 + size), (lon0, lat0 + size)]


TYPED = {"building": "transportation", "aeroway": "terminal"}
BOUNDARIES = {"KXXX": {"p": [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]]]}}


class TestOutlineRelations(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _read(self, osm: OsmXml):
        return eab.read_outline_relations(osm.write(self.tmp / "rel.osm"), BOUNDARIES)

    def test_typed_outline_way_inside_boundary_is_kept_with_only_rule_keys(self):
        osm = OsmXml()
        outline_tags = {
            "building": "transportation",
            "aeroway": "terminal",
            "height": "40",
            "building:levels": "5",
            "name": "International Terminal",
            "roof:shape": "flat",
        }
        osm.way(10, square(0.2, 0.2, 0.1), outline_tags)
        osm.way(11, square(0.21, 0.21, 0.01), {"building:part": "yes"})
        osm.relation(1, [("w", 10, "outline"), ("w", 11, "part")], {"type": "building"})
        relations, counts = self._read(osm)
        self.assertEqual(
            relations,
            {"1": {"aeroway": "terminal", "building": "transportation", "building:levels": "5", "height": "40"}},
        )
        self.assertEqual(counts["kept"], 1)

    def test_outline_with_only_building_yes_is_dropped(self):
        osm = OsmXml()
        osm.way(20, square(0.2, 0.2, 0.1), {"building": "yes", "height": "12"})
        osm.way(21, square(0.21, 0.21, 0.01), {"building:part": "yes"})
        osm.relation(2, [("w", 20, "outline"), ("w", 21, "part")], {"type": "building"})
        relations, counts = self._read(osm)
        self.assertEqual(relations, {})
        self.assertEqual(counts["outline_untyped"], 1)

    def test_relation_with_two_outline_members_is_dropped_and_counted(self):
        osm = OsmXml()
        osm.way(30, square(0.2, 0.2, 0.1), TYPED)
        osm.way(31, square(0.4, 0.4, 0.1), TYPED)
        osm.way(32, square(0.21, 0.21, 0.01), {"building:part": "yes"})
        osm.relation(3, [("w", 30, "outline"), ("w", 31, "outline"), ("w", 32, "part")], {"type": "building"})
        relations, counts = self._read(osm)
        self.assertEqual(relations, {})
        self.assertEqual(counts["several_outlines"], 1)

    def test_relation_with_all_parts_outside_every_boundary_is_dropped(self):
        osm = OsmXml()
        osm.way(40, square(5.0, 5.0, 0.1), TYPED)
        osm.way(41, square(5.01, 5.01, 0.01), {"building:part": "yes"})
        osm.way(42, square(5.03, 5.03, 0.01), {"building:part": "yes"})
        osm.relation(4, [("w", 40, "outline"), ("w", 41, "part"), ("w", 42, "part")], {"type": "building"})
        relations, counts = self._read(osm)
        self.assertEqual(relations, {})
        self.assertEqual(counts["outside_boundaries"], 1)

    def test_outline_that_is_a_relation_is_read(self):
        osm = OsmXml()
        osm.way(50, square(0.2, 0.2, 0.1), {})
        osm.way(51, square(0.21, 0.21, 0.01), {"building:part": "yes"})
        osm.relation(50, [("w", 50, "outer")], {"type": "multipolygon", "building": "hangar"})
        osm.relation(5, [("r", 50, "outline"), ("w", 51, "part")], {"type": "building"})
        relations, counts = self._read(osm)
        self.assertEqual(relations, {"5": {"building": "hangar"}})
        self.assertEqual(counts["kept"], 1)

    def test_parts_inside_decide_even_when_outline_outside(self):
        osm = OsmXml()
        osm.way(60, square(5.0, 5.0, 0.1), TYPED)
        osm.way(61, square(0.21, 0.21, 0.01), {"building:part": "yes"})
        osm.relation(6, [("w", 60, "outline"), ("w", 61, "part")], {"type": "building"})
        relations, counts = self._read(osm)
        self.assertEqual(relations, {"6": TYPED})
        self.assertEqual(counts["kept"], 1)

    def test_outline_inside_parts_outside_is_dropped(self):
        osm = OsmXml()
        osm.way(62, square(0.2, 0.2, 0.1), TYPED)
        osm.way(63, square(5.01, 5.01, 0.01), {"building:part": "yes"})
        osm.relation(7, [("w", 62, "outline"), ("w", 63, "part")], {"type": "building"})
        relations, counts = self._read(osm)
        self.assertEqual(relations, {})
        self.assertEqual(counts["outside_boundaries"], 1)

    def test_amenity_typed_outline_is_kept(self):
        osm = OsmXml()
        outline_tags = {"building": "yes", "amenity": "fire_station", "name": "Fire Station 1"}
        osm.way(70, square(0.2, 0.2, 0.1), outline_tags)
        osm.way(71, square(0.21, 0.21, 0.01), {"building:part": "yes"})
        osm.relation(8, [("w", 70, "outline"), ("w", 71, "part")], {"type": "building"})
        relations, counts = self._read(osm)
        self.assertEqual(relations, {"8": {"amenity": "fire_station", "building": "yes"}})
        self.assertEqual(counts["kept"], 1)

    def test_relation_with_no_outline_is_skipped_and_counted(self):
        osm = OsmXml()
        osm.way(80, square(0.21, 0.21, 0.01), {"building:part": "yes"})
        osm.relation(9, [("w", 80, "part")], {"type": "building"})
        relations, counts = self._read(osm)
        self.assertEqual(relations, {})
        self.assertEqual(counts["no_outline"], 1)


class TestAerodromes(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_icao_beats_ref_icao_and_larger_icao_match_wins(self):
        osm = OsmXml()
        # The larger KAAA area comes first (lower id, earlier in the file), so "take the last" fails.
        osm.way(1, square(20.0, 10.0, 0.5), {"aeroway": "aerodrome", "icao": "KAAA"})
        osm.way(2, square(10.0, 10.0, 0.1), {"aeroway": "aerodrome", "icao": "KAAA"})
        osm.way(3, square(30.0, 10.0, 0.5), {"aeroway": "aerodrome", "ref:icao": "KBBB"})
        osm.way(4, square(40.0, 10.0, 0.1), {"aeroway": "aerodrome", "icao": "KBBB"})
        osm.way(5, square(50.0, 10.0, 0.1), {"aeroway": "aerodrome", "ref:icao": "KCCC"})
        boundaries, duplicates, _ = eab.read_aerodromes(osm.write(self.tmp / "aero.osm"), {"KAAA", "KBBB", "KCCC", "KZZZ"})
        self.assertEqual(sorted(boundaries), ["KAAA", "KBBB", "KCCC"])
        self.assertEqual(boundaries["KAAA"]["p"][0][0], [20.0, 10.0])
        self.assertEqual(boundaries["KBBB"]["p"][0][0], [40.0, 10.0])
        self.assertEqual(boundaries["KCCC"]["p"][0][0], [50.0, 10.0])
        self.assertEqual(duplicates, ["KAAA"])

    def test_multipolygon_with_hole_yields_closed_outer_and_inner_rings(self):
        osm = OsmXml()
        outer = [(1.12345678, 2.0), (1.5, 2.0), (1.5, 2.5), (1.12345678, 2.5)]
        osm.way(1, outer, {})
        osm.way(2, square(1.2, 2.1, 0.1), {})
        osm.relation(7, [("w", 1, "outer"), ("w", 2, "inner")], {"type": "multipolygon", "aeroway": "aerodrome", "icao": "KHOL"})
        boundaries, _, _ = eab.read_aerodromes(osm.write(self.tmp / "aero.osm"), {"KHOL"})
        boundary = boundaries["KHOL"]
        self.assertEqual(len(boundary["p"]), 1)
        self.assertEqual(len(boundary["h"]), 1)
        for ring in boundary["p"] + boundary["h"]:
            self.assertEqual(ring[0], ring[-1])
            self.assertEqual(len(ring), 5)
        self.assertIn([1.123457, 2.0], boundary["p"][0])
        self.assertIn([1.2, 2.1], boundary["h"][0])
        self.assertTrue(eab.point_in_boundary(1.4, 2.4, boundary))
        self.assertFalse(eab.point_in_boundary(1.25, 2.15, boundary))

    def test_way_without_hole_has_no_h_key(self):
        osm = OsmXml()
        osm.way(1, square(0.0, 0.0, 1.0), {"aeroway": "aerodrome", "icao": "KONE"})
        boundaries, duplicates, _ = eab.read_aerodromes(osm.write(self.tmp / "aero.osm"), {"KONE"})
        self.assertNotIn("h", boundaries["KONE"])
        self.assertEqual(duplicates, [])


class TestRunFilter(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _stub_that_writes_and_fails(self) -> Path:
        """A stub executable that writes the file osmium was told to write (-o <path>) and exits 3."""
        stub = self.tmp / "osmium-stub.cmd"
        stub.write_bytes(
            b"@echo off\r\n"
            b":args\r\n"
            b'if "%~1"=="" exit /b 3\r\n'
            b'if "%~1"=="-o" (\r\n'
            b'  echo truncated> "%~2"\r\n'
            b"  exit /b 3\r\n"
            b")\r\n"
            b"shift\r\n"
            b"goto args\r\n"
        )
        return stub

    def test_failed_filter_leaves_no_extract(self):
        planet = self.tmp / "planet.osm.pbf"
        planet.write_bytes(b"planet")
        output = self.tmp / "aerodromes.osm.pbf"
        with self.assertRaises(subprocess.CalledProcessError):
            eab.run_filter(self._stub_that_writes_and_fails(), planet, "nwr/aeroway=aerodrome", output, force=True)
        self.assertFalse(output.exists())
        self.assertFalse(output.with_name(output.name + ".partial").exists())


if __name__ == "__main__":
    unittest.main()
