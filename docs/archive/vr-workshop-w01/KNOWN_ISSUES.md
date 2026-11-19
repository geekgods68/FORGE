# Known issues and limitations (W0.1)

## Environment

- **Nested repository.** The enclosing git repository is the home directory (`/Users/advikpunugu`). A separate repository was created in this folder; **no commits have been made**, and nothing was staged in the parent.
- **Low disk space.** The host had about 7.5 GB free at the start of the session. `node_modules` is about 190 MB.

## Not yet verified

- **Nothing has run on the Quest.** The XR controller adapter, gamepad button mapping, pointer selection on the panel, proxies, visibility handling and re-entry are all untested on a device.
- The `xr-standard` mapping (trigger = button 0, squeeze = button 1) follows the WebXR Gamepads Module. It is expected, but unconfirmed, for Quest Browser.
- Panel text size and the bench and panel positions are unverified for readability and comfort.

## Behaviour gaps

- The whole project resets on page reload; save/load arrives in W0.2.
- No in-app recenter; the Quest system recenter is relied on.
- Desktop drag moves only on a horizontal plane; height changes need XR grab or a scripted command.
- A desktop click on the part is both "select" and a zero-movement grab; nothing is committed unless the part actually moves.
- Undo and redo are refused while a grab is active, and this isn't explained in the UI beyond the disabled buttons.
- Float32 renderer read-back gives sub-micron noise in committed grab positions (see ARCHITECTURE.md).

## Performance

- Frame timing on the panel is a requestAnimationFrame interval proxy. It is not headset latency or GPU time.
- No headset measurement has been taken.

## Desktop browsers

- **Safari on the Mac and `localhost`.** Workaround: open **`http://127.0.0.1:5173`** on the Mac.
  - **Verified (2026-11-19):**
    - The dev server listened on IPv4 `127.0.0.1:5173`: `curl` returned 200.
    - Nothing listened on IPv6 `[::1]:5173`: `curl` failed to connect.
    - macOS resolved `localhost` to both `::1` and `127.0.0.1`.
    - With `host: 'localhost'`, Vite bound `[::1]` only, so `127.0.0.1` failed. That is not a fix.
  - **Reported by the owner:** Safari could not connect to the local site.
  - **Unverified:** which address Safari tried, and whether or how it falls back. Safari itself was not inspected. The IPv6-only explanation is plausible, not proven.
  - Not engineered further. It does not affect the Quest route, where `adb reverse` forwards to the Mac's port; that is to be verified on the device.
