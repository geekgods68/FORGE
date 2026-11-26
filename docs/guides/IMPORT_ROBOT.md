# Importing a robot description (URDF)

1. **Data exchange** → select the `.urdf` file **and** its mesh files together (STL or GLB; `package://` paths are matched to the selected files by path, then name — nothing is downloaded).
2. Check links/joints, warnings and the "Not represented" list (transmissions, Gazebo/ros2_control, mimic, floating/planar joints, Collada/OBJ meshes).
3. Choose actuators: **none** (passive joints) or **generic position actuators** holding the initial pose (limits from `<limit>`; an assumption, not the robot's controller).
4. **Insert**: the robot becomes an assembly (links → bodies with the URDF inertials, joints → mates with limits). A simulation setup is created if needed (8 solver sub-steps for small links).
5. Simulation mode runs it with the existing Phase 5 engine. Joint positions can be edited like any FORGE mate.
