# Facility architecture (facility revision 2)

The facility is read-only content in `@forge/facility`. It's built from data (`facility-v1.ts`) plus five renderer templates. Nothing in it is pickable or editable, and no command addresses it.

## Site plan

Facility frame F: metres, +Y up, −Z north. The datum is the centre of Corridor E at floor level.

```
 z = −7.5   [21]   [20]   [22]          ← Wing E labs (north of Corridor E)
 z =  0     ══════ Corridor E ══════
              ║ concourse 1
 z = 16     ══ Wing A corridor ══   labs 1–4 north, lab 5 south
              ║ concourse 2
 z = 44     ══ Wing B corridor ══   labs 6–9 north
              ║ concourse 3
 z = 72     ══ Wing C corridor ══   labs 10–13 north, lab 14 south
              ║ concourse 4
 z = 100    ══ Wing D corridor ══   labs 15–18 north, lab 19 south
              ║ concourse 5
 z = 116    ════ Environments corridor ════
            [E1] [E2] [E3] [E4] [E5] [E6]   ← 24 × 24 × 8 m high bays (south)
```

- **Labs:** every lab is 18 × 12 m inside (zone frame ±9 × ±6), with its door on local +Z. Labs south of a corridor use yaw π, so every door faces its corridor.
- **Columns:** lab centres sit at x = −31, −11.5, 11.5 and 31, clear of the 4 m concourse (x −2…2).
- **Revision 1:** identities are unchanged: Lab 20's pose, footprint and placement areas, Corridor E's footprint, and every zone id and equipment id. Layouts saved against revision 1 still validate (unit test).

## Rooms (generated from the registry)

