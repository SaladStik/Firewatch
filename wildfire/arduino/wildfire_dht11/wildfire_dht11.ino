/*
  Wildfire sensor server for Arduino UNO R4 WiFi + a 3-pin DHT11.

  Wiring used by this project:
    DHT11 DATA/OUT -> D2
    DHT11 VCC      -> 5V
    DHT11 GND      -> GND

  The board stays independent of the computer. Power it from USB or a power bank.
  It joins the Wi-Fi named in secrets.h and serves:
    GET /            human-readable temperature and humidity
    GET /api/sensor  JSON for the wildfire application

  If you already have a sketch that serves a page, keep that page and copy
  sendSensorJson() plus the "/api/sensor" check into it. This file does not
  remove the human page; it adds the JSON endpoint beside it.

  Install the "DHT sensor library" by Adafruit and its Adafruit Unified Sensor
  dependency. Copy secrets.h.example to secrets.h and set the Wi-Fi name and
  password there. secrets.h is gitignored.

  After upload, open the Serial Monitor at 115200 baud. It prints the URL to
  put in ARDUINO_URL. Do not commit the Wi-Fi password.
*/

#include <WiFiS3.h>
#include <DHT.h>
#include "secrets.h"

const int DHT_PIN = 2;
const unsigned long MIN_DHT_INTERVAL_MS = 2000;
const unsigned long CLIENT_TIMEOUT_MS = 2000;

DHT dht(DHT_PIN, DHT11);
WiFiServer server(80);

float cachedTempC = NAN;
float cachedHumidity = NAN;
bool cachedOk = false;
unsigned long lastDhtAttemptMs = 0;
bool serverStarted = false;

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.print("Connecting to Wi-Fi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi unavailable");
    return;
  }

  if (!serverStarted) {
    server.begin();
    serverStarted = true;
  }
  Serial.print("Human page: http://");
  Serial.println(WiFi.localIP());
  Serial.print("Sensor JSON: http://");
  Serial.print(WiFi.localIP());
  Serial.println("/api/sensor");
  Serial.println("Set ARDUINO_URL to the human-page address.");
}

void updateDht() {
  unsigned long now = millis();
  if (lastDhtAttemptMs != 0 && (now - lastDhtAttemptMs) < MIN_DHT_INTERVAL_MS) {
    return;
  }
  lastDhtAttemptMs = now;

  float humidity = dht.readHumidity();
  float temperatureC = dht.readTemperature();
  if (isnan(humidity) || isnan(temperatureC)) {
    cachedOk = false;
    Serial.println("DHT11 read failed");
    return;
  }
  cachedOk = true;
  cachedHumidity = humidity;
  cachedTempC = temperatureC;
}

void sendSensorJson(WiFiClient &client) {
  updateDht();
  if (!cachedOk) {
    client.println("HTTP/1.1 503 Service Unavailable");
  } else {
    client.println("HTTP/1.1 200 OK");
  }
  client.println("Content-Type: application/json");
  client.println("Connection: close");
  client.println("Cache-Control: no-store");
  client.println();
  if (!cachedOk) {
    client.println("{\"ok\":false,\"error\":\"dht_read_failure\",\"temperature\":null,\"humidity\":null,\"unit\":\"C\"}");
    return;
  }
  client.print("{\"ok\":true,\"temperature\":");
  client.print(cachedTempC, 1);
  client.print(",\"humidity\":");
  client.print(cachedHumidity, 1);
  client.println(",\"unit\":\"C\"}");
}

void sendPage(WiFiClient &client) {
  updateDht();
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/html; charset=utf-8");
  client.println("Connection: close");
  client.println("Refresh: 8");
  client.println();
  client.println("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>DHT11</title></head><body>");
  client.println("<h1>Arduino DHT11</h1>");
  client.println("<p>Local sensor page. The wildfire app reads JSON from /api/sensor.</p>");
  if (!cachedOk) {
    client.println("<p>DHT11 read failed.</p>");
  } else {
    client.print("<p>Temperature: ");
    client.print(cachedTempC, 1);
    client.println(" &deg;C</p>");
    client.print("<p>Humidity: ");
    client.print(cachedHumidity, 1);
    client.println(" %</p>");
  }
  client.println("</body></html>");
}

void handleClient(WiFiClient &client) {
  char requestLine[120];
  size_t length = 0;
  requestLine[0] = '\0';
  bool lineDone = false;
  int marker = 0;
  unsigned long started = millis();

  while (client.connected() && (millis() - started) < CLIENT_TIMEOUT_MS) {
    if (!client.available()) {
      delay(1);
      continue;
    }
    char c = client.read();
    if (!lineDone) {
      if (c == '\n') {
        lineDone = true;
      } else if (c != '\r' && length + 1 < sizeof(requestLine)) {
        requestLine[length++] = c;
        requestLine[length] = '\0';
      }
    }
    if (c == "\r\n\r\n"[marker]) {
      marker++;
      if (marker == 4) {
        break;
      }
    } else {
      marker = (c == '\r') ? 1 : 0;
    }
  }

  bool sensorRoute = strncmp(requestLine, "GET /api/sensor", 15) == 0 &&
                     (requestLine[15] == ' ' || requestLine[15] == '?' || requestLine[15] == '\0');
  if (sensorRoute) {
    sendSensorJson(client);
  } else {
    sendPage(client);
  }
  delay(1);
  client.stop();
}

void setup() {
  Serial.begin(115200);
  dht.begin();

  if (WiFi.status() == WL_NO_MODULE) {
    Serial.println("Wi-Fi module not found");
    while (true) {
      delay(1000);
    }
  }

  String firmware = WiFi.firmwareVersion();
  if (firmware < WIFI_FIRMWARE_LATEST_VERSION) {
    Serial.println("Wi-Fi firmware is older than this library expects. The server will still start.");
  }
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
    return;
  }
  WiFiClient client = server.available();
  if (client) {
    handleClient(client);
  }
}
