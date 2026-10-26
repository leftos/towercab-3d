"""Tests that the converter refuses glTF and cfg paths that leave the model's MSFS package."""

import base64
import builtins
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import convert_fsltl_batch as converter

if os.name == "nt":
    import _winapi

SECRET_MARKER = b"TC3D-270-SECRET-MARKER"
SECRET_COLOUR = (12, 34, 56)
OK_COLOUR = (200, 100, 50)
PLACEHOLDER_COLOUR = (255, 0, 255)
UP_TO_COMMUNITY = "../../../../../"


def write_png(path: Path, colour: tuple[int, int, int]) -> None:
    """Writes a 4x4 PNG of one solid colour."""
    Image.new("RGB", (4, 4), colour).save(path, format="PNG")


def write_gltf(path: Path, buffer_uri: str, image_uri: str) -> None:
    """Writes a minimal glTF with one buffer and one image."""
    gltf = {
        "asset": {"version": "2.0"},
        "buffers": [{"uri": buffer_uri, "byteLength": 4}],
        "bufferViews": [],
        "images": [{"uri": image_uri}],
    }
    path.write_text(json.dumps(gltf), encoding="utf-8")


def build_package(parent: Path) -> Path:
    """Creates `fsltl-traffic-base` with one aircraft folder under `parent` and returns the aircraft folder."""
    aircraft = parent / "fsltl-traffic-base" / "SimObjects" / "Airplanes" / "FSLTL_T"
    (aircraft / "model").mkdir(parents=True)
    (aircraft / "TEXTURE").mkdir()
    (aircraft / "model" / "t.bin").write_bytes(b"\0\0\0\0")
    write_png(aircraft / "TEXTURE" / "ok.png", OK_COLOUR)
    write_gltf(aircraft / "model" / "t.gltf", "t.bin", "ok.png")
    return aircraft


def read_glb(path: Path) -> tuple[dict, bytes]:
    """Splits a GLB into its JSON document and its binary chunk."""
    data = path.read_bytes()
    json_length = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + json_length])
    bin_start = 20 + json_length
    bin_length = struct.unpack_from("<I", data, bin_start)[0]
    return gltf, data[bin_start + 8 : bin_start + 8 + bin_length]