| Code   | Name                                             | Wing | Zone id                             | Pose (x, z)          | Interior W × D × H (m) | Opens onto              | Discipline                                               | Fixed furnishings                                                                                                                                                                                   |
| ------ | ------------------------------------------------ | ---- | ----------------------------------- | -------------------- | ---------------------- | ----------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LAB 01 | Central Intelligence Research Lab                | A    | `lab-01-central-intelligence`       | (-31, 8.5), yaw 0    | 18 × 12 × 4.5          | `corridor-a-main`       | Machine learning · model training · reasoning systems    | Server rack row (8 racks); GPU compute cabinets; Storage wall; Researcher desk cluster; Meeting table; Large display wall                                                                           |
| LAB 02 | Computer Vision & Perception Lab                 | A    | `lab-02-computer-vision`            | (-11.5, 8.5), yaw 0  | 18 × 12 × 4.5          | `corridor-a-main`       | Cameras · calibration · perception datasets              | Multi-camera calibration rig; Large display wall; Storage wall; Researcher desk cluster; Electronics bench with instrument shelf; Whiteboard; GPU compute cabinets                                  |
| LAB 03 | Autonomous Systems & Robot Learning Lab          | A    | `lab-03-autonomous-robot-learning`  | (11.5, 8.5), yaw 0   | 18 × 12 × 4.5          | `corridor-a-main`       | Robot learning · autonomy · sim-to-real                  | Guarded robot-arm cell; GPU compute cabinets; Storage wall; Researcher desk cluster; Electronics bench with instrument shelf; Whiteboard; Meeting table                                             |
| LAB 04 | Research Computing & Systems Lab                 | A    | `lab-04-research-computing`         | (31, 8.5), yaw 0     | 18 × 12 × 4.5          | `corridor-a-main`       | HPC · distributed systems · research infrastructure      | Server rack row (8 racks); Switchgear & power-supply panel; Researcher desk cluster; Large display wall; Storage wall                                                                               |
| LAB 05 | Human–AI Interaction & Immersive Lab             | A    | `lab-05-human-ai-immersive`         | (-31, 23.5), yaw π   | 18 × 12 × 4.5          | `corridor-a-main`       | Human factors · immersive interfaces · user studies      | Tracked immersive interaction space; Large display wall; Storage wall; Researcher desk cluster; Meeting table; Whiteboard                                                                           |
| LAB 06 | Robotic Manipulation Laboratory                  | B    | `lab-06-robotic-manipulation`       | (-31, 36.5), yaw 0   | 18 × 12 × 4.5          | `corridor-b-main`       | Manipulators · grasping · end effectors                  | Guarded robot-arm cell; Electronics bench with instrument shelf; Control & DAQ test rig; Researcher desk cluster; Storage wall; Whiteboard                                                          |
| LAB 07 | Mobile Robotics & Navigation Arena               | B    | `lab-07-mobile-robotics`            | (-11.5, 36.5), yaw 0 | 18 × 12 × 6            | `corridor-b-main`       | Mobile robots · localisation · navigation                | Mobile-robot test arena; Robot charging dock; Researcher desk cluster; Storage wall                                                                                                                 |
| LAB 08 | Embedded Systems & Computer Engineering Lab      | B    | `lab-08-embedded-systems`           | (11.5, 36.5), yaw 0  | 18 × 12 × 4.5          | `corridor-b-main`       | Microcontrollers · firmware · hardware-in-the-loop       | Electronics bench with instrument shelf; Storage wall; Researcher desk cluster; Pick-and-place & reflow line; Whiteboard                                                                            |
| LAB 09 | Sensors, Controls & Instrumentation Lab          | B    | `lab-09-sensors-controls`           | (31, 36.5), yaw 0    | 18 × 12 × 4.5          | `corridor-b-main`       | Sensing · control loops · instrumentation                | Control & DAQ test rig; Electronics bench with instrument shelf; Vibration shaker table; Researcher desk cluster; Storage wall; Data-acquisition console                                            |
| LAB 10 | Mechanical Design & Assembly Studio              | C    | `lab-10-mechanical-design`          | (-31, 64.5), yaw 0   | 18 × 12 × 4.5          | `corridor-c-main`       | CAD · mechanism design · assembly                        | Perimeter bench with reagent shelf; Large display wall; Storage wall; Researcher desk cluster; Meeting table; Whiteboard                                                                            |
| LAB 11 | Precision Fabrication & Machine Shop             | C    | `lab-11-precision-fabrication`      | (-11.5, 64.5), yaw 0 | 18 × 12 × 4.5          | `corridor-c-main`       | Machining · tooling · precision fabrication              | CNC machining centre; Toolroom lathe; Storage wall; Perimeter bench with reagent shelf; Flammables safety cabinet                                                                                   |
| LAB 12 | Advanced Additive Manufacturing Centre           | C    | `lab-12-additive-manufacturing`     | (11.5, 64.5), yaw 0  | 18 × 12 × 4.5          | `corridor-c-main`       | Additive manufacturing · materials · post-processing     | Additive manufacturing printer row; Fume hood; Researcher desk cluster; Flammables safety cabinet; Storage wall                                                                                     |
| LAB 13 | Materials Science & Mechanical Testing Lab       | C    | `lab-13-materials-testing`          | (31, 64.5), yaw 0    | 18 × 12 × 4.5          | `corridor-c-main`       | Material properties · mechanical testing · microscopy    | Universal testing machine; Fume hood; Microscopy station; Perimeter bench with reagent shelf; Researcher desk cluster; Flammables safety cabinet; Storage wall                                      |
| LAB 14 | Structures, Dynamics & Multiphysics Lab          | C    | `lab-14-structures-multiphysics`    | (-31, 79.5), yaw π   | 18 × 12 × 4.5          | `corridor-c-main`       | Structural dynamics · coupled physics · test correlation | Vibration shaker table; Universal testing machine; Server rack row (8 racks); Storage wall; Control & DAQ test rig; Researcher desk cluster; Large display wall; Whiteboard                         |
| LAB 15 | Electronics & PCB Engineering Lab                | D    | `lab-15-electronics-pcb`            | (-31, 92.5), yaw 0   | 18 × 12 × 4.5          | `corridor-d-main`       | Circuit design · PCB assembly · rework                   | Pick-and-place & reflow line; Electronics bench with instrument shelf; Fume hood; Storage wall; Researcher desk cluster                                                                             |
| LAB 16 | Microelectronics & Nanofabrication Cleanroom     | D    | `lab-16-cleanroom`                  | (-11.5, 92.5), yaw 0 | 18 × 12 × 4.5          | `corridor-d-main`       | Lithography · thin films · cleanroom processing          | Lithography tool; Laminar-flow clean bench; Fume hood; Microscopy station; Storage wall; Cleanroom air shower                                                                                       |
| LAB 17 | Power, Energy & Electric Machines Lab            | D    | `lab-17-power-energy`               | (11.5, 92.5), yaw 0  | 18 × 12 × 4.5          | `corridor-d-main`       | Power electronics · energy storage · electric machines   | Motor dynamometer bay; Battery test cabinet; Switchgear & power-supply panel; Control & DAQ test rig; Researcher desk cluster; Electronics bench with instrument shelf; Storage wall                |
| LAB 18 | Photonics, Imaging & Optics Lab                  | D    | `lab-18-photonics-optics`           | (31, 92.5), yaw 0    | 18 × 12 × 4.5          | `corridor-d-main`       | Optics · lasers · imaging                                | Vibration-isolated optical table; Laser safety enclosure; Storage wall; Researcher desk cluster; Microscopy station; Whiteboard                                                                     |
| LAB 19 | Aerospace, Fluid & Environmental Test Arena      | D    | `lab-19-aerospace-fluid`            | (-31, 107.5), yaw π  | 18 × 12 × 6            | `corridor-d-main`       | Aerodynamics · fluids · environmental testing            | Bench-scale wind tunnel; Environmental test chamber; Fume hood; Data-acquisition console; Control & DAQ test rig; Storage wall; Researcher desk cluster                                             |
| LAB 20 | Central Conjuring & Integration Workshop         | E    | `lab-20-central-conjuring-workshop` | (0, -7.5), yaw 0     | 18 × 12 × 4.5          | `corridor-e-main`       | Integration · assembly · staging                         | Storage wall; Whiteboard; Large display wall                                                                                                                                                        |
| LAB 21 | Research Experimentation & Validation Centre     | E    | `lab-21-research-validation`        | (-18, -7.5), yaw 0   | 18 × 12 × 4.5          | `corridor-e-main`       | Test campaigns · verification · data acquisition         | Environmental test chamber; Vibration shaker table; Data-acquisition console; Server rack row (8 racks); Electronics bench with instrument shelf; Researcher desk cluster; Storage wall; Whiteboard |
| LAB 22 | Engineering Documentation & Design Review Studio | E    | `lab-22-documentation-review`       | (18, -7.5), yaw 0    | 18 × 12 × 4.5          | `corridor-e-main`       | Design reviews · drawings · technical documentation      | Large display wall; Large-format plotter; Researcher desk cluster; Meeting table; Storage wall                                                                                                      |
| ENV 1  | Robotic Manipulation Arena                       | E    | `env-robotic-manipulation-arena`    | (-65, 129.5), yaw π  | 24 × 24 × 8            | `corridor-environments` | Configurable environment · multi-robot manipulation      | Conveyor line; Guarded robot-arm cell; Operator control desk                                                                                                                                        |
| ENV 2  | Motion Capture & Navigation Arena                | E    | `env-motion-capture-navigation`     | (-39, 129.5), yaw π  | 24 × 24 × 8            | `corridor-environments` | Configurable environment · tracked navigation            | Motion-capture camera truss; Robot charging dock; Operator control desk                                                                                                                             |
| ENV 3  | Underwater Robotics Tank                         | E    | `env-underwater-tank`               | (-13, 129.5), yaw π  | 24 × 24 × 8            | `corridor-environments` | Configurable environment · underwater robotics           | Test tank with gantry; Operator control desk                                                                                                                                                        |
| ENV 4  | Aerodynamics & Wind Tunnel Bay                   | E    | `env-wind-tunnel-bay`               | (13, 129.5), yaw π   | 24 × 24 × 8            | `corridor-environments` | Configurable environment · aerodynamics                  | Closed-return wind tunnel; Operator control desk                                                                                                                                                    |
| ENV 5  | Immersive Design Chamber                         | E    | `env-immersive-design-chamber`      | (39, 129.5), yaw π   | 24 × 24 × 8            | `corridor-environments` | Configurable environment · immersive design review       | Projection CAVE; Large display wall; Operator control desk                                                                                                                                          |
| ENV 6  | Real-World Environment Simulator                 | E    | `env-real-world-simulator`          | (65, 129.5), yaw π   | 24 × 24 × 8            | `corridor-environments` | Configurable environment · terrain & weather conditions  | Terrain & weather course; Operator control desk                                                                                                                                                     |

