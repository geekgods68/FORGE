/**
 * Example sketches in the FORGE Arduino subset. They are ordinary, editable firmware: the
 * runtime executes whatever the user writes — nothing here is a scripted response.
 */
export const BLINK_SKETCH = `// Blink: toggles the on-board LED pin (D13) once per second.
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`;

export const ULTRASONIC_SERVO_SKETCH = `// HC-SR04 distance -> servo angle (FORGE Arduino subset, Level 2 runtime).
#include <Servo.h>

const int TRIG_PIN = 7;
const int ECHO_PIN = 8;
const int SERVO_PIN = 9;
const float NEAR_CM = 5.0;   // distance shown as 0 degrees
const float FAR_CM = 50.0;   // distance shown as 180 degrees

Servo gauge;

// Trigger one measurement and convert the echo time to centimetres.
float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long echoUs = pulseIn(ECHO_PIN, HIGH, 30000);
  if (echoUs == 0) return -1.0;   // no echo within 30 ms
  return echoUs * 0.0343 / 2.0;   // speed of sound ~343 m/s at 20 C
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  gauge.attach(SERVO_PIN);
}

void loop() {
  float d = readDistanceCm();
  if (d > 0) {
    float clamped = constrain(d, NEAR_CM, FAR_CM);
    int angle = (int)((clamped - NEAR_CM) * 180.0 / (FAR_CM - NEAR_CM));
    gauge.write(angle);
    Serial.print("distance_cm=");
    Serial.print(d);
    Serial.print(" angle=");
    Serial.println(angle);
  } else {
    Serial.println("no echo");
  }
  delay(60);
}
`;

export const SERIAL_COMMAND_SKETCH = `// Serial commands: send "13 1" to set D13 HIGH, "13 0" for LOW.
void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
  Serial.println("ready");
}

void loop() {
  if (Serial.available() > 0) {
    int pin = Serial.parseInt();
    int level = Serial.parseInt();
    if (pin >= 2 && pin <= 13) {
      pinMode(pin, OUTPUT);
      digitalWrite(pin, level ? HIGH : LOW);
      Serial.print("D");
      Serial.print(pin);
      Serial.print(" = ");
      Serial.println(level ? "HIGH" : "LOW");
    }
  }
  delay(20);
}
`;

export const ARM_CONTROL_SKETCH = `// Four-joint arm: pose sequence, serial joint commands and a range-sensor hold.
// Servo 90 degrees = the CAD pose of each joint.
#include <Servo.h>

Servo joints[4];   // 0 base yaw, 1 shoulder, 2 elbow, 3 wrist
const int SERVO_PINS[4] = {3, 5, 6, 9};
const int TRIG_PIN = 7;
const int ECHO_PIN = 8;

const int POSES = 3;
int poses[12] = {
  90, 90, 90, 90,
  120, 75, 105, 90,
  60, 100, 80, 120
};
int target[4] = {90, 90, 90, 90};
bool sequence = true;
int pose = 0;
unsigned long lastPose = 0;

float rangeCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000);
  if (us == 0) return -1.0;
  return us * 0.0343 / 2.0;
}

// "B 120", "S 75", "E 105", "W 90" set one joint (degrees); "P" resumes the sequence.
void readCommand() {
  int c = Serial.read();
  int j = -1;
  if (c == 'B') j = 0;
  if (c == 'S') j = 1;
  if (c == 'E') j = 2;
  if (c == 'W') j = 3;
  if (c == 'P') {
    sequence = true;
    Serial.println("sequence on");
  }
  if (j >= 0) {
    target[j] = constrain(Serial.parseInt(), 0, 180);
    sequence = false;
    Serial.print("joint ");
    Serial.print(j);
    Serial.print(" -> ");
    Serial.println(target[j]);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  for (int i = 0; i < 4; i++) {
    joints[i].attach(SERVO_PINS[i]);
    joints[i].write(target[i]);
  }
}

void loop() {
  while (Serial.available() > 0) readCommand();
  float d = rangeCm();
  bool blocked = d > 0 && d < 8.0;   // something within 8 cm: hold position
  if (sequence && !blocked && millis() - lastPose > 2000) {
    pose = (pose + 1) % POSES;
    for (int i = 0; i < 4; i++) target[i] = poses[pose * 4 + i];
    lastPose = millis();
  }
  for (int i = 0; i < 4; i++) joints[i].write(target[i]);
  Serial.print("range_cm=");
  Serial.print(d);
  if (blocked) Serial.print(" HOLD");
  Serial.print(" pose=");
  Serial.println(pose);
  delay(100);
}
`;
