# Statistical analysis (Phase 7)

`packages/research/src/stats.ts` and `analysis.ts`. All functions are deterministic (resampling uses seeded `mulberry32`). Verified against R 4.x reference outputs in `analysis.test.ts` (e.g. Welch t = 1.8608, df = 17.776, p = 0.07939; paired t = 4.0621, p = 0.002833; Anscombe I slope 0.5001, R² = 0.6665).

## Unit of observation

**One run = one observation.** Samples inside a run are a time series, not independent replicates. Replicates of a deterministic condition are identical and are flagged (`identicalReplicates`); their spread is zero and does not estimate real-world uncertainty. Stochastic models (sensor noise, random inputs) produce genuine run-to-run variation.

## Descriptive

`describe`: n, excluded (missing/non-finite — never zero), mean, variance and SD (n − 1, two-pass), median, quartiles, 5 % and 95 % quantiles (Hyndman–Fan type 7, R's default), min, max. `summarize(runs, measurement)` groups completed runs by condition.

## Comparisons (`compareConditions`)

- Difference of means and medians, relative change, Cohen's d and Hedges' g.
- Inference only when it is meaningful:
  - both conditions deterministic → no test; the difference is exact **for the model**;
  - < 2 runs in either condition → no interval or test;
  - matched seeds in equal numbers → **paired t-test**; otherwise **Welch's t-test** (95 % CI on the difference);
  - two-sided **permutation test** (4,999 permutations, seed 1) as a distribution-free check.
- Notes always state: statistical ≠ engineering significance; small samples (< 5) are imprecise.

## Other tools

Mean with Student-t CI; percentile bootstrap CI (seeded); Pearson and Spearman correlation; ordinary least squares with standard errors, t-values, p-values and R² (`ols`); Wilson interval for proportions (e.g. fraction of runs that saturated); histogram; `rankConditions`; `configDiff` (what actually differs between two runs' configurations, with a warning if more than the intended variable changed, e.g. a different model fingerprint).

## What is not done

No multiple-comparison correction is applied (each comparison is a separate, user-chosen pair; readers running many comparisons must account for that themselves); no Bayesian analysis; no automatic model selection. p-values are reported with the method and its assumptions, never as a verdict on their own.
