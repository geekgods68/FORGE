# Headset access

**Current state (2026-11-19):**
- The owner **approved Option A** (USB + `adb reverse`) and the official Platform-Tools. Wireless ADB is not approved.
- **Platform-Tools installed:** adb `37.0.1-15733141`, in `~/Library/Android/sdk/platform-tools/` (user-owned; no sudo, Homebrew or PATH change).
  - Source: Google's official `platform-tools-latest-darwin.zip`.
  - SHA-256 `ee39ad59…a5d1d`.
  - `adb` is code-signed by Developer ID Application: Google LLC (EQHXZ8M8AV), and `codesign --verify` passed.
  - Google's release notes list 37.0.3, but the "latest" archive contained 37.0.1.
- The adb server listens on `127.0.0.1:5037` only.
- The dev server binds to **127.0.0.1 only**. No LAN listener, tunnel, certificate or router port forward exists.
- **Not yet:** device connected, reverse rule created, headset page loaded. VR-02 is pending.

`adb reverse` is **device-to-host** forwarding over the USB debugging link. A connection to `localhost:5173` *on the headset* is carried over the cable to `localhost:5173` on the Mac. It is not router or public port forwarding, and nothing on the LAN or internet can use it.

## Why a LAN HTTP URL is not enough

- The Quest's `localhost` is the headset itself, not the Mac.
- Immersive WebXR requires a **secure context**: HTTPS, or `http://localhost`.
- A plain `http://192.168.x.x:5173` page may load in Quest Browser, but `navigator.xr` is unavailable there. The app would show "Not a secure context".
- A self-signed certificate is not trusted automatically. Clicking through certificate warnings is **not** an acceptable normal workflow.

## Host

macOS 26.5.1, Apple M3 MacBook Air (8 GB RAM). Only one development host is used.

## Option A (recommended): USB cable + `adb reverse`, no network exposure

How it works:
- `adb reverse tcp:5173 tcp:5173` makes `http://localhost:5173` *on the headset* tunnel over the USB debugging connection to the Mac's loopback server.
- `localhost` is a secure context, so WebXR is allowed without any certificate.
- Nothing listens on Wi-Fi or the LAN.

What it needs (owner action and approval):
1. **Quest developer mode.** This needs a free Meta developer account/organisation and the Meta Horizon phone app.
   - It is required for this route only. It is not required just to open web pages.
   - Developer mode lets a connected computer that you authorise install apps and run debug commands on the headset. Turn it off when it isn't needed.
2. **A USB-C data cable** (not charge-only).
3. **Android platform-tools (`adb`) on the Mac.** It is currently **not installed**. I will not install it without your approval. Two options:
   - Google's official platform-tools zip, unpacked to a folder you choose.
   - Homebrew: `brew install --cask android-platform-tools`. This is a global tool install, so it needs explicit approval.

Steps (after approval):
```sh
npm run dev                         # 127.0.0.1:5173
adb devices                         # put on the headset and accept "Allow USB debugging" for this Mac only
adb reverse tcp:5173 tcp:5173
# Quest Browser → http://localhost:5173/  → "Enter VR"
```

To stop or revoke:
```sh
adb reverse --remove tcp:5173       # or: adb reverse --remove-all
adb kill-server
```
Then:
- Unplug the cable.
- Optionally revoke USB debugging authorisations in the headset's developer settings, and turn off developer mode in the Meta Horizon app.

Limitations:
- Not yet verified on your Quest. Your Quest OS and browser versions are unknown.
- Vite's hot-reload websocket also goes over the same reversed port; this is allowed by the CSP.

## Option B (alternative, no developer mode): private LAN HTTPS with a local CA

This changes network exposure, so it **requires explicit approval** before anything is done.
- Serve HTTPS on the Mac's LAN address only, never `0.0.0.0` with open hosts. Vite's `server.allowedHosts` is limited to that address.
- macOS will ask to allow incoming connections for Node. That permission exposes the dev server to every device on the same network while it runs.
- Certificates: a local certificate authority (via `openssl`, already installed, or `mkcert`, not installed) signs a server certificate for the Mac's LAN IP.
  - The private keys stay outside the repository and are git-ignored.
  - The CA certificate must be **installed as trusted on the Quest**. Whether and how Quest OS allows a user CA for Quest Browser is **unverified**, and must be checked against current Meta documentation and your device first.
- To stop or revoke: stop the server; remove the firewall exception; delete the CA from the Quest (and the Mac, if added); delete the key files.

## Option C: Chrome remote debugging port forwarding

`chrome://inspect` → Port forwarding gives the same effect as Option A, and also shows the headset browser console, which is useful for debugging. It also needs developer mode and USB.

## Decision needed from the owner

- Option A, Option B, or neither for now.
- If Option A: confirmation that you will enable developer mode, and how you want `adb` installed (official zip vs Homebrew).
