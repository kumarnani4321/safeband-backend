/**
 * SafePulse AI Backend Server
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

// ─── Phone Normalizer: strips non-digits, takes last 10, adds +91 ────────────
function normalizePhone(phone) {
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (last10.length === 10) return `+91${last10}`;
  return phone; // return as-is if not 10 digits
}
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

function formatSMSDateTime() {
  const date = new Date();
  const options = {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  };
  return date.toLocaleString('en-IN', options).replace(/,/, '');
}

// ─── SMS Alert (Twilio / Mock) ────────────────────────────────────────────────
async function sendSMS(victimId, victimData, riskResult) {
  const { lat, lng } = victimData.location || { lat: 0, lng: 0 };
  const mapsLink = `https://maps.google.com/?q=${lat},${lng}`;
  const rawPhone = victimData.guardianPhone || process.env.GUARDIAN_PHONE;
  const targetPhone = normalizePhone(rawPhone);

  // Compact SMS — formatted with newlines and spacing for readability
  const textMessage = `\n\nSafePulse AI ALERT!\n${victimData.name || 'User'} needs help!\nRisk : ${riskResult.alertLevel} (${riskResult.score}/100)\nTime : ${formatSMSDateTime()}\nLocation : ${mapsLink}`;

  const messageRecord = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    to: targetPhone,
    text: textMessage,
    sent: false,
    victimId,
    phone: victimData.phone,
    score: riskResult.score,
    level: riskResult.alertLevel
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

  const uniqueKey = (phone && phone !== 'N/A') ? normalizePhone(phone) : victimId;
  victims.set(uniqueKey, victimData);

  // Fire alert if score >= 70
  let alertFired = null;
  if (riskResult.alertTriggered) {
    // Debounce: only send SMS if not alerted in last 30 seconds
    const lastAlert = alertHistory.find(a => a.phone === victimData.phone);
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

// GET /api/chat — Real-time AI Health Assistant
app.get('/api/chat', (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();
  let response = "I am your AI Health Assistant. Ask me basic medical questions (e.g. CPR, bleeding, heart rate, panic, shock) or how to keep safe.";

  if (!query) {
    return res.json({ reply: response });
  }

  if (query.includes('hi') || query.includes('hello') || query.includes('hey')) {
    response = "Hello! I am your SafePulse AI Health Assistant. How can I help you with your health or safety today? Try asking about 'first aid' or 'cpr'.";
  } else if (query.includes('cpr') || query.includes('cardiac') || query.includes('breath')) {
    response = "🏥 CPR Guideline:\n1. Call emergency services.\n2. Push hard and fast in the center of the chest (100-120 compressions per minute).\n3. Deliver rescue breaths if trained.";
  } else if (query.includes('bleed') || query.includes('cut') || query.includes('wound')) {
    response = "🩸 Bleeding Management:\n1. Apply firm, direct pressure to the wound with a clean cloth.\n2. Elevate the injured limb above heart level.\n3. Keep pressing until bleeding stops. Seek medical care if deep.";
  } else if (query.includes('panic') || query.includes('scream') || query.includes('fear') || query.includes('anxiety')) {
    response = "🧘 Dealing with Panic/Fear:\n1. Sit down and plant your feet firmly on the ground.\n2. Focus on slow, deep breathing: inhale for 4 seconds, hold for 4, exhale for 4.\n3. SafePulse AI has notified your guardian. Stay where you are; help is on the way.";
  } else if (query.includes('heart') || query.includes('pulse') || query.includes('bpm')) {
    response = "❤️ Heart Rate Info:\nA normal resting heart rate is 60-100 BPM. If the app detects >120 BPM during high stress, it raises your Risk Score. Cover the camera lens fully to get an accurate reading!";
  } else if (query.includes('shock') || query.includes('faint')) {
    response = "⚡ Shock/Fainting:\n1. Lay the person flat on their back.\n2. Elevate their feet about 12 inches.\n3. Keep them warm and comfortable. Do not give them anything to eat or drink.";
  } else if (query.includes('head') || query.includes('concussion') || query.includes('fall')) {
    response = "🧠 Head Injury:\n1. Keep the person completely still.\n2. Apply a cold pack wrapped in a cloth to reduce swelling.\n3. Watch for dizziness, vomiting, or confusion—seek immediate medical help if present.";
  } else if (query.includes('thank') || query.includes('ok') || query.includes('good')) {
    response = "You're very welcome! Stay safe and healthy. I am always here to assist you.";
  } else {
    response = "I understand you are asking about safety or health. For immediate emergencies, please press the SOS button. For first aid, you can ask me about 'CPR', 'bleeding', 'elevated heart rate', or 'panic attack'.";
  }

  res.json({ reply: response });
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
