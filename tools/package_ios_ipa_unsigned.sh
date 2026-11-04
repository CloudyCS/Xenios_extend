#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: tools/package_ios_ipa_unsigned.sh APP_BUNDLE IPA_OUT" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

app_bundle="$1"
ipa_out="$2"

[[ -d "$app_bundle" ]] || { echo "error: app bundle not found: $app_bundle" >&2; exit 1; }
[[ -f "$app_bundle/Info.plist" ]] || { echo "error: Info.plist not found in $app_bundle" >&2; exit 1; }
command -v ditto >/dev/null 2>&1 || { echo "error: ditto is required (run on macOS)" >&2; exit 1; }
command -v /usr/libexec/PlistBuddy >/dev/null 2>&1 || {
  echo "error: /usr/libexec/PlistBuddy is required (run on macOS)" >&2
  exit 1
}

for key in MinimumOSVersion CFBundleSupportedPlatforms DTPlatformName CFBundleExecutable; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$app_bundle/Info.plist" >/dev/null 2>&1 || {
    echo "error: $app_bundle/Info.plist lacks $key" >&2
    exit 1
  }
done

minimum_os="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$app_bundle/Info.plist")"
platform_name="$(/usr/libexec/PlistBuddy -c 'Print :DTPlatformName' "$app_bundle/Info.plist")"
supported_platform="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleSupportedPlatforms:0' "$app_bundle/Info.plist")"
[[ "$platform_name" == "iphoneos" && "$supported_platform" == "iPhoneOS" ]] || {
  echo "error: app bundle is not configured for iPhoneOS" >&2
  exit 1
}
python3 - "$minimum_os" <<'PY'
import sys
try:
  parts = tuple(int(part) for part in sys.argv[1].split("."))
except ValueError:
    raise SystemExit("error: invalid MinimumOSVersion")
version = (parts + (0, 0))[:2]
if version != (18, 0):
  raise SystemExit(f"error: expected MinimumOSVersion 18.0, got {sys.argv[1]}")
PY

executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_bundle/Info.plist")"
[[ -f "$app_bundle/$executable" ]] || {
  echo "error: app executable not found: $app_bundle/$executable" >&2
  exit 1
}

# This workflow must produce an unsigned app. Vendor-signed nested libraries
# may retain their original signatures, but the app bundle itself must not have
# a code-signing resource directory or embedded provisioning profile.
[[ ! -e "$app_bundle/_CodeSignature" ]] || {
  echo "error: app bundle is signed; configure the build with code signing disabled" >&2
  exit 1
}
[[ ! -e "$app_bundle/embedded.mobileprovision" ]] || {
  echo "error: provisioning profiles are not included in this unsigned package" >&2
  exit 1
}

mkdir -p "$(dirname "$ipa_out")"
ipa_dir="$(cd "$(dirname "$ipa_out")" && pwd)"
ipa_out="$ipa_dir/$(basename "$ipa_out")"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/xenios_unsigned_ipa.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/Payload"
ditto "$app_bundle" "$tmp/Payload/$(basename "$app_bundle")"
rm -f "$ipa_out"
(cd "$tmp" && ditto -c -k --sequesterRsrc --keepParent Payload "$ipa_out")

# Verify the archive structure and the app copy without signing or installing it.
verify_dir="$tmp/verify"
mkdir -p "$verify_dir"
ditto -x -k "$ipa_out" "$verify_dir"
[[ -d "$verify_dir/Payload/$(basename "$app_bundle")" ]] || {
  echo "error: IPA does not contain Payload/$(basename "$app_bundle")" >&2
  exit 1
}

printf 'Unsigned IPA: %s\nMinimum iOS: %s\n' "$ipa_out" "$minimum_os"
