// FORGE telemetry protocol v1 — HC-SR04 distance + servo gauge (Arduino UNO).
// Observation only: this sketch never reads serial input and cannot be commanded.
// Wiring: HC-SR04 TRIG -> D7, ECHO -> D8; servo signal -> D9; servo on a separate 5-6 V
// supply with a common ground. Serial: 115200 baud.
#include <Servo.h>

const int TRIG_PIN = 7;
const int ECHO_PIN = 8;
const int SERVO_PIN = 9;
const long NEAR_MM = 50;      // shown as 0 degrees
const long FAR_MM = 500;      // shown as 180 degrees
const unsigned long PERIOD_MS = 50;      // 20 Hz telemetry
const unsigned long ANNOUNCE_MS = 5000;  // repeat hello + channels

Servo gauge;
byte cs = 0;
unsigned int seq = 0;
unsigned long nextSample = 0;
unsigned long nextAnnounce = 0;
unsigned long overruns = 0;
int angle = 90;

char hexDigit(byte n) { return n < 10 ? (char)('0' + n) : (char)('A' + n - 10); }
void out(char c) { Serial.write(c); cs = cs ^ c; }
void outText(const char s[]) { for (int i = 0; s[i] != 0; i++) out(s[i]); }
void outU(unsigned long v) {
  char b[11];
  int n = 0;
  do { b[n++] = (char)('0' + (v % 10)); v = v / 10; } while (v > 0);
  while (n > 0) out(b[--n]);
}
void begin(char type) { cs = 0; Serial.write('@'); out(type); }
void end() { Serial.write('*'); Serial.write(hexDigit((cs >> 4) & 15)); Serial.write(hexDigit(cs & 15)); Serial.write('\n'); }
void header(char type, unsigned long ms) { begin(type); out(','); outU(seq); out(','); outU(ms); seq = seq + 1; }

void announce() {
  begin('H'); outText(",1,VEYRIS-ARM-01,forge-ultrasonic-servo,1.0.0"); end();
  begin('C'); outText(",d,m,mm,HC-SR04 distance"); end();
  begin('C'); outText(",a,c,deg,servo command"); end();
}

// One HC-SR04 measurement in mm; -1 when there is no echo within 30 ms.
long readDistanceMm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long echoUs = pulseIn(ECHO_PIN, HIGH, 30000);
  if (echoUs == 0) return -1;
  return (long)(echoUs * 343UL / 2000UL);   // speed of sound ~343 m/s at 20 C
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  gauge.attach(SERVO_PIN);
  gauge.write(angle);
}

void loop() {
  unsigned long now = millis();
  if (now >= nextAnnounce) {
    announce();
    begin('S'); out(','); outU(seq); out(','); outU(now); outText(",ok,overruns="); outU(overruns); end();
    seq = seq + 1;
    nextAnnounce = now + ANNOUNCE_MS;
  }
  if (now < nextSample) return;
  if (now > nextSample + PERIOD_MS) overruns = overruns + 1;
  nextSample = now + PERIOD_MS;
  long mm = readDistanceMm();
  if (mm >= 0) {
    long c = constrain(mm, NEAR_MM, FAR_MM);
    angle = (int)((c - NEAR_MM) * 180L / (FAR_MM - NEAR_MM));
    gauge.write(angle);
  }
  header('D', now);
  outText(",d=");
  if (mm >= 0) outU((unsigned long)mm);
  outText(",a=");
  outU((unsigned long)angle);
  end();
  if (mm < 0) { header('E', now); outText(",no-echo"); end(); }
}
