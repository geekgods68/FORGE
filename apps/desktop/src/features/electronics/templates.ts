import {
  BLINK_SKETCH,
  SERIAL_COMMAND_SKETCH,
  ULTRASONIC_SERVO_SKETCH,
  ARM_CONTROL_SKETCH,
} from '@forge/electronics';

/** Starting points for new firmware (ordinary editable sketches). */
export const FIRMWARE_TEMPLATES = {
  blink: { name: 'Blink', source: BLINK_SKETCH },
  ultrasonic: { name: 'Ultrasonic servo gauge', source: ULTRASONIC_SERVO_SKETCH },
  serial: { name: 'Serial commands', source: SERIAL_COMMAND_SKETCH },
  arm: { name: 'Four-joint arm control', source: ARM_CONTROL_SKETCH },
} as const;
