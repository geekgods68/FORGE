# Component catalogue (Phases 3–4)

> **Phase 4:** catalogue interfaces are now used as **mate frames** (MECHANICAL_ASSEMBLY.md), and metric thread/clearance descriptors drive dimensional fastener checks. Users can add **custom components from imported GLB/glTF models** to a local library (ASSET_IMPORT.md). These carry no inferred mass, material or interfaces, and are not part of the 401 shipped families. Feature parts (PARAMETRIC_CAD.md) declare face and hole interfaces of their own. The robotic-arm sample moved to `@forge/mechanics`.

The catalogue lives in `@forge/components` (`packages/components`). It is pure data plus generators: nothing is rendered until a part is previewed or placed. The numbers below are generated from the shipped data.

| Measure                          | Count                                                          |
| -------------------------------- | -------------------------------------------------------------- |
| Categories                       | 28                                                             |
| Subcategories                    | 379 (every one has at least one registered family)             |
| Families (component definitions) | 401                                                            |
| Variants and presets             | 191                                                            |
| Tier A / B / C                   | 102 / 172 / 127                                                |
| Named commercial products        | 5 (plus HC-SR04, which is datasheet-cited and has many makers) |
| Materials                        | 29                                                             |

## Tiers

- **A, fully parametric:** editable geometry from real dimensions. Mass is computed from geometry × density when the representation is exact or approximate.
- **B, dimensional model:** recognisable geometry with meaningful overall dimensions, interfaces and metadata. These are envelope models, so geometric mass is not computed; a published mass is shown only when one is cited.
- **C, catalogue entry:** identity, parameters and metadata with an honest generic preview, labelled "Generic preview — not a model of a specific product".

## Data status (provenance of dimensions and specs)

| Status            | Meaning                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `standard`        | Dimensions come from a named public standard (for example ISO 4762, ISO 4032, ISO 7089, ISO 15, NEMA ICS 16, IEC 60086, SEMI M1) |
| `datasheet-cited` | Values transcribed from a cited public document. Not measured or verified by FORGE                                               |
| `generic`         | A representative generic part, never presented as a specific product                                                             |
| `unverified`      | Entered without a cited reference                                                                                                |

Unknown values are `null` and are shown as "unknown", never 0. No Phase 3 family claims any simulation capability: every domain is `unsupported` (see SIMULATION_VALIDITY.md).

## Named or cited products

| Component                         | Id                       | Data status     | References                                                          |
| --------------------------------- | ------------------------ | --------------- | ------------------------------------------------------------------- |
| Raspberry Pi 4 Model B            | `raspberry-pi-4-model-b` | datasheet-cited | Raspberry Pi 4 Model B product brief / mechanical drawing           |
| Raspberry Pi Pico (RP2040)        | `raspberry-pi-pico`      | datasheet-cited | Raspberry Pi Pico datasheet                                         |
| Arduino UNO R3                    | `arduino-uno-r3`         | datasheet-cited | Arduino UNO R3 — product documentation and technical specifications |
| SG90 micro servo                  | `towerpro-sg90`          | datasheet-cited | TowerPro SG90 micro servo datasheet                                 |
| MG996R high-torque servo          | `towerpro-mg996r`        | datasheet-cited | TowerPro MG996R servo datasheet                                     |
| HC-SR04 ultrasonic ranging module | `hc-sr04`                | datasheet-cited | HC-SR04 ultrasonic ranging module user manual / datasheet           |

## Categories

