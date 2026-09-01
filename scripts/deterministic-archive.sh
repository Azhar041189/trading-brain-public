#!/usr/bin/env bash
# scripts/deterministic-archive.sh
# Creates deterministic release tarball with normalized timestamps (G-15)

set -e
OUTPUT_FILE="trading-brain-v0.9.0-public-beta.tar.gz"

echo "📦 Creating Deterministic Normalized Release Archive..."

tar --sort=name \
    --mtime='2026-08-31 00:00:00Z' \
    --owner=0 --group=0 --numeric-owner \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='*.db' \
    --exclude='*.sqlite' \
    --exclude='session_state.json' \
    -czf "$OUTPUT_FILE" .

SHA256_HASH=$(sha256sum "$OUTPUT_FILE" | awk '{print $1}')
echo "✅ Deterministic Archive Created: $OUTPUT_FILE"
echo "🔑 Archive SHA256: $SHA256_HASH"
