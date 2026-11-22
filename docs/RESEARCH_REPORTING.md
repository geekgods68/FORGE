# Research reporting (Phase 7)

`generateReport(document, experimentId, { missingData })` → `{ markdown, json }`; `outcomesCsv()`; `exportExperiment()`.

## Report sections (Markdown)

1. Research question · 2. Hypothesis (with a conservative assessment) · 3. Model description (project, fingerprint, model kind, software versions, RNG) · 4. Assumptions · 5. Experimental design · 6. Variables and controls · 7. Simulation settings · 8. Results (per-condition tables from run records) · 9. Statistical analysis · 10. Numerical verification · 11. Validation status · 12. Limitations · 13. Conclusions (only researcher-written conclusion notes) · 14. Notebook · 15. Reproduction instructions.

The JSON report carries the same run-level data (ids, conditions, seeds, config hashes, outcomes, integrity hashes), the validation status, the hypothesis assessment and an `incomplete` flag.

## Restraint rules

- Everything in Results comes from stored run records; nothing is generated, smoothed or imputed.
- The hypothesis assessment says only whether condition means move consistently in the predicted direction **within the model and tested range**: "supports the hypothesis for the model only; it does not prove it, and it is not evidence about the physical system unless validated." It uses only the conditions in which every other independent variable is at its default (so one-at-a-time sweeps of other variables are not mixed in); numeric variables are ordered by value, categorical ones along their declared level order (stated in the text).
- Conclusions are never auto-written: the section is empty unless the researcher writes conclusion notes.
- Limitations always include: results describe the model, not the physical system; no universal accuracy is claimed.
- Failed, cancelled and interrupted runs are listed, not hidden. Mixed experiment revisions or model fingerprints across runs are called out.
- Missing raw data marks the report **Incomplete** with the affected runs.

## Exports

| Export                                         | Content                                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Report Markdown / JSON                         | as above                                                                                                                                      |
| Outcomes CSV                                   | one row per run: id, condition, replicate, state, seed, config hash, variable values, outcomes with units in the header; empty cell = missing |
| Experiment bundle (`forge-research-export` v1) | protocol, run records, related dataset/calibration/validation records, optional raw data (base64 Float64) — re-verified on import             |