| #   | Category                                 | Identifier                               | Subcategories | Families | Tiers A/B/C | Variants |
| --- | ---------------------------------------- | ---------------------------------------- | ------------- | -------- | ----------- | -------- |
| 1   | Structure & Raw Materials                | `structure-raw-materials`                | 20            | 29       | 26 / 1 / 2  | 36       |
| 2   | Fasteners & Joining                      | `fasteners-joining`                      | 13            | 14       | 6 / 5 / 3   | 76       |
| 3   | Mechanical Motion & Transmission         | `mechanical-motion-transmission`         | 21            | 21       | 4 / 11 / 6  | 23       |
| 4   | Motors & Actuators                       | `motors-actuators`                       | 14            | 17       | 0 / 14 / 3  | 6        |
| 5   | Robotics & Mobility                      | `robotics-mobility`                      | 12            | 14       | 7 / 2 / 5   | 8        |
| 6   | Passive Electronics                      | `passive-electronics`                    | 10            | 12       | 0 / 12 / 0  | 3        |
| 7   | Semiconductors & Integrated Circuits     | `semiconductors-ics`                     | 17            | 17       | 0 / 17 / 0  | 5        |
| 8   | Computing & Microcontrollers             | `computing-microcontrollers`             | 14            | 15       | 0 / 8 / 7   | 0        |
| 9   | Sensors & Measurement Components         | `sensors-measurement`                    | 22            | 22       | 0 / 17 / 5  | 0        |
| 10  | Power & Energy Storage                   | `power-energy-storage`                   | 11            | 12       | 0 / 9 / 3   | 8        |
| 11  | Power Electronics & Electrical Systems   | `power-electronics-electrical`           | 14            | 16       | 0 / 10 / 6  | 0        |
| 12  | Connectors, Wiring & PCBs                | `connectors-wiring-pcbs`                 | 18            | 19       | 6 / 3 / 10  | 5        |
| 13  | Communications & Networking              | `communications-networking`              | 13            | 13       | 0 / 10 / 3  | 0        |
| 14  | Displays & Human Interfaces              | `displays-human-interfaces`              | 14            | 14       | 0 / 11 / 3  | 0        |
| 15  | Optics, Photonics & Imaging              | `optics-photonics-imaging`               | 15            | 15       | 1 / 8 / 6   | 0        |
| 16  | Audio & Acoustics                        | `audio-acoustics`                        | 13            | 13       | 1 / 10 / 2  | 0        |
| 17  | Fluid, Pneumatic & Hydraulic Systems     | `fluid-pneumatic-hydraulic`              | 15            | 15       | 4 / 2 / 9   | 0        |
| 18  | Thermal & Environmental Systems          | `thermal-environmental`                  | 14            | 14       | 3 / 5 / 6   | 4        |
| 19  | Manufacturing & Fabrication Parts        | `manufacturing-fabrication`              | 12            | 12       | 3 / 5 / 4   | 3        |
| 20  | Aerospace, Drones & Propulsion           | `aerospace-drones-propulsion`            | 12            | 12       | 3 / 5 / 4   | 2        |
| 21  | Automation & Industrial Control          | `automation-industrial-control`          | 11            | 11       | 0 / 1 / 10  | 0        |
| 22  | Advanced Materials & Smart Devices       | `advanced-materials-smart-devices`       | 10            | 10       | 3 / 3 / 4   | 0        |
| 23  | Enclosures & Product Design              | `enclosures-product-design`              | 14            | 14       | 8 / 1 / 5   | 3        |
| 24  | Complete Modules & Assemblies            | `complete-modules-assemblies`            | 12            | 12       | 0 / 0 / 12  | 0        |
| 25  | Semiconductor & Microfabrication         | `semiconductor-microfabrication`         | 10            | 10       | 5 / 1 / 4   | 6        |
| 26  | Scientific Test Specimens & Calibration  | `test-specimens-calibration`             | 10            | 10       | 9 / 0 / 1   | 0        |
| 27  | Biomechanics & Soft Robotics             | `biomechanics-soft-robotics`             | 8             | 8        | 4 / 1 / 3   | 0        |
| 28  | Experimental Environments & Test Objects | `experimental-environments-test-objects` | 10            | 10       | 9 / 0 / 1   | 3        |

## Families by subcategory

### 1. Structure & Raw Materials

