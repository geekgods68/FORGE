# Simulation versus observation

1. Select a recording → **Compare with simulation**. FORGE runs a co-simulation of the current project for the recording's duration and compares the mapped signal (distance: `US1.reported`).
2. Read n, MAE, RMSE, max error, bias, the number of missing observations excluded, and the **best timeline lag** (a synchronisation diagnostic; it is not applied automatically). The residual chart shows simulated − observed.
3. The simulated arm does not know where the real obstacle is: large residuals usually mean the virtual scene differs from the bench (move the obstacle in CAD to match the bench, then compare again).
4. For a calibration or validation claim, use Research mode with an independent physical dataset; agreement with synthetic telemetry proves only that the software path works.
