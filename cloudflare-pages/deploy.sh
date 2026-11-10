#!/bin/sh
# نشر الواجهة + بروكسي الـ API (نفس worker.js) على Cloudflare Pages
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
cp -r ../frontend/. dist/
cp ../worker.js dist/_worker.js
npx wrangler pages deploy --project-name rambfe --branch main --commit-dirty=true --force