def embedded_colours(path: Path) -> list[tuple[int, int, int]]:
    """The top-left colour of every image embedded in a GLB."""
    gltf, binary = read_glb(path)
    colours = []
    for image in gltf.get("images", []):
        view = gltf["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        decoded = Image.open(io.BytesIO(binary[start : start + view["byteLength"]])).convert("RGB")
        colours.append(decoded.getpixel((0, 0)))
    return colours


class ConverterPathTests(unittest.TestCase):
    """Crafted glTF and cfg text must never bring a file from outside the package into the output."""

    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.community = self.base / "Community"
        self.aircraft = build_package(self.community)
        self.model_dir = self.aircraft / "model"
        self.texture_dir = self.aircraft / "TEXTURE"
        self.output_dir = self.base / "out"
        self.output = self.output_dir / "model.glb"
        self.secret_bin = self.community / "secret.bin"
        self.secret_bin.write_bytes(SECRET_MARKER * 4)
        write_png(self.community / "secret.png", SECRET_COLOUR)
        self.secret_textures = self.community / "secret_tex"
        self.secret_textures.mkdir()
        write_png(self.secret_textures / "ok.png", SECRET_COLOUR)

    def convert(self, buffer_uri: str = "t.bin", image_uri: str = "ok.png", texture_dirs: list[Path] | None = None) -> dict:
        gltf_path = self.model_dir / "crafted.gltf"
        write_gltf(gltf_path, buffer_uri, image_uri)
        dirs = [self.texture_dir] if texture_dirs is None else texture_dirs
        return converter.convert_single_gltf(gltf_path, self.output, dirs)

    def assert_no_secret(self) -> None:
        if not self.output_dir.exists():
            return
        for path in self.output_dir.rglob("*"):
            if not path.is_file():
                continue
            self.assertNotIn(SECRET_MARKER, path.read_bytes())
            if path.suffix == ".glb":
                self.assertNotIn(SECRET_COLOUR, embedded_colours(path))

    def assert_refused(self, pattern: str, **kwargs: str) -> None:
        with self.assertRaisesRegex(ValueError, pattern):
            self.convert(**kwargs)
        self.assert_no_secret()

    def test_buffer_uri_with_parent_steps_is_refused(self) -> None:
        self.assert_refused("buffer 0", buffer_uri=UP_TO_COMMUNITY + "secret.bin")

    def test_absolute_buffer_uris_are_refused(self) -> None:
        for uri in (str(self.secret_bin), "\\\\?\\" + str(self.secret_bin), self.secret_bin.as_uri()):
            with self.subTest(uri=uri):
                self.assert_refused("buffer 0", buffer_uri=uri)

    def test_stream_and_device_buffer_uris_are_refused(self) -> None:
        if os.name == "nt":
            with open(self.model_dir / "t.bin:ads", "wb") as stream:
                stream.write(SECRET_MARKER)
        for uri in ("t.bin:ads", "CON", "con.bin", "LPT1"):
            with self.subTest(uri=uri):
                self.assert_refused("buffer 0", buffer_uri=uri)

    def test_trailing_dot_and_space_buffer_uris_are_refused(self) -> None:
        for uri in ("t.bin.", "t.bin "):
            with self.subTest(uri=uri):
                self.assert_refused("buffer 0", buffer_uri=uri)

    def test_image_uri_with_parent_steps_fails_the_model(self) -> None:
        self.assert_refused("image 0", image_uri=UP_TO_COMMUNITY + "secret.png")

    def test_data_image_uri_is_refused(self) -> None:
        encoded = base64.b64encode((self.community / "secret.png").read_bytes()).decode("ascii")
        self.assert_refused("image 0", image_uri="data:image/png;base64," + encoded)

    @unittest.skipUnless(os.name == "nt", "directory junctions are a Windows feature")
    def test_buffer_through_junction_is_refused(self) -> None:
        _winapi.CreateJunction(str(self.community), str(self.model_dir / "junction"))
        self.assert_refused("buffer 0", buffer_uri="junction/secret.bin")

    @unittest.skipUnless(os.name == "nt", "directory junctions are a Windows feature")
    def test_texture_dir_junction_outside_package_is_dropped(self) -> None:
        junction = self.aircraft / "TEXTURE.J"
        _winapi.CreateJunction(str(self.secret_textures), str(junction))
        result = self.convert(texture_dirs=[junction])
        self.assertTrue(result["success"])
        self.assertEqual(embedded_colours(self.output), [PLACEHOLDER_COLOUR])
        self.assert_no_secret()

    def test_texture_dir_outside_package_is_dropped(self) -> None:
        result = self.convert(texture_dirs=[self.secret_textures])
        self.assertTrue(result["success"])
        self.assertEqual(embedded_colours(self.output), [PLACEHOLDER_COLOUR])
        self.assert_no_secret()

    def test_model_outside_any_package_fails_with_root_error(self) -> None:
        loose_model = self.base / "loose" / "model"
        loose_model.mkdir(parents=True)
        (loose_model / "t.bin").write_bytes(b"\0\0\0\0")
        write_gltf(loose_model / "t.gltf", "t.bin", "ok.png")
        with self.assertRaisesRegex(ValueError, "SimObjects/Airplanes"):
            converter.convert_single_gltf(loose_model / "t.gltf", self.output, [])
        self.assertFalse(self.output.exists())

    @unittest.skipUnless(os.name == "nt", "directory junctions are a Windows feature")
    def test_package_behind_junction_converts(self) -> None:
        store_aircraft = build_package(self.base / "store")
        linked_community = self.base / "Community2"
        linked_community.mkdir()
        package = store_aircraft.parents[2]
        _winapi.CreateJunction(str(package), str(linked_community / package.name))
        aircraft = linked_community / package.name / "SimObjects" / "Airplanes" / "FSLTL_T"
        result = converter.convert_single_gltf(aircraft / "model" / "t.gltf", self.output, [aircraft / "TEXTURE"])
        self.assertTrue(result["success"])
        self.assertEqual(embedded_colours(self.output), [OK_COLOUR])

    def symlink_or_skip(self, target: Path, link: Path) -> None:
        link.unlink()
        try:
            os.symlink(target, link)
        except OSError as e:
            self.skipTest(f"this machine refuses file symlinks: {e}")

    @unittest.skipUnless(os.name == "nt", "directory junctions are a Windows feature")
    def test_model_folder_junction_outside_package_is_refused(self) -> None:
        outside_model = self.community / "outside_model"
        outside_model.mkdir()
        outside_gltf = {"asset": {"version": "2.0", "generator": SECRET_MARKER.decode("ascii")}, "buffers": [{"byteLength": 0}], "bufferViews": []}
        (outside_model / "j.gltf").write_text(json.dumps(outside_gltf), encoding="utf-8")
        aircraft = self.aircraft.parent / "FSLTL_J"
        aircraft.mkdir()
        _winapi.CreateJunction(str(outside_model), str(aircraft / "model"))
        with self.assertRaisesRegex(ValueError, "outside its package"):
            converter.convert_single_gltf(aircraft / "model" / "j.gltf", self.output, [])
        self.assert_no_secret()

    def test_buffer_file_symlink_outside_package_fails_the_model(self) -> None:
        self.symlink_or_skip(self.secret_bin, self.model_dir / "t.bin")
        self.assert_refused("buffer 0")

    def test_texture_file_symlink_outside_package_falls_back_to_placeholder(self) -> None:
        self.symlink_or_skip(self.community / "secret.png", self.texture_dir / "ok.png")
        result = self.convert()
        self.assertTrue(result["success"])
        self.assertEqual(embedded_colours(self.output), [PLACEHOLDER_COLOUR])
        self.assert_no_secret()

    @unittest.skipUnless(os.name == "nt", "directory junctions are a Windows feature")
    def test_only_a_whole_package_junction_is_followed(self) -> None:
        """A junction on the package folder converts (test_package_behind_junction_converts); one on SimObjects or Airplanes alone is refused."""
        store_package = build_package(self.base / "store").parents[2]
        for linked in ("SimObjects", "Airplanes"):
            with self.subTest(linked=linked):
                mirror = self.base / f"mirror-{linked}" / store_package.name
                above = mirror if linked == "SimObjects" else mirror / "SimObjects"
                above.mkdir(parents=True)
                real = store_package / "SimObjects" if linked == "SimObjects" else store_package / "SimObjects" / "Airplanes"
                _winapi.CreateJunction(str(real), str(above / linked))
                gltf = mirror / "SimObjects" / "Airplanes" / "FSLTL_T" / "model" / "t.gltf"
                self.assertTrue(gltf.exists())
                with self.assertRaisesRegex(ValueError, "outside its package"):
                    converter.convert_single_gltf(gltf, self.output, [])

    def test_bare_name_model_converts(self) -> None:
        result = self.convert()
        self.assertTrue(result["success"])
        self.assertEqual(embedded_colours(self.output), [OK_COLOUR])


class ConverterAtomicWriteTests(unittest.TestCase):
    """A failed or interrupted conversion leaves no partial GLB and no temp file behind."""

    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.aircraft = build_package(self.base / "Community")
        self.output_dir = self.base / "out"
        self.output = self.output_dir / "model.glb"

    def convert(self) -> dict:
        return converter.convert_single_gltf(
            self.aircraft / "model" / "t.gltf", self.output, [self.aircraft / "TEXTURE"]
        )

    def output_names(self) -> list[str]:
        if not self.output_dir.exists():
            return []
        return sorted(path.name for path in self.output_dir.iterdir())

    def test_failed_write_leaves_no_glb_and_no_temp(self) -> None:
        real_open = builtins.open

        class FailingHandle:
            """Fails every write after the first, as a full disk would."""

            def __init__(self, handle: io.BufferedWriter) -> None:
                self.handle = handle
                self.writes = 0

            def write(self, data: bytes) -> int:
                self.writes += 1
                if self.writes > 1:
                    raise OSError("simulated disk full")
                return self.handle.write(data)

            def __enter__(self) -> "FailingHandle":
                return self

            def __exit__(self, *exc_info: object) -> bool:
                self.handle.close()
                return False

        def failing_open(path, mode: str = "r", *args, **kwargs):
            handle = real_open(path, mode, *args, **kwargs)
            return FailingHandle(handle) if "w" in mode else handle

        with mock.patch("builtins.open", failing_open):
            with self.assertRaises(OSError):
                self.convert()
        self.assertFalse(self.output.exists())
        self.assertEqual(self.output_names(), [])

    def test_successful_convert_leaves_only_the_glb(self) -> None:
        result = self.convert()
        self.assertTrue(result["success"])
        self.assertEqual(self.output_names(), ["model.glb"])

    def test_stale_temps_are_swept_and_fresh_ones_kept(self) -> None:
        self.output_dir.mkdir(parents=True)
        stale = self.output_dir / ".old.glb.111.tmp"
        fresh = self.output_dir / ".new.glb.222.tmp"
        notes = self.output_dir / ".notes.txt"
        plain_tmp = self.output_dir / "old.tmp"
        for path in (stale, fresh, notes, plain_tmp):
            path.write_bytes(b"x")
        two_hours_ago = time.time() - 2 * 60 * 60
        for path in (stale, notes, plain_tmp):
            os.utime(path, (two_hours_ago, two_hours_ago))
        converter.sweep_stale_temp_files(self.output_dir)
        untouched = sorted([fresh.name, notes.name, plain_tmp.name])
        self.assertEqual(self.output_names(), untouched)


class ConverterJobTests(unittest.TestCase):
    """The converter converts what a JSON job names, writes each GLB at the job's output path and reports in a result file."""

    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.aircraft = build_package(self.base / "Community")
        self.output_dir = self.base / "out"
        self.output_dir.mkdir()
        self.job_path = self.base / "job.json"
        self.result_path = self.base / "result.json"

    def job(self, liveries: list[dict]) -> dict:
        return {
            "version": 1,
            "source": "fsltl",
            "texture_scale": "1k",
            "gltf_path": str(self.aircraft / "model" / "t.gltf"),
            "texture_dirs": [str(self.aircraft / "TEXTURE")],
            "liveries": liveries,
        }

    def run_job(self, job: dict) -> tuple[int, dict]:
        self.job_path.write_text(json.dumps(job), encoding="utf-8")
        code = converter.main(["--job", str(self.job_path), "--result", str(self.result_path)])
        return code, json.loads(self.result_path.read_text(encoding="utf-8"))

    def output_names(self) -> list[str]:
        return sorted(path.name for path in self.output_dir.iterdir())

    def test_a_one_livery_job_writes_the_glb_at_its_output_and_reports_it(self) -> None:
        output = str(self.output_dir / "fsltl_T-0123abcd.glb")
        code, result = self.run_job(self.job([{"title": "T", "output": output}]))
        self.assertEqual(code, 0)
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["outputs"], [{"title": "T", "path": output, "ok": True, "error": None}])
        self.assertEqual(result["errors"], [])
        self.assertEqual(self.output_names(), ["fsltl_T-0123abcd.glb"])
        extras = read_glb(Path(output))[0]["asset"]["extras"]["towercab3d"]
        self.assertEqual((extras["source"], extras["liveryTitle"]), ("fsltl", "T"))

    def test_a_job_of_another_version_exits_2_with_an_error(self) -> None:
        job = self.job([{"title": "T", "output": str(self.output_dir / "fsltl_T.glb")}])
        job["version"] = 2
        code, result = self.run_job(job)
        self.assertEqual(code, 2)
        self.assertIn("version", " ".join(result["errors"]))
        self.assertEqual(self.output_names(), [])

    def test_a_job_without_liveries_exits_2_with_an_error(self) -> None:
        job = self.job([])
        del job["liveries"]
        code, result = self.run_job(job)
        self.assertEqual(code, 2)
        self.assertIn("liveries", " ".join(result["errors"]))

    def test_an_output_that_is_not_a_plain_glb_name_is_refused(self) -> None:
        outputs = [
            str(self.output_dir / "..\\evil.glb"),
            str(self.output_dir / ".hidden.glb"),
            str(self.output_dir / "a:b.glb"),
            "x.glb",
        ]
        code, result = self.run_job(self.job([{"title": f"T{n}", "output": out} for n, out in enumerate(outputs)]))
        self.assertEqual(code, 1)
        self.assertEqual([entry["ok"] for entry in result["outputs"]], [False] * len(outputs))
        self.assertTrue(all(entry["error"] for entry in result["outputs"]))
        self.assertEqual(self.output_names(), [])
        self.assertFalse((self.base / "evil.glb").exists())
        self.assertEqual(sorted(path.name for path in self.base.iterdir()), ["Community", "job.json", "out", "result.json"])

    def test_a_two_livery_job_with_one_failure_exits_1_and_reports_both(self) -> None:
        blocker = self.output_dir / "blocker"
        blocker.write_bytes(b"a file where a folder is needed")
        good = str(self.output_dir / "fsltl_Good-00000001.glb")
        bad = str(blocker / "fsltl_Bad-00000002.glb")
        code, result = self.run_job(self.job([{"title": "Good", "output": good}, {"title": "Bad", "output": bad}]))
        self.assertEqual(code, 1)
        self.assertEqual([(entry["title"], entry["ok"]) for entry in result["outputs"]], [("Good", True), ("Bad", False)])
        self.assertTrue(Path(good).is_file())
        self.assertEqual(len(result["errors"]), 1)
        self.assertTrue(result["errors"][0].startswith("Bad: "))

    def run_job_on_a_cp1252_console(self, job: dict) -> tuple[int, dict]:
        """Run `job` in a converter process whose piped stdout and stderr default to cp1252."""
        self.job_path.write_text(json.dumps(job), encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, converter.__file__, "--job", str(self.job_path), "--result", str(self.result_path)],
            env={**os.environ, "PYTHONIOENCODING": "cp1252"},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertTrue(self.result_path.is_file(), completed.stderr.decode("utf-8", errors="replace"))
        return completed.returncode, json.loads(self.result_path.read_text(encoding="utf-8"))

    def test_a_title_outside_the_console_code_page_converts_with_piped_output(self) -> None:
        title = "Airbus A320 → Łódź"
        output = str(self.output_dir / "fsltl_Airbus_A320_Lodz-00000003.glb")
        code, result = self.run_job_on_a_cp1252_console(self.job([{"title": title, "output": output}]))
        self.assertEqual(code, 0)
        self.assertEqual(result["outputs"], [{"title": title, "path": output, "ok": True, "error": None}])

    def test_a_refused_title_outside_the_console_code_page_is_reported(self) -> None:
        title = "Airbus A320 → Łódź"
        code, result = self.run_job_on_a_cp1252_console(self.job([{"title": title, "output": "x.glb"}]))
        self.assertEqual(code, 1)
        self.assertEqual(len(result["errors"]), 1)
        self.assertTrue(result["errors"][0].startswith(f"{title}: "), result["errors"])


if __name__ == "__main__":
    unittest.main()
