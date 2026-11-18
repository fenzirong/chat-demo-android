#!/usr/bin/env bash
# 一键构建 chat-demo 的 Android APK
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 1/3 构建前端静态资源"
pnpm install --frozen-lockfile
pnpm build

echo "==> 2/3 拷贝到 Android assets"
rm -rf android/app/src/main/assets/www
mkdir -p android/app/src/main/assets/www
cp -a dist/. android/app/src/main/assets/www/

echo "==> 3/3 编译 APK"
cd android
if [ ! -f local.properties ] && [ -n "${ANDROID_HOME:-}" ]; then
  echo "sdk.dir=$ANDROID_HOME" > local.properties
fi
VERSION="$(node -p "require('../package.json').version")"
./gradlew --no-daemon -PwebVersionName="$VERSION" assembleRelease

echo
echo "APK: $ROOT/android/app/build/outputs/apk/release/app-release.apk"
