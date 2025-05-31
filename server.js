// server.js

/**
 * 1) Relay between Arduino (serial) and WebSocket clients (App).
 * 2) Watch Firestore’s doorState/current document and forward LOCK/CLOSE or UNLOCK/OPEN commands to Arduino.
 */

const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const WebSocket = require("ws");
const admin = require("firebase-admin");
const path = require("path");

// ——————————————
// 1) Initialize Firebase Admin (server‐side)
// ——————————————

// Replace "server-service-account.json" with the path to your downloaded service account key
const serviceAccount = require(path.resolve(__dirname, "server-service-account.json"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ——————————————
// 2) Open Serial Port to Arduino
// ——————————————

const ARDUINO_COM_PORT = "COM6"; // ← adjust to your Arduino’s COM port
const BAUD_RATE = 9600;

const port = new SerialPort(
  { path: ARDUINO_COM_PORT, baudRate: BAUD_RATE },
  (err) => {
    if (err) {
      console.error("Error opening serial port:", err.message);
      process.exit(1);
    }
    console.log(`Serial port open on ${ARDUINO_COM_PORT} @ ${BAUD_RATE} baud`);
  }
);

const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

// ——————————————
// 3) Start WebSocket Server
// ——————————————

const WS_PORT = 8080;
const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`WebSocket server running on ws://localhost:${WS_PORT}`);
});

// Whenever Arduino prints a line, broadcast it to all connected WS clients
parser.on("data", (line) => {
  const msg = line.trim();
  console.log("⇐ From Arduino:", msg);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
});

// Handle incoming WS messages (e.g. PASSCODE:1234, CLOSE, RESET)
wss.on("connection", (ws) => {
  console.log("⇒ App connected");

  ws.on("message", (rawMsg) => {
    const message = rawMsg.toString().trim();
    console.log("⇒ To Arduino:", message);

    // If the message is a passcode from the app
    if (message.startsWith("PASSCODE:")) {
      port.write(message + "\n", (err) => {
        if (err) console.error("Error writing PASSCODE to serial:", err.message);
      });
    }
    // If the app sends "CLOSE", forward to Arduino
    else if (message === "CLOSE") {
      port.write("CLOSE\n", (err) => {
        if (err) console.error("Error writing CLOSE to serial:", err.message);
      });
    }
    // If the app sends "RESET", forward to Arduino
    else if (message === "RESET") {
      port.write("RESET\n", (err) => {
        if (err) console.error("Error writing RESET to serial:", err.message);
      });
    } else {
      // Forward any other free-form message
      port.write(message + "\n", (err) => {
        if (err) console.error("Error writing message to serial:", err.message);
      });
    }
  });

  ws.on("close", () => console.log("⇐ App disconnected"));
  ws.on("error", (err) => console.error("WebSocket error:", err));
});

// ——————————————
// 4) Watch Firestore's doorState/current doc
// ——————————————

const doorStateDocRef = db.collection("doorState").doc("current");

doorStateDocRef.onSnapshot(
  (docSnapshot) => {
    if (!docSnapshot.exists) {
      // If doc not exist, create default { state: "closed" }
      doorStateDocRef.set({ state: "closed" });
      return;
    }
    const data = docSnapshot.data();
    if (!data || !data.state) return;

    const newState = data.state; // "open" or "closed"
    console.log("Firestore doorState changed to:", newState);

    if (newState === "open") {
      // Tell Arduino to open door (UNLOCK)
      port.write("UNLOCK\n", (err) => {
        if (err) console.error("Error writing UNLOCK to serial:", err.message);
      });
    } else if (newState === "closed") {
      // Tell Arduino to close door (LOCK)
      port.write("LOCK\n", (err) => {
        if (err) console.error("Error writing LOCK to serial:", err.message);
      });
    }
  },
  (error) => {
    console.error("Error watching doorState:", error);
  }
);