## Corridors

| Name                                        | Zone id                 | Facility extent (m)     | Portals |
| ------------------------------------------- | ----------------------- | ----------------------- | ------- |
| Wing E Main Corridor                        | `corridor-e-main`       | x -27…27, z -1.5…1.5    | 4       |
| Wing A Main Corridor                        | `corridor-a-main`       | x -41…41, z 14.5…17.5   | 7       |
| Wing B Main Corridor                        | `corridor-b-main`       | x -41…41, z 42.5…45.5   | 6       |
| Wing C Main Corridor                        | `corridor-c-main`       | x -41…41, z 70.5…73.5   | 7       |
| Wing D Main Corridor                        | `corridor-d-main`       | x -41…41, z 98.5…101.5  | 7       |
| Environments Corridor                       | `corridor-environments` | x -78…78, z 114.5…117.5 | 7       |
| Central Concourse 1 (Wing E – Wing A)       | `concourse-1`           | x -2…2, z 1.5…14.5      | 2       |
| Central Concourse 2 (Wing A – Wing B)       | `concourse-2`           | x -2…2, z 17.5…42.5     | 2       |
| Central Concourse 3 (Wing B – Wing C)       | `concourse-3`           | x -2…2, z 45.5…70.5     | 2       |
| Central Concourse 4 (Wing C – Wing D)       | `concourse-4`           | x -2…2, z 73.5…98.5     | 2       |
| Central Concourse 5 (Wing D – Environments) | `concourse-5`           | x -2…2, z 101.5…114.5   | 2       |

