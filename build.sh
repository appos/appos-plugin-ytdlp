#!/bin/bash
# Quick build — delegates to build.mjs
set -euo pipefail
cd "$(dirname "$0")"
npx esbuild src/main.ts --bundle --format=iife --target=es2020 --sourcemap --outfile=dist/main.js
