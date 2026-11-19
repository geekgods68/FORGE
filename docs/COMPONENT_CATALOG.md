# Component catalogue: planned top-level categories

These 28 categories are planned. In Phase 0 only their identifiers exist (`COMPONENT_CATEGORIES` in `@forge/engineering-core`), and every `ComponentDefinition.categoryId` is validated against them. **No category is populated yet.** The single Phase 0 demo cube uses `experimental-environments-test-objects`.

| #   | Category                                 | Identifier                               |
| --- | ---------------------------------------- | ---------------------------------------- |
| 1   | Structure & Raw Materials                | `structure-raw-materials`                |
| 2   | Fasteners & Joining                      | `fasteners-joining`                      |
| 3   | Mechanical Motion & Transmission         | `mechanical-motion-transmission`         |
| 4   | Motors & Actuators                       | `motors-actuators`                       |
| 5   | Robotics & Mobility                      | `robotics-mobility`                      |
| 6   | Passive Electronics                      | `passive-electronics`                    |
| 7   | Semiconductors & Integrated Circuits     | `semiconductors-ics`                     |
| 8   | Computing & Microcontrollers             | `computing-microcontrollers`             |
| 9   | Sensors & Measurement Components         | `sensors-measurement`                    |
| 10  | Power & Energy Storage                   | `power-energy-storage`                   |
| 11  | Power Electronics & Electrical Systems   | `power-electronics-electrical`           |
| 12  | Connectors, Wiring & PCBs                | `connectors-wiring-pcbs`                 |
| 13  | Communications & Networking              | `communications-networking`              |
| 14  | Displays & Human Interfaces              | `displays-human-interfaces`              |
| 15  | Optics, Photonics & Imaging              | `optics-photonics-imaging`               |
| 16  | Audio & Acoustics                        | `audio-acoustics`                        |
| 17  | Fluid, Pneumatic & Hydraulic Systems     | `fluid-pneumatic-hydraulic`              |
| 18  | Thermal & Environmental Systems          | `thermal-environmental`                  |
| 19  | Manufacturing & Fabrication Parts        | `manufacturing-fabrication`              |
| 20  | Aerospace, Drones & Propulsion           | `aerospace-drones-propulsion`            |
| 21  | Automation & Industrial Control          | `automation-industrial-control`          |
| 22  | Advanced Materials & Smart Devices       | `advanced-materials-smart-devices`       |
| 23  | Enclosures & Product Design              | `enclosures-product-design`              |
| 24  | Complete Modules & Assemblies            | `complete-modules-assemblies`            |
| 25  | Semiconductor & Microfabrication         | `semiconductor-microfabrication`         |
| 26  | Scientific Test Specimens & Calibration  | `test-specimens-calibration`             |
| 27  | Biomechanics & Soft Robotics             | `biomechanics-soft-robotics`             |
| 28  | Experimental Environments & Test Objects | `experimental-environments-test-objects` |

## Rules for future entries

- Every definition declares:
  - its geometry, in metres;
  - its provenance;
  - each simulation capability with a validity status.
- A generic or approximate model is never presented as an exact replica of a specific real product.
