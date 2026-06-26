/**
 * AI SafeBand Backend Server
 * Express + WebSocket Risk Engine
 * 
 * Risk Scoring:
 *   Shake (accelerometer) > threshold  → +40 pts
 *   Scream detected (mic)              → +35 pts
 *   BPM > 120 (camera rPPG)           → +25 pts
 *   SOS pressed                        → +95 pts instantly
 *   Score > 70                         → ALERT TRIGGERED
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// Twilio Setup (Optional, only fails if missing and we try to send real SMS)
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = (twilioAccountSid && twilioAuthToken)
  ? require('twilio')(twilioAccountSid, twilioAuthToken)
  : null;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── CORS: allow all origins including Firebase Hosting ─────────────────────
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder', 'x-requested-with'],
  preflightContinue: false,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle all OPTIONS preflight explicitly
app.use(express.json());

// ─── In-memory Data Store ────────────────────────────────────────────────────
const victims = new Map();       // victimId → victimData
const alertHistory = [];         // All fired alerts
const connectedGuardians = new Set(); // WebSocket clients (guardians)

// ─── Risk Engine ─────────────────────────────────────────────────────────────
function calculateRiskScore(sensorData) {
  let score = 0;
  const reasons = [];

  // SOS button - immediate 95 pts
  if (sensorData.sosPressed) {
    score += 95;
    reasons.push('🆘 SOS button pressed (+95 pts)');
  }

  // Accelerometer shake
  const shakeValue = sensorData.shakeIntensity || 0;
  if (shakeValue > 5) {
    score += 40;
    reasons.push(`📳 Violent shake detected: ${shakeValue.toFixed(1)} (+40 pts)`);
  } else if (shakeValue > 2.5) {
    score += 20;
    reasons.push(`📳 Moderate shake: ${shakeValue.toFixed(1)} (+20 pts)`);
  }

  // Microphone scream
  if (sensorData.screamDetected) {
    score += 35;
    reasons.push(`🎙️ Scream detected (${sensorData.audioLevel?.toFixed(0)}dB) (+35 pts)`);
  }

  // Heart rate (camera rPPG)
  const bpm = sensorData.heartRate || 0;
  if (bpm > 140) {
    score += 25;
    reasons.push(`❤️ Critical BPM: ${bpm} (+25 pts)`);
  } else if (bpm > 120) {
    score += 15;
    reasons.push(`❤️ Elevated BPM: ${bpm} (+15 pts)`);
  }

  const alertTriggered = score >= 70;
  const alertLevel = score >= 95 ? 'CRITICAL' : score >= 70 ? 'DANGER' : score >= 40 ? 'WARNING' : 'SAFE';

  return { score: Math.min(score, 100), reasons, alertTriggered, alertLevel };
}

// ─── SMS Alert (Twilio / Mock) ────────────────────────────────────────────────
async function sendSMS(victimId, victimData, riskResult) {
  const { lat, lng } = victimData.location || { lat: 0, lng: 0 };
  const mapsLink = `https://maps.google.com/?q=${lat},${lng}`;
  const targetPhone = victimData.guardianPhone || process.env.GUARDIAN_PHONE;

  const textMessage = `SafeBand Alert: ${victimData.name || 'User'}!
Risk:${riskResult.score}
Loc:${mapsLink}`;

  const messageRecord = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    to: targetPhone,
    text: textMessage,
    sent: false,
    victimId
  };

  alertHistory.unshift(messageRecord);
  if (alertHistory.length > 50) alertHistory.pop();

  console.log('\n📱 [SMS ALERT INITIATED]');
  console.log('To:', targetPhone);
  console.log('Message:', textMessage);

  if (twilioClient && twilioPhoneNumber) {
    try {
      console.log('➡️  Sending real SMS via Twilio...');
      const response = await twilioClient.messages.create({
        body: textMessage,
        from: twilioPhoneNumber,
        to: targetPhone
      });
      console.log(`✅ Twilio SMS sent! SID: ${response.sid}`);
      messageRecord.sent = true;
    } catch (err) {
      console.error(`❌ Twilio Error: ${err.message}`);
    }
  } else {
    console.log('⚠️  Twilio not configured. [MOCK SMS ONLY]');
    messageRecord.sent = true; // Pretend it sent for UI
  }

  console.log('─'.repeat(60));
  return messageRecord;
}

// ─── Broadcast to all Guardians via WebSocket ─────────────────────────────────
function broadcastToGuardians(data) {
  const payload = JSON.stringify(data);
  connectedGuardians.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ─── WebSocket Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  connectedGuardians.add(ws);
  console.log(`👁️  Guardian connected [${clientId}] | Total: ${connectedGuardians.size}`);

  // Send current state on connect
  ws.send(JSON.stringify({
    type: 'INIT',
    victims: Array.from(victims.values()),
    alertHistory: alertHistory.slice(0, 20)
  }));

  ws.on('close', () => {
    connectedGuardians.delete(ws);
    console.log(`👁️  Guardian disconnected [${clientId}] | Total: ${connectedGuardians.size}`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    connectedGuardians.delete(ws);
  });
});

// ─── REST API Routes ──────────────────────────────────────────────────────────

// POST /api/sensor — Victim app sends sensor data every 5 seconds
app.post('/api/sensor', (req, res) => {
  const {
    victimId,
    name,
    phone,
    guardianName,
    guardianPhone,
    location,
    shakeIntensity,
    screamDetected,
    audioLevel,
    heartRate,
    sosPressed,
    timestamp
  } = req.body;

  if (!victimId) {
    return res.status(400).json({ error: 'victimId required' });
  }

  // Run risk engine
  const sensorData = { shakeIntensity, screamDetected, audioLevel, heartRate, sosPressed };
  const riskResult = calculateRiskScore(sensorData);

  // Update victim in store
  const victimData = {
    victimId,
    name: name || 'Unknown',
    phone: phone || 'N/A',
    guardianName: guardianName || 'Guardian',
    guardianPhone: guardianPhone || '',
    location: location || { lat: 0, lng: 0 },
    heartRate: heartRate || 0,
    shakeIntensity: shakeIntensity || 0,
    screamDetected: screamDetected || false,
    audioLevel: audioLevel || 0,
    sosPressed: sosPressed || false,
    riskScore: riskResult.score,
    alertLevel: riskResult.alertLevel,
    riskReasons: riskResult.reasons,
    alertTriggered: riskResult.alertTriggered,
    lastSeen: timestamp || new Date().toISOString()
  };

  victims.set(victimId, victimData);

  // Fire alert if score >= 70
  let alertFired = null;
  if (riskResult.alertTriggered) {
    // Debounce: only send SMS if not alerted in last 30 seconds
    const lastAlert = alertHistory.find(a => a.victimId === victimId);
    const lastAlertAge = lastAlert ? (Date.now() - new Date(lastAlert.timestamp).getTime()) : Infinity;

    if (lastAlertAge > 30000) {
      // Execute asynchronously to avoid blocking the HTTP response
      sendSMS(victimId, victimData, riskResult).then(msg => {
        alertFired = msg;
        // Broadcast the update when SMS finishes (success or mock)
        broadcastToGuardians({
          type: 'VICTIM_UPDATE',
          victim: victimData,
          alert: alertFired
        });
      });
    }
  }

  // Initial broadcast for UI without waiting for SMS
  broadcastToGuardians({
    type: 'VICTIM_UPDATE',
    victim: victimData,
    alert: null
  });

  console.log(`📊 [${victimData.name}] Score: ${riskResult.score} | Level: ${riskResult.alertLevel} | BPM: ${heartRate} | Shake: ${shakeIntensity?.toFixed(1)}`);

  res.json({
    success: true,
    riskScore: riskResult.score,
    alertLevel: riskResult.alertLevel,
    alertTriggered: riskResult.alertTriggered,
    reasons: riskResult.reasons,
    alertFired: !!alertFired
  });
});

// GET /api/victims — Get all active victims
app.get('/api/victims', (req, res) => {
  res.json({
    victims: Array.from(victims.values()),
    count: victims.size
  });
});

// GET /api/alerts — Get alert history
app.get('/api/alerts', (req, res) => {
  res.json({
    alerts: alertHistory,
    count: alertHistory.length
  });
});

// GET /api/health — Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    victims: victims.size,
    guardians: connectedGuardians.size,
    alerts: alertHistory.length,
    timestamp: new Date().toISOString()
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       🛡️  AI SafeBand Backend              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  HTTP  → http://localhost:${PORT}/api/health`);
  console.log(`  WS    → ws://localhost:${PORT}`);
  console.log('');
  console.log('  Risk Scoring:');
  console.log('    Shake > threshold  → +40 pts');
  console.log('    Scream detected    → +35 pts');
  console.log('    BPM > 120          → +25 pts');
  console.log('    SOS pressed        → +95 pts');
  console.log('    Score > 70         → ALERT 🚨');
  console.log('');
});