- **Metal sheets and plates:** Aluminium plate (A, 4 variants); Steel sheet (A, 3 variants); Stainless steel sheet (A)
- **Metal bars and rods:** Round bar (A, 4 variants); Flat / square bar (A, 2 variants)
- **Metal tubes and pipes:** Round tube (A, 3 variants); Rectangular hollow section (A, 2 variants)
- **Aluminium extrusions:** T-slot aluminium extrusion (A, 5 variants)
- **Structural beams and channels:** Structural section (A, 4 variants)
- **Engineering plastics:** Engineering plastic sheet (A); Engineering plastic rod (A)
- **Elastomers and flexible materials:** Elastomer sheet (A)
- **Carbon-fibre composites:** Carbon-fibre plate (A); Carbon-fibre tube (A, 3 variants)
- **Fiberglass and structural composites:** Fibreglass sheet (G10/FR-4 style) (A)
- **Wood and natural materials:** Birch plywood sheet (A)
- **Ceramics, glass and mineral stock:** Alumina ceramic plate (A); Borosilicate glass rod (A)
- **Films, foils and membranes:** Copper foil (A, 2 variants)
- **Meshes and porous materials:** Woven wire mesh (C)
- **Panels and sandwich structures:** Honeycomb sandwich panel (C)
- **Structural brackets and plates:** L-bracket (A, 2 variants); Mounting plate with corner holes (A, 2 variants)
- **Frames, rails and supports:** Support post (square tube) (A)
- **Custom parametric geometry:** Parametric shape (A)
- **Additive manufacturing feedstock:** Filament spool (1 kg class) (B)
- **Specialty metals and alloys:** Titanium plate (Grade 5) (A); Brass rod (A)
- **Laminates and surface layers:** Copper-clad laminate (FR-4) (A)

### 2. Fasteners & Joining

- **Machine screws:** Machine screw (A, 39 variants)
- **Bolts:** Hex head bolt (A, 15 variants)
- **Nuts:** Hex nut (A, 8 variants)
- **Washers:** Plain washer (A, 8 variants)
- **Pins:** Dowel pin (A, 2 variants)
- **Retaining rings:** External retaining ring (generic) (B)
- **Threaded inserts:** Heat-set threaded insert (generic) (B, 2 variants)
- **Rivets:** Blind rivet (generic) (B)
- **Shaft collars:** Shaft collar (A, 2 variants)
- **Permanent joining:** Weld bead marker (C); Solder joint marker (C)
- **Adhesive joining:** Adhesive bond line (C)
- **Quick-release mechanisms:** Quick-release pin (generic) (B)
- **Snap-fit connections:** Cantilever snap-fit hook (B)

### 3. Mechanical Motion & Transmission

- **Spur gears:** Spur gear (A, 5 variants)
- **Helical gears:** Helical gear (B)
- **Bevel gears:** Bevel gear pair (C)
- **Worm gears:** Worm gear set (C)
- **Planetary gears:** Planetary gearbox (C)
- **Rack and pinion:** Gear rack (generic) (B)
- **Shafts:** Precision shaft (A, 7 variants)
- **Bearings:** Deep-groove ball bearing (B, 4 variants)
- **Linear rails:** Miniature linear guide (MGN-style) (B, 3 variants)
- **Lead screws:** Lead screw with nut (T8-style) (B)
- **Ball screws:** Ball screw with nut (generic) (B)
- **Belts:** Timing belt loop (GT2-style) (B)
- **Pulleys:** Timing pulley (GT2-style, approximate) (B, 2 variants)
- **Chains:** Roller chain loop (generic) (B)
- **Sprockets:** Sprocket (approximate) (B)
- **Couplings:** Rigid shaft coupling (A, 2 variants)
- **Springs:** Compression spring (B)
- **Linkages:** Linkage bar (A)
- **Brakes:** Electromagnetic brake (C)
- **Clutches:** Electromagnetic clutch (C)
- **Dampers:** Linear damper (C)

### 4. Motors & Actuators

- **Micro servos:** Micro servo (9 g class, generic) (B); SG90 micro servo (B)
- **Standard servos:** Standard servo (generic) (B)
- **High-torque servos:** High-torque metal-gear servo (generic) (B); MG996R high-torque servo (B)
- **Continuous-rotation servos:** Continuous-rotation servo (generic) (B)
- **Brushed DC motors:** Brushed DC motor (130-size class) (B, 2 variants); DC gear motor (generic) (B)
- **Brushless DC motors:** Brushless DC motor (inrunner, generic) (B)
- **Stepper motors:** Stepper motor (NEMA frame) (B, 4 variants)
- **Linear actuators:** Electric linear actuator (generic) (B)
- **Solenoids:** Push-pull solenoid (generic) (B)
- **Electromagnets:** Holding electromagnet (C)
- **Pneumatic actuators:** Compact pneumatic cylinder (B)
- **Hydraulic actuators:** Small hydraulic cylinder (B)
- **Piezoelectric actuators:** Piezo stack actuator (C)
- **Smart integrated actuators:** Smart serial-bus actuator (generic) (C)

