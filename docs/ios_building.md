# iOS build artifact (iOS 18+)

The repository's iOS app is built with its existing CMake graph, C++/Objective-C++ sources, and Apple toolchain. xtool is not used to compile XeniOS. The GitHub Actions workflow builds an arm64 iPhoneOS target on a macOS runner and publishes an **unsigned IPA** as a workflow artifact.

## Build through GitHub Actions

The focused workflow is `.github/workflows/ios-unsigned.yml`; run it from **Actions → iOS unsigned IPA → Run workflow** or push to `main`. Download the `xenios-ios18-unsigned-ipa` artifact from the completed workflow run. The app bundle is produced by the exact CMake target `xenia-app`; the workflow configures `Ninja Multi-Config`, iPhoneOS, arm64, and `CMAKE_OSX_DEPLOYMENT_TARGET=18.0`, disables the optional iOS 27 crash-reporter extension and app-target signing, then packages the bundle. It checks the IPA's bundle metadata, arm64 executable, embedded Metal Shader Converter library, and archive contents. With the Ninja generator, no signing commands are part of the build graph.

The workflow runs `./xenia-build.py fetchdata`, which supplies the game patches, SDL controller database, x360db data, and compatibility data required by the app target. Repository assets and icon catalogs are included by CMake; `cmake/ios/Assets.cmake` invokes `xcrun actool` during the build. The workflow also needs Apple's iPhoneOS SDK, the Metal toolchain, Slang, a native `xenia-shader-cc`, the macOS Metal Shader Converter from `./xenia-build.py msc`, and a separate arm64 iPhoneOS Metal Shader Converter library. These steps run on macOS; this workflow does not provide a Linux-only iOS compiler.

## What unsigned means

The IPA packaging script only places the completed app under `Payload/` and archives it. It does not run `codesign`, add a provisioning profile, or embed the requested app entitlements. A valid archive is not the same as a signed/installed app. Sideload it using your chosen workflow; do not assume the artifact can be installed directly by iOS.

Some vendor-provided nested libraries may carry their own upstream signature. That is distinct from signing the XeniOS app bundle. The packaging check rejects an app-level `_CodeSignature` directory and any embedded provisioning profile.

## LiveContainer and JIT caveat

LiveContainer execution is a separate, device-side test. XeniOS uses an ARM64 JIT and checks for JIT/debug state and increased-memory entitlement at runtime. LiveContainer does not automatically apply a guest app's requested entitlements, so this unsigned artifact cannot guarantee that JIT works or that the increased-memory limit is granted. Use a JIT enabler compatible with the device's iOS version and check XeniOS's JIT and memory status before attempting a game.

The iOS 27 crash-reporter extension is excluded because it is not required by the main app and is not appropriate for an iOS 18 deployment artifact. iOS 27 State Reporting is compiled only when the SDK provides its header and is guarded at runtime; older OS versions skip it.

## Touch controls

The app already includes a multi-touch virtual controller, editable/saved layouts, and automatic touch-overlay fallback when a physical gameplay controller is absent. After loading the IPA in LiveContainer, verify touch controls during gameplay, multiple simultaneous touches, layout editing, physical-controller connection/disconnection, and touch visibility behavior. This CI job does not run an iPhone or LiveContainer emulator test.