## Templates

The templates are pure data builders (`apps/desktop/src/facility/shell.ts`). The renderer batches their output into instanced draws.

| Module key                | Used by            | Architecture                                                                                                                                                                                                                         |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lab-room`                | Labs 1–19, 21, 22  | Plaster walls, a **glazed corridor partition** (kerb, clear glass band, brushed-aluminium mullions and transom), aluminium door frame, pilasters, suspended neutral-white luminaires, a linear wall wash and placement-area outlines |
| `central-workshop`        | Lab 20             | The same lab template, plus the conjuring-dais ring (the slice room, rebuilt on the template)                                                                                                                                        |
| `environment`             | The 6 environments | Exposed concrete high bay, glazed viewing wall, light roof trusses, high-bay luminaires, columns and a safety-yellow operator floor outline                                                                                          |
| `corridor` / `corridor-e` | All 11 corridors   | Walls cut by every portal, glazed where rooms open onto them, luminaires along the axis, wayfinding kiosk                                                                                                                            |

- **Walls:** drawn 0.2 m outside each zone's footprint, so a room and its corridor form one 0.4 m partition. Walls never intrude on placement areas.
- **Furnishings:** 44 procedural types (`furnishings.ts` for the data, `fixtures.ts` for the recipes). Recipes use the shared palette, and every part is a unit box or cylinder scaled per instance. Furnishings are illustrative dressing with no engineering or simulation meaning.

## Visual direction

The mix is roughly 80 % realistic research institute and 20 % engineering interface.

- **Palette:** light polished concrete, painted plaster, brushed aluminium, clear glazing, white phenolic and black epoxy worktops, white-enamel equipment and neutral-white luminaires.
- **Cyan:** used only on interactive interfaces (screens, consoles, kiosks, the dais and pedestal). There's no neon, no particles and no decorative machinery.
- **Palette size:** 24 materials (`materials.ts`), shared by every zone.

## Signage

Signs are derived from data (`signage.ts`), so they can't disagree with the registry. They're rasterised locally into reference-counted CanvasTextures using the system font stack, with no remote fonts.

- **Identity panel:** high on the back wall of every room: code · name, discipline, wing.
- **Door sign:** in the corridor beside every room door: code, name, discipline. There's exactly one per room (unit test).
- **Directional signs:** above every corridor/concourse opening, listing what lies ahead (for example "↓ Wing A Main Corridor / Labs 1, 2, 3, 4, 5").

## Navigation

The directory is grouped by wing, then environments, then corridors, and every entry has an Enter button. Each zone also has an **Exits** list of its portal neighbours.

- **Camera presets:** each zone has one. Rooms are viewed from above their doorway side; corridors from above, along their axis. Lab 20 keeps its revision-1 preset exactly.
- **Prefetch:** hovering or focusing a destination prefetches it (at most one at a time).
- **Reachability:** every zone is reachable from Lab 20 through open portals (unit test).

## Lifecycle

```
UNLOADED ─load─▶ LOADING ─ok─▶ ACTIVE ─not wanted─▶ UNLOADING ─renderer released─▶ UNLOADED
                   └─fail─▶ ERROR ─Retry─▶ LOADING
```

- **Wanted set:** the active zone, plus its required corridor (the implemented corridors it opens onto), plus at most one prefetch. A corridor requires only itself.
- **Loading:** fetches the template chunk. Mounting happens only for ACTIVE zones with role active or required.
- **Stale loads:** each load carries a generation token, so a load that resolves after the user moved on is ignored.
- **Recovery:** errors are shown with a Retry button.
- **Data safety:** workspace layouts and projects are never touched by unloading. Items in unloaded zones stay in the layout and are simply not rendered (browser test).

## Known gaps

- **Corridor view:** from inside a wing corridor, the concourse opening shows empty space. Concourse segments aren't in a corridor's required set, by the loaded-set policy.
- **Default layout:** only Lab 20 has default workspace equipment. Other labs have empty, outlined bench floors that accept placed equipment.
- **No ceilings:** zones have no ceilings, so the overview camera can see in.
- **Simplified geometry:** furnishings are low-detail. They identify each discipline, but they aren't models of real instruments.