### 5. Robotics & Mobility

- **Robotic arm links:** Robot arm link (A, 3 variants)
- **Robot joints:** Joint hub (horn adapter) (A); Servo mounting bracket (A, 2 variants)
- **Wrist assemblies:** Two-axis wrist (generic) (C)
- **Grippers:** Two-finger parallel gripper (B)
- **Robot chassis:** Robot chassis plate (A, 1 variants); Robot arm base plate (A)
- **Wheels:** Robot wheel (A, 2 variants)
- **Tracks:** Track module (C)
- **Robot legs:** Legged-robot leg (2-DoF) (C)
- **Omnidirectional drive modules:** Omni wheel (B)
- **Mobile robot bases:** Differential-drive base (C)
- **Sensor mounting structures:** Sensor mount bracket (A)
- **Robot accessory modules:** Bumper module (C)

### 6. Passive Electronics

- **Fixed resistors:** Resistor (axial, through-hole) (B, 3 variants); Resistor network (SMD, SOIC) (B)
- **Variable resistors:** Potentiometer (generic) (B)
- **Capacitors:** Electrolytic capacitor (B); Ceramic disc capacitor (B)
- **Inductors:** Radial inductor (B)
- **Ferrites:** Ferrite sleeve bead (B)
- **Crystals:** Quartz crystal (HC-49 style) (B)
- **Resonators:** Ceramic resonator (B)
- **Thermistors:** NTC thermistor (B)
- **Varistors:** Metal-oxide varistor (B)
- **Passive filter networks:** RC filter network board (B)

### 7. Semiconductors & Integrated Circuits

- **Diodes:** Rectifier / signal diode (axial) (B)
- **Transistors:** Bipolar transistor (TO-92) (B)
- **MOSFETs:** Power MOSFET (TO-220) (B)
- **IGBTs:** IGBT (TO-220) (B)
- **Operational amplifiers:** Dual op-amp (DIP-8) (B, 2 variants)
- **Comparators:** Comparator (DIP-8) (B)
- **Logic ICs:** Logic IC (DIP-14) (B)
- **Timers:** Timer IC (DIP-8) (B)
- **Multiplexers:** Analog multiplexer (SOIC-16) (B)
- **Shift registers:** Shift register (DIP-16) (B)
- **ADCs:** ADC (SOIC-16) (B)
- **DACs:** DAC (SOIC-8) (B)
- **Voltage regulators:** Linear regulator (TO-220) (B)
- **Motor driver ICs:** H-bridge driver IC (SOIC-16) (B)
- **Memory ICs:** Serial memory (SOIC-8) (B)
- **Processing ICs:** Microcontroller (QFP) (B, 3 variants)
- **Specialized interface ICs:** USB-to-UART bridge (SOIC-16) (B)

### 8. Computing & Microcontrollers

- **Arduino boards:** Nano-format board (generic) (B); Arduino UNO R3 (B)
- **ESP32 boards:** ESP32 development board (generic) (B)
- **Raspberry Pi boards:** Raspberry Pi 4 Model B (B)
- **STM32 boards:** STM32 development board (generic) (B)
- **RP2040/RP2350 boards:** Raspberry Pi Pico (RP2040) (B)
- **Teensy boards:** Teensy-format board (generic) (B)
- **FPGA boards:** FPGA development board (generic) (C)
- **Single-board computers:** Single-board computer (generic) (C)
- **AI compute modules:** AI compute module + carrier (generic) (C)
- **CPUs:** CPU (generic LGA/QFP envelope) (C)
- **GPUs:** GPU card (generic) (C)
- **Memory modules:** Memory module (DIMM) (C)
- **Storage modules:** M.2 SSD (2280) (C)
- **Expansion boards:** Expansion board / shield (generic) (B)

