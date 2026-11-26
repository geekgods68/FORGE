# Importing electrical designs (SPICE, KiCad)

1. **Data exchange** → choose a SPICE netlist (`.cir/.sp/.spice`), a KiCad netlist (`.net`, from Eeschema _File → Export → Netlist_) or a KiCad PCB (`.kicad_pcb`).
2. Check "connectivity verified": FORGE recompiles the circuit and compares every net with the source.
3. KiCad: review the mapping table. Unmapped parts are never substituted — map them (resistor/capacitor/inductor with a value) or omit them.
4. SPICE: unsupported elements (subcircuits, behavioural sources…) block the import unless you tick **accept a partial import**; they are listed in the import record.
5. If the project already has a circuit, tick **replace the project circuit** (undo restores it). **Insert**.
6. Simulate in Electronics/Simulation mode or create a Research experiment (e.g. vary `electrical.part.R1.resistanceOhm`).
7. **Export** tab → SPICE netlist or FORGE electrical bundle. A PCB import is not an EM, thermal or manufacturing analysis.
