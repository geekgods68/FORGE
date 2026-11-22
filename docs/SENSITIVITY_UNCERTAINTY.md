# Sensitivity and uncertainty (Phase 7)

## One-at-a-time sensitivity (`oatSensitivity`)

From an OAT (or grid) campaign: for each independent numeric variable, the local derivative ∂y/∂x from the levels adjacent to the baseline, the elasticity (x₀/y₀)·∂y/∂x, and the swing (max − min of the condition means) normalised to the total swing across variables. Limitations stated with every result: interactions are not captured; local derivatives describe the model near the baseline only; ranges are the ones chosen by the researcher.

## Interaction (`interactionGrid`)

For a two-variable grid: the matrix of condition means (shown as a heat map). Non-additivity is visible directly; no interaction test is claimed.

## Regression sensitivity (`regressionSensitivity`)

For random / LHS / Monte Carlo campaigns: OLS of the outcome on the standardised inputs → standardised regression coefficients with standard errors, plus R². If R² < 0.7 the result is flagged as only indicative (the response is not well described by a linear model).

## Uncertainty propagation (`uncertaintySummary`)

Monte Carlo over the declared input distributions (uniform, normal, bounded normal, empirical). Reports n, mean, SD, 5 / 50 / 95 % quantiles, a histogram and the relative change of the mean between the first half and the full sample (a simple sampling-convergence indicator). The accompanying statement is explicit: this is the spread of **model outputs given the assumed input distributions** — not measured real-world uncertainty, and it excludes model-form error.

## Numerical convergence (`convergenceStudy`)

Successive refinement of a numerical setting (e.g. physics timestep) on a recorded signal: RMS and max difference between successive levels (resampled onto common times), observed order of convergence, and a verdict:

- `converging`: differences decrease and the last is below the stated threshold;
- `not-converging`: differences decrease but are still above the threshold;
- `stalled`: differences do not decrease monotonically (solver tolerance, saturation, contact events);
- `insufficient-levels`: fewer than three levels.

Measured on the arm (timestep 1/60 → 1/480 s, i.e. 16.7 → 2.08 ms, shoulder angle): RMS differences 4.2e-3 → 1.0e-4 → 5.1e-5 rad; verdict converging at 1e-3 rad. Reference comparison (`referenceComparison`) checks outcomes against analytical values; the RC τ = RC check agrees to 1.3e-5 relative error in the package tests and within 1 % in the browser test.
