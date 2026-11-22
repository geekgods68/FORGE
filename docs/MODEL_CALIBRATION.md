# Model calibration (Phase 7)

`calibrate()` in `packages/research/src/verification.ts`.

## Method

Bounded nonlinear least squares: Levenberg–Marquardt with a forward-difference Jacobian and projection onto the user's lower/upper bounds. The residual is (simulated − observed) on the dataset's timestamps for the mapped column ↔ signal pairs (units converted; missing observations excluded). **Each objective evaluation is a full simulation run** of the experiment's model with the candidate values, so calibration cost is (parameters + 1) runs per iteration.

## Output (`CalibrationRecord`)

Nominal and fitted value per parameter with bounds and unit; approximate standard errors from σ²(JᵀJ)⁻¹; residual RMSE/MAE/max; iterations, evaluations, convergence flag; dataset id; identifiability warnings:

- singular information matrix → parameters not identifiable from these data;
- high correlation between parameter estimates;
- a fitted value at a bound (the optimum may lie outside the allowed range).

## Separation from the model and from validation

- The project is **never modified**. Fitted values sit next to nominal values in the research document; applying them to the design is a separate, explicit engineering edit by the user.
- A dataset used for calibration is recorded as such. Any validation against that same dataset is marked `not-independent` and does not count towards validation status (see VALIDATION_FRAMEWORK.md).
- A good calibration fit is not evidence that the model is valid elsewhere.

## Limits

Local optimiser (can stop in a local minimum); small numbers of parameters intended; no global search, no Bayesian posterior.
