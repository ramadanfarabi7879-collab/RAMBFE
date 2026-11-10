#!/bin/sh
# نشر الواجهة + بروكسي الـ API (نفس worker.js) على Cloudflare Pages
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
cp -r ../frontend/. dist/
npx --yes esbuild@0.24.0 ../worker.js --bundle --format=esm --outfile=dist/_worker.js --log-level=warning
npx wrangler pages deploy --project-name rambfe --branch main --commit-dirty=true --force
