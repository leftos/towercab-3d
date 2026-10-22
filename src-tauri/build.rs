//! Build script for the Tauri app.
//!
//! `TC3D_CHECK_BUILD=1` makes a `cargo check`, `cargo clippy` or `cargo test` build work without
//! `dist/` and `resources/fsltl_converter.exe`, the gitignored build outputs a fresh worktree lacks:
//! it empties `bundle.resources` through a `TAURI_CONFIG` merge patch, so `tauri_build` copies no
//! resources. Unset (or any other value), the build is unchanged.

const CHECK_BUILD_VAR: &str = "TC3D_CHECK_BUILD";

fn main() {
    println!("cargo:rerun-if-env-changed={CHECK_BUILD_VAR}");
    if std::env::var_os(CHECK_BUILD_VAR).is_some_and(|value| value == "1") {
        apply_check_build();
    }
    tauri_build::build()
}

fn apply_check_build() {
    if !tauri_build::is_dev() {
        panic!("{CHECK_BUILD_VAR}=1 is for cargo check, clippy and test only; unset it for tauri build or bundling.");
    }
    let mut config = match std::env::var("TAURI_CONFIG") {
        Ok(existing) => match serde_json::from_str::<serde_json::Value>(&existing) {
            Ok(value @ serde_json::Value::Object(_)) => value,
            _ => panic!("TAURI_CONFIG is not a JSON object, so {CHECK_BUILD_VAR}=1 cannot merge into it: {existing}"),
        },
        Err(std::env::VarError::NotPresent) => serde_json::json!({}),
        Err(std::env::VarError::NotUnicode(_)) => panic!("TAURI_CONFIG is not valid Unicode, so {CHECK_BUILD_VAR}=1 cannot merge into it"),
    };
    config["bundle"]["resources"] = serde_json::json!([]);
    std::env::set_var("TAURI_CONFIG", config.to_string());
}
