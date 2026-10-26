"""Tests for scripts/debugging/lookup_glb_source.py: it identifies a converted GLB by its embedded metadata."""

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "debugging"))

import convert_fsltl_batch as converter
import lookup_glb_source as lookup
from test_convert_fsltl_batch import build_package


class LookupGlbSourceTests(unittest.TestCase):
    """The lookup reads the source and livery title from the GLB, never from its file name."""

    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.community = self.base / "Community"
        self.aircraft = build_package(self.community)
        self.output_dir = self.base / "out"
        self.output_dir.mkdir()

    def convert(self, name: str, metadata: dict | None) -> Path:
        output = self.output_dir / name
        converter.convert_single_gltf(
            self.aircraft / "model" / "t.gltf", output, [self.aircraft / "TEXTURE"], source_metadata=metadata
        )
        return output

    def run_main(self, *args: str) -> tuple[int, str]:
        out = io.StringIO()
        code = 0
        with mock.patch.object(sys, "argv", ["lookup_glb_source.py", *args]), contextlib.redirect_stdout(out):
            try:
                lookup.main()
            except SystemExit as exit_:
                code = int(exit_.code or 0)
        return code, out.getvalue()

    def test_the_identity_comes_from_the_embedded_source_and_title(self) -> None:
        glb = self.convert("aig_Some_Title-1a2b3c4d.glb", {"source": "aig", "livery_title": "Some Title"})
        self.assertEqual(lookup.read_livery_identity(glb), {"source": "aig", "livery_title": "Some Title"})

    def test_a_glb_without_embedded_metadata_has_no_identity_and_the_lookup_fails(self) -> None:
        glb = self.convert("aig_Some_Title-1a2b3c4d.glb", None)
        self.assertIsNone(lookup.read_livery_identity(glb))
        code, out = self.run_main("--community", str(self.community), str(glb))
        self.assertEqual(code, 1)
        self.assertIn("liveryTitle", out)

    def test_a_glb_without_host_paths_is_looked_up_by_its_embedded_title(self) -> None:
        glb = self.convert("aig_Some_Title-1a2b3c4d.glb", {"source": "aig", "livery_title": "Some Title"})
        with mock.patch.object(lookup, "find_source_for_livery", return_value=None) as find:
            code, _ = self.run_main("--community", str(self.community), str(glb))
        self.assertEqual(code, 1)
        find.assert_called_once_with(self.community, "aig", "Some Title")


if __name__ == "__main__":
    unittest.main()