### 9. Sensors & Measurement Components

- **Ultrasonic sensors:** HC-SR04 ultrasonic ranging module (B)
- **Infrared distance sensors:** IR distance sensor (generic) (B)
- **Time-of-flight sensors:** Time-of-flight sensor module (B)
- **LiDAR:** 2D scanning LiDAR (generic) (C)
- **Accelerometers:** Accelerometer breakout (B)
- **Gyroscopes:** Gyroscope breakout (B)
- **IMUs:** 6-DoF IMU breakout (B)
- **Rotary encoders:** Incremental rotary encoder (shaft type) (B)
- **Linear encoders:** Linear encoder scale (C)
- **Limit switches:** Lever microswitch (generic) (B)
- **Load cells:** Bar load cell (generic) (B)
- **Strain gauges:** Foil strain gauge (C)
- **Temperature sensors:** Temperature sensor (TO-92) (B)
- **Humidity sensors:** Humidity & temperature module (B)
- **Pressure sensors:** Barometric pressure breakout (B)
- **Optical sensors:** Ambient light sensor module (B)
- **Magnetic sensors:** Hall-effect sensor module (B)
- **Electrical monitoring sensors:** Current/voltage monitor module (B)
- **Fluid sensors:** Liquid flow sensor (generic) (C)
- **Biological sensing modules:** Optical pulse sensor module (C)
- **Navigation sensors:** Magnetometer / compass module (B)
- **Touch sensors:** Capacitive touch pad module (B)

### 10. Power & Energy Storage

- **Primary batteries:** Primary (alkaline/lithium) cell (B, 4 variants)
- **Rechargeable cells:** Lithium-ion cylindrical cell (B, 2 variants); LiPo pouch cell (B)
- **Battery packs:** Battery pack (B, 2 variants)
- **Battery holders:** Battery holder (B)
- **Battery management systems:** BMS protection board (generic) (B)
- **Charging modules:** Single-cell Li-ion charger module (B)
- **Solar cells:** Solar cell (B)
- **Solar panels:** Solar panel (small) (C)
- **Supercapacitors:** Supercapacitor (B)
- **Power connectors:** High-current connector pair (XT60-style) (C)
- **Energy harvesting modules:** Energy-harvesting module (C)

### 11. Power Electronics & Electrical Systems

- **Buck converters:** Adjustable buck converter module (B)
- **Boost converters:** Boost converter module (B)
- **Buck-boost converters:** Buck-boost converter module (B)
- **Linear regulators:** Linear regulator (TO-220) (B); Breadboard power supply module (generic) (B)
- **AC-DC converters:** Enclosed AC-DC power supply (C)
- **Inverters:** DC-AC inverter (generic) (C)
- **Motor drivers:** Stepper driver carrier (generic) (B); Dual H-bridge motor driver module (L298N-type, generic) (B)
- **Relays:** Single-channel relay module (B)
- **Contactors:** DIN-rail contactor (C)
- **Electrical protection:** Inline fuse holder (C)
- **Transformers:** Small transformer (C)
- **Power distribution:** Power distribution board (B)
- **Isolation components:** Optocoupler (DIP-4) (B)
- **Electric machines:** Electric machine (generic) (C)

### 12. Connectors, Wiring & PCBs

- **Solid-core wire:** Solid-core hook-up wire (A)
- **Stranded wire:** Stranded wire (A)
- **Ribbon cable:** Ribbon cable with IDC connector (C)
- **Data cables:** USB cable (generic) (B)
- **Dupont connectors:** Dupont-style housing (1×n) (C); Jumper wire (Dupont-style) (A, 3 variants)
- **JST connectors:** JST-PH-style connector (2-pin) (C)
- **Terminal blocks:** Screw terminal block (5.08 mm) (C)
- **Pin headers:** Pin header strip (2.54 mm) (B)
- **RF connectors:** SMA connector (C)
- **Audio connectors:** 3.5 mm audio jack (C)
- **Industrial connectors:** M12 circular connector (C)
- **Breadboards:** Solderless breadboard (generic) (B, 2 variants)
- **Perfboards:** Perfboard (2.54 mm grid) (A)
- **Single-layer PCBs:** Single-layer PCB (A)
- **Multilayer PCBs:** Multilayer PCB (4-layer) (A)
- **Flexible PCBs:** Flexible PCB strip (C)
- **PCB pads, vias and traces:** PCB test pad / via marker (C)
- **Cable management:** Cable tie mount (C)

