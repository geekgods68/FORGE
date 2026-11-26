# Recording and replaying telemetry

1. While connected, **Record**; **Stop recording** saves it (IndexedDB, this browser) with a SHA-256 hash. Declarations received before you pressed Record are included, so the recording is self-describing.
2. Recordings from the synthetic adapter are labelled **SYNTHETIC** everywhere and never count as evidence.
3. **Replay** rebuilds the pipeline from the recording: identical samples, statistics and diagnostics every time. A modified recording fails its integrity check.
4. **To Research** turns the measured channels into a Phase 7 dataset (model units; synthetic flag kept) for validation or calibration.
