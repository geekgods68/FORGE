# Creating a digital twin

1. Open **Library → Open twin sample: VEYRIS arm digital twin** (or a project with the same US1/SV4 parts).
2. **Digital twin** mode → **Create the VEYRIS arm twin**: `d` (HC-SR04 distance, measured, mm → m) and `a` (wrist servo command, **commanded**, deg → rad via the servo model).
3. Mapping problems (wrong unit, a commanded channel mapped as measured, missing component) are listed in the panel and must be fixed in the twin configuration.
4. The badge always says what you are looking at: VIRTUAL MODEL ONLY, SYNTHETIC TELEMETRY, PHYSICAL DEVICE (unverified) or REPLAY.
5. The evidence level rises only with physical recordings, synchronisation quality, a calibration and an independent validation (Research mode).