### 13. Communications & Networking

- **Wi-Fi modules:** Wi-Fi module (generic) (B)
- **Bluetooth modules:** Bluetooth serial module (generic) (B)
- **RF transceivers:** 2.4 GHz transceiver module (B)
- **LoRa modules:** LoRa module (generic) (B)
- **Cellular modules:** Cellular modem board (generic) (C)
- **GPS/GNSS receivers:** GNSS receiver module (B)
- **Ethernet modules:** Ethernet SPI module (B)
- **CAN transceivers:** CAN transceiver module (B)
- **RS-485 transceivers:** RS-485 transceiver module (B)
- **NFC modules:** NFC reader module (B)
- **RFID modules:** RFID reader module (13.56 MHz) (B)
- **Antennas:** Whip antenna (C)
- **RF filters and amplifiers:** RF amplifier board (C)

### 14. Displays & Human Interfaces

- **OLED displays:** OLED display module 128×64 (0.96") (B)
- **LCD displays:** Character LCD 16×2 (B)
- **TFT displays:** TFT display module 2.8" (B)
- **E-paper displays:** E-paper display module 2.9" (B)
- **Touchscreens:** Touch panel overlay (C)
- **LED matrices:** 8×8 LED matrix module (B)
- **Indicator LEDs:** Indicator LED (5 mm) (B)
- **Push buttons:** Tactile push button (6 × 6 mm) (B)
- **Toggle switches:** Toggle switch (C)
- **Rotary encoders:** Panel rotary encoder with knob shaft (B)
- **Joysticks:** Analog joystick module (B)
- **Keypads:** 4×4 membrane keypad (B)
- **Haptic motors:** Coin vibration motor (generic) (B)
- **Human-interface modules:** Control panel module (C)

### 15. Optics, Photonics & Imaging

- **Lenses:** Round lens (B)
- **Mirrors:** Round mirror (B)
- **Prisms:** Right-angle prism (C)
- **Optical filters:** Optical filter (B)
- **Laser diode modules:** Laser diode module (generic) (B)
- **LED emitters:** High-power LED emitter (B)
- **Photodiodes:** Photodiode (B)
- **Optical fibres:** Optical fibre patch lead (B)
- **Camera modules:** Camera module (generic) (B)
- **Stereo cameras:** Stereo camera (generic) (C)
- **Depth cameras:** Depth camera (generic) (C)
- **Thermal cameras:** Thermal camera module (generic) (C)
- **Projection modules:** Pico projection module (C)
- **Optical mounts:** Optical post (A)
- **Imaging assemblies:** Imaging assembly (lens + sensor) (C)

### 16. Audio & Acoustics

- **Speaker drivers:** Full-range speaker driver (B)
- **Woofers:** Woofer (B)
- **Tweeters:** Tweeter (B)
- **Microphones:** Microphone module (B)
- **Microphone arrays:** Microphone array board (C)
- **Amplifier modules:** Class-D amplifier module (B)
- **Audio converters:** I²S DAC module (B)
- **Bluetooth audio modules:** Bluetooth audio receiver module (B)
- **Speaker enclosures:** Speaker enclosure (A)
- **Passive radiators:** Passive radiator (B)
- **Crossovers:** Passive crossover board (C)
- **Acoustic damping:** Acoustic damping sheet (B)
- **Haptic transducers:** Haptic / tactile exciter (B)

### 17. Fluid, Pneumatic & Hydraulic Systems

- **Tubing:** Pneumatic tubing (A)
- **Pipes:** Copper pipe (A)
- **Fluid fittings:** Push-fit elbow fitting (C)
- **Pumps:** Mini diaphragm pump (C)
- **Valves:** Solenoid valve (C)
- **Pneumatic cylinders:** Pneumatic cylinder (B)
- **Hydraulic cylinders:** Hydraulic cylinder (B)
- **Pressure regulators:** Pressure regulator (C)
- **Reservoirs:** Fluid reservoir (A)
- **Accumulators:** Hydraulic accumulator (C)
- **Flow meters:** Inline flow meter (C)
- **Nozzles:** Spray nozzle (C)
- **Fluid seals:** Seal ring (A)
- **Manifolds:** Valve manifold block (C)
- **Fluid connectors:** Quick coupler (C)

### 18. Thermal & Environmental Systems

- **Heat sinks:** Finned heat sink (A)
- **Heat pipes:** Heat pipe (B)
- **Fans:** Axial fan (B, 4 variants)
- **Blowers:** Radial blower (C)
- **Radiators:** Liquid-cooling radiator (C)
- **Cooling pumps:** Coolant pump (C)
- **Heating elements:** Cartridge heater (C)
- **Peltier modules:** Thermoelectric (Peltier) module (B)
- **Thermal pads:** Thermal pad (A)
- **Thermal insulation:** Insulation sheet (A)
- **Thermostats:** Thermostat controller module (B)
- **Environmental control modules:** Environmental control board (C)
- **Filters:** Air filter panel (B)
- **Heat exchangers:** Plate heat exchanger (C)

### 19. Manufacturing & Fabrication Parts

- **Printer frames:** Printer frame (generic) (C)
- **Print beds:** Print bed plate (A, 2 variants)
- **Hotends:** Hotend assembly (C)
- **Extruders:** Filament extruder (C)
- **Printer nozzles:** Printer nozzle (generic) (B)
- **Spindle motors:** Spindle motor (generic) (B)
- **Linear guides:** Machine linear guide (B)
- **Machine positioning stages:** XY positioning stage (C)
- **Fixturing components:** Fixture plate (A, 1 variants)
- **Conveyor components:** Conveyor roller (B)
- **Feedstock:** Machining bar feedstock (A)
- **Machine drive assemblies:** Axis drive (screw + nut) (B)

### 20. Aerospace, Drones & Propulsion

- **Drone frames:** Quadcopter frame (250-class) (C)
- **Propellers:** Propeller (B, 2 variants)
- **Brushless propulsion motors:** Brushless outrunner motor (generic) (B)
- **ESCs:** Electronic speed controller (generic) (B)
- **Aircraft control surfaces:** Control surface panel (A)
- **Wing structures:** Wing section (envelope) (C)
- **Airframe components:** Airframe boom (carbon tube) (A)
- **Flight controllers:** Flight controller (30.5 mm mount, generic) (B)
- **Navigation modules:** GPS + compass module (B)
- **Landing gear:** Landing skid (C)
- **Ducted fans:** Electric ducted fan (C)
- **Experimental airfoil geometry:** Airfoil test blank (A)

### 21. Automation & Industrial Control

- **PLC modules:** PLC CPU module (DIN rail) (C)
- **Industrial controllers:** Industrial controller (C)
- **Servo drives:** Servo drive (C)
- **Motion controllers:** Motion controller (C)
- **Contactors:** Industrial contactor (C)
- **Industrial sensors:** Inductive proximity sensor (M12 barrel) (B)
- **Safety switches:** Emergency-stop button (C)
- **HMI modules:** HMI touch panel (generic) (C)
- **Conveyors:** Belt conveyor module (C)
- **Indexing mechanisms:** Rotary indexing table (C)
- **Industrial communication modules:** Fieldbus gateway (C)

### 22. Advanced Materials & Smart Devices

- **Shape-memory alloys:** Shape-memory alloy wire (B)
- **Piezoelectric devices:** Piezo disc (B)
- **Conductive films:** Conductive film (A)
- **Magnetic materials:** Flexible magnetic sheet (A)
- **Electroactive polymers:** Electroactive polymer actuator (C)
- **Functional coatings:** Coated sample plate (A)
- **Flexible electronics:** Flex sensor strip (C)
- **MEMS devices:** MEMS sensor package (C)
- **Thermoelectric materials:** Thermoelectric leg / pellet (B)
- **Smart composite materials:** Smart composite panel (C)

### 23. Enclosures & Product Design

- **Electronics enclosures:** Electronics enclosure (A)
- **Project boxes:** Project box with lid (A)
- **Custom housings:** Custom housing (A)
- **Panels:** Front panel (A)
- **Lids:** Enclosure lid (A, 1 variants)
- **Battery doors:** Battery door (A)
- **PCB mounts:** PCB standoff (A, 2 variants)
- **Display bezels:** Display bezel (C)
- **Handles:** Pull handle (C)
- **Grips:** Rubber grip (C)
- **Cable-routing components:** Adhesive cable clip (C)
- **Protective covers:** Protective cover (A)
- **Seals:** O-ring (rectangular approximation) (B)
- **Wearable housings:** Wrist-worn housing (C)

### 24. Complete Modules & Assemblies

- **Robotic arm modules:** 3-DoF arm module (generic) (C)
- **Mobility modules:** Wheel drive module (C)
- **Control modules:** Controller stack (generic) (C)
- **Vision modules:** Vision module (camera + compute) (C)
- **Sensor modules:** Sensor hub (generic) (C)
- **Power modules:** Power module (battery + regulation) (C)
- **Audio modules:** Audio module (amp + speaker) (C)
- **Computing assemblies:** Compute assembly (SBC + case) (C)
- **Automation modules:** Pick-and-place module (C)
- **Drone modules:** Propulsion module (motor + prop + ESC) (C)
- **Communication assemblies:** Radio assembly (module + antenna) (C)
- **User-saved assemblies:** Saved assembly placeholder (C)

### 25. Semiconductor & Microfabrication

- **Silicon wafers:** Silicon wafer (A, 3 variants)
- **SOI wafers:** SOI wafer (A, 3 variants)
- **Glass substrates:** Glass substrate (A)
- **Photomasks:** Photomask plate (A)
- **Thin-film layers:** Thin-film layer marker (C)
- **Microelectrodes:** Microelectrode array chip (C)
- **MEMS structures:** MEMS die (C)
- **Microfluidic chips:** Microfluidic chip (A)
- **Semiconductor packages:** Package outline (QFP) (B)
- **Wafer-scale components:** Wafer carrier (C)

### 26. Scientific Test Specimens & Calibration

- **Tensile specimens:** Flat tensile specimen (dog-bone) (A)
- **Compression specimens:** Compression cylinder (A)
- **Fatigue specimens:** Flat fatigue specimen (A)
- **Fracture specimens:** Compact-tension specimen (C)
- **Composite coupons:** Composite test coupon (A)
- **Reference masses:** Reference mass (cylindrical) (A)
- **Optical calibration targets:** Optical calibration target plate (A)
- **Standard fixtures:** Test fixture bracket (A)
- **Alignment references:** Tooling ball (sphere) (A)
- **Calibration structures:** Gauge block (A)

### 27. Biomechanics & Soft Robotics

- **Artificial tendons:** Tendon cable (A)
- **Soft grippers:** Soft-finger gripper (C)
- **Compliant joints:** Flexure hinge strip (A)
- **Silicone limbs:** Silicone limb segment (C)
- **Pneumatic soft actuators:** Pneumatic soft bending actuator (B)
- **Pressure-sensitive skins:** Pressure-sensitive skin patch (A)
- **Wearable sensing modules:** Wearable sensing module (C)
- **Biomechanical linkage structures:** Finger linkage segment (A)

### 28. Experimental Environments & Test Objects

- **Standardized test objects:** Test cube (A, 3 variants)
- **Graspable objects:** Graspable block (A)
- **Mechanical obstacles:** Obstacle block (A)
- **Terrain modules:** Terrain tile (A)
- **Fluid containers:** Open fluid container (A)
- **Calibration objects:** Calibration sphere (A)
- **Robot navigation markers:** Fiducial marker tile (A)
- **Experimental fixtures:** Experiment base plate (A)
- **Environmental test structures:** Test ramp (C)
- **Modular research scene assets:** Scene pillar (A)
