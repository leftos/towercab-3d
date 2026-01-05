#!/bin/bash
# Test script to simulate dependabot CI build (without vNAS or signing secrets)
# Run from project root: bash scripts/test-dependabot-build.sh

set -e

echo "=== Testing dependabot-style build (no vNAS, no signing) ==="

# Create a temporary worktree
TEMP_DIR=$(mktemp -d)
WORKTREE_DIR="$TEMP_DIR/towercab-test"

echo "Creating temporary worktree at $WORKTREE_DIR..."
git worktree add "$WORKTREE_DIR" HEAD --detach

cd "$WORKTREE_DIR"

echo ""
echo "=== Applying vNAS removal ==="
cd src-tauri
sed -i '/towercab-3d-vnas.*git.*Leftos/d' Cargo.toml
sed -i 's/vnas = \["dep:towercab-3d-vnas"\]/vnas = []/' Cargo.toml
echo "Removed vNAS from Cargo.toml"

echo ""
echo "=== Regenerating Cargo.lock ==="
cargo generate-lockfile
echo "Regenerated Cargo.lock"

echo ""
echo "=== Applying updater removal ==="
sed -i '/tauri-plugin-updater/d' Cargo.toml
sed -i '/"updater:default"/d' capabilities/desktop.json
sed -i '/Register updater plugin/,/tauri_plugin_updater/d' src/lib.rs
node -e "
  const fs = require('fs');
  const config = JSON.parse(fs.readFileSync('tauri.conf.json', 'utf8'));
  delete config.plugins.updater;
  fs.writeFileSync('tauri.conf.json', JSON.stringify(config, null, 2));
"
echo "Removed updater plugin"

echo ""
echo "=== Showing modified files ==="
echo "Cargo.toml (vnas line should be gone):"
grep -n "towercab-3d-vnas\|vnas = " Cargo.toml || echo "  (no vnas references - good!)"
echo ""
echo "Cargo.toml (updater line should be gone):"
grep -n "tauri-plugin-updater" Cargo.toml || echo "  (no updater references - good!)"
echo ""
echo "capabilities/desktop.json:"
cat capabilities/desktop.json
echo ""
echo "lib.rs updater references:"
grep -n "updater" src/lib.rs || echo "  (no updater references - good!)"
echo ""
echo "tauri.conf.json plugins:"
node -e "const c=JSON.parse(require('fs').readFileSync('tauri.conf.json'));console.log(JSON.stringify(c.plugins,null,2))"

cd "$WORKTREE_DIR"

echo ""
echo "=== Building frontend ==="
npm ci
npm run vite:build

echo ""
echo "=== Building Tauri app ==="
npm run tauri build -- --target x86_64-pc-windows-msvc

echo ""
echo "=== Build successful! ==="

# Cleanup
cd /
git worktree remove "$WORKTREE_DIR" --force
rm -rf "$TEMP_DIR"
echo "Cleaned up temporary worktree"
