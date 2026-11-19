# W0.1 headset test: owner checklist

Run this after headset access works (see HEADSET_ACCESS.md). Record what you **observe**; leave blank anything you didn't do. Remove the headset if you feel discomfort. The virtual room does **not** define a safe physical play area; use the Quest Guardian/boundary and clear the space.

## Record first (VR-01)

| Item | Value |
|---|---|
| Date | |
| Quest 2 OS version (Settings → System → About) | |
| Quest Browser version | |
| Controllers: both tracked? Battery level? Any drift or stuck buttons? | |
| Connection route used (A / B / C) | |
| Seated or standing; chair height approximate | |
| Build: `git rev-parse --short HEAD`, or the date of the files if uncommitted | |

## Steps

| # | Do | Expect | Observed (fill in) |
|---|---|---|---|
| 1 | Open the URL in Quest Browser | The 2D page shows "Immersive VR available" and "Enter VR" is enabled | |
| 2 | Press Enter VR (VR-03) | The immersive session starts; you are seated facing the bench, with the wall panel ahead | |
| 3 | Look at the wall panel (VR-05) | Title, status, part info and buttons are readable without leaning; note any blur or strain | |
| 4 | Point at the orange part | Ray visible; the part highlights while hovered | |
| 5 | Trigger on the part | Selection outline appears; the panel says "Selected" | |
| 6 | Hold grip on the part, move and rotate the controller, release (VR-04) | The part follows, keeping its offset; on release it stays; the panel shows undo count +1 | |
| 7 | Press Undo, then Redo, on the panel | The part returns, then moves back | |
| 8 | Press Reset part | The part returns to its home position on the bench | |
| 9 | Grab the part, then press the Meta/Oculus button or remove the headset mid-grab | The grab is cancelled; no partial move is committed | |
| 10 | Grab, then switch that controller off or put it down until tracking is lost | The grab is cancelled; the other controller still works | |
| 11 | Press Exit VR on the panel; then Enter VR again | Re-entry works; still exactly one part; no duplicate controller proxies | |
| 12 | Repeat 2–11 a second time | Same results | |
| 13 | Comfort: duration, any nausea, eye strain or neck strain; is the bench height comfortable? | Your words | |
| 14 | Note the panel's "Frame interval" line, and any visible stutter (VR-06) | Note: the panel number is a rAF proxy, **not** headset latency | |

## Not covered by this test

- Accuracy of physical positions.
- Room-scale walking.
- Hand tracking.
- Text entry.
- Electronics.
- Persistence: there is no save yet; reloading restores the initial layout.
