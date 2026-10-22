"""Tests that the converter refuses glTF and cfg paths that leave the model's MSFS package."""

import base64
import io
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

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

    def test_texture_folder_with_parent_steps_is_refused_in_discovery(self) -> None:
        escaped = self.community / "evil_tex"
        escaped.mkdir()
        cfg = "[FLTSIM.0]\ntitle=T\ntexture=a\\" + UP_TO_COMMUNITY.replace("/", "\\") + "evil_tex\n"
        (self.aircraft / "aircraft.cfg").write_text(cfg, encoding="utf-8")
        liveries = converter.discover_liveries_in_source(self.aircraft)
        self.assertEqual([livery["livery_title"] for livery in liveries], ["T"])
        real_escaped = os.path.normcase(os.path.realpath(escaped))
        for folder in liveries[0]["texture_dirs"]:
            self.assertNotEqual(os.path.normcase(os.path.realpath(folder)), real_escaped)

    def test_base_container_outside_package_is_skipped(self) -> None:
        outside_model = self.community / "outside_base" / "model"
        outside_model.mkdir(parents=True)
        write_gltf(outside_model / "x.gltf", "t.bin", "ok.png")
        livery_only = self.aircraft.parent / "FSLTL_U"
        livery_only.mkdir()
        cfg = "[GENERAL]\nbase_container=..\\..\\..\\..\\outside_base\n[FLTSIM.0]\ntitle=U\ntexture=\n"
        (livery_only / "aircraft.cfg").write_text(cfg, encoding="utf-8")
        self.assertEqual(converter.discover_liveries_in_source(livery_only), [])

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

    def build_sibling_package(self) -> Path:
        """Creates `other-pkg` beside the package, laid out as a package of its own; returns its model folder."""
        model = self.community / "other-pkg" / "SimObjects" / "Airplanes" / "X" / "model"
        model.mkdir(parents=True)
        (model / "t.bin").write_bytes(SECRET_MARKER * 4)
        write_gltf(model / "x.gltf", "t.bin", "ok.png")
        write_gltf(model / "x_LOD0.gltf", "t.bin", "ok.png")
        return model

    def make_livery_only_aircraft(self, name: str, normal: str) -> Path:
        """Creates an aircraft folder whose only model is a model.cfg `normal=` reference; returns its model folder."""
        aircraft = self.aircraft.parent / name
        model = aircraft / "model.L"
        model.mkdir(parents=True)
        (aircraft / "aircraft.cfg").write_text(f"[FLTSIM.0]\ntitle={name}\ntexture=\n", encoding="utf-8")
        (model / "model.cfg").write_text(f"[models]\nnormal={normal}\n", encoding="utf-8")
        return model

    def symlink_or_skip(self, target: Path, link: Path) -> None:
        link.unlink()
        try:
            os.symlink(target, link)
        except OSError as e:
            self.skipTest(f"this machine refuses file symlinks: {e}")

    def test_model_cfg_normal_into_sibling_package_is_skipped(self) -> None:
        self.build_sibling_package()
        sibling_xml = self.community / "other-pkg" / "SimObjects" / "Airplanes" / "X" / "model" / "x.xml"
        # The outside XML would steer the converter back to a glTF inside the package
        back_inside = UP_TO_COMMUNITY.replace("/", "\\") + "fsltl-traffic-base\\SimObjects\\Airplanes\\FSLTL_T\\model\\t.gltf"
        sibling_xml.write_text(f'<ModelInfo><LODS><LOD minSize="1" ModelFile="{back_inside}"/></LODS></ModelInfo>', encoding="utf-8")
        normal = UP_TO_COMMUNITY.replace("/", "\\") + "other-pkg\\SimObjects\\Airplanes\\X\\model\\x.xml"
        livery_only = self.make_livery_only_aircraft("FSLTL_V", normal).parent
        self.assertEqual(converter.discover_liveries_in_source(livery_only), [])

    def test_model_xml_model_file_into_sibling_package_is_skipped(self) -> None:
        self.build_sibling_package()
        model = self.make_livery_only_aircraft("FSLTL_W", "w.xml")
        model_file = UP_TO_COMMUNITY.replace("/", "\\") + "other-pkg\\SimObjects\\Airplanes\\X\\model\\x.gltf"
        (model / "w.xml").write_text(f'<ModelInfo><LODS><LOD minSize="1" ModelFile="{model_file}"/></LODS></ModelInfo>', encoding="utf-8")
        self.assertEqual(converter.discover_liveries_in_source(model.parent), [])

    def test_gltf_path_in_another_package_is_refused_for_source(self) -> None:
        sibling_gltf = self.build_sibling_package() / "x.gltf"
        error = converter.check_source_paths(self.aircraft, sibling_gltf)
        self.assertIsNotNone(error)
        self.assertIn("outside the package", error)
        self.assertIsNone(converter.check_source_paths(self.aircraft, self.model_dir / "t.gltf"))

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


if __name__ == "__main__":
    unittest.main()
