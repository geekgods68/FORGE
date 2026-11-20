# Facility layout (planned; not modelled in Phase 0)

## Wing A: AI & Computational Intelligence

1. Central Intelligence Research Lab
2. Computer Vision & Perception Lab
3. Autonomous Systems & Robot Learning Lab
4. Research Computing & Systems Lab
5. Human–AI Interaction & Immersive Lab

## Wing B: Robotics & Mechatronics

6. Robotic Manipulation Laboratory
7. Mobile Robotics & Navigation Arena
8. Embedded Systems & Computer Engineering Lab
9. Sensors, Controls & Instrumentation Lab

## Wing C: Mechanical & Manufacturing

10. Mechanical Design & Assembly Studio
11. Precision Fabrication & Machine Shop
12. Advanced Additive Manufacturing Centre
13. Materials Science & Mechanical Testing Lab
14. Structures, Dynamics & Multiphysics Lab

## Wing D: Electronics & Physical Sciences

15. Electronics & PCB Engineering Lab
16. Microelectronics & Nanofabrication Cleanroom
17. Power, Energy & Electric Machines Lab
18. Photonics, Imaging & Optics Lab
19. Aerospace, Fluid & Environmental Test Arena

## Wing E: Research Operations

20. Central Conjuring & Integration Workshop
21. Research Experimentation & Validation Centre
22. Engineering Documentation & Design Review Studio

## Future configurable research environments

- Robotic Manipulation Arena
- Motion Capture & Navigation Arena
- Underwater Robotics Tank
- Aerodynamics & Wind Tunnel Bay
- Immersive Design Chamber
- Real-World Environment Simulator

## Status (Phase 2 vertical slice)

All 29 zones are registered in `@forge/facility` (`facility-v1.ts`), each with a reserved footprint on the site plan. The site plan uses facility frame F, metres, −Z north:

| Area              | Position                                   |
| ----------------- | ------------------------------------------ |
| Corridor E        | Datum, x −27…27 m                          |
| Wing E labs 20–22 | North of the corridor                      |
| Wings A–D         | Reserved rows at z = +20, +40, +60 and +80 |
| Six environments  | Reserved row at z = −40                    |

**Built:** Lab 20, Central Conjuring & Integration Workshop (18 × 12 × 4.5 m), and Corridor E (54 × 3 × 3.5 m).

**Not built:** the other 21 labs and all 6 environments. They are registered as `planned` and cannot be loaded.
