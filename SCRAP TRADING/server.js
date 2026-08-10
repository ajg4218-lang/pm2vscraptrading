import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();

// ============================================================
// LOGGING
// ============================================================
const logToFile = (message) => {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try { fs.appendFileSync('server_debug.log', line); } catch (e) { /* ignore */ }
  console.log(message);
};

// ============================================================
// FIREBASE ADMIN INITIALIZATION
// ============================================================
if (!admin.apps.length) {
  try {
    admin.initializeApp({ projectId: "pm2vstorage" });
    logToFile('Firebase Admin initialized');
  } catch (err) {
    logToFile(`Firebase Init Error: ${err.message}`);
  }
}
const db = admin.firestore();

// ============================================================
// EXPRESS APP SETUP
// ============================================================
const app = express();

// CORS: Restrict to known origins (adjust for your deployed URL)
const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5501',
  'http://127.0.0.1:5501',
  // Add your deployed frontend URL here:
  // 'https://pm2vscraptrading.web.app',
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman in dev)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json());

// ============================================================
// RATE LIMITING (Simple in-memory, per-IP)
// ============================================================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // max 10 requests per minute per IP

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return next();
  }

  const entry = rateLimitMap.get(ip);
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Reset window
    entry.count = 1;
    entry.windowStart = now;
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    logToFile(`Rate limit exceeded for IP: ${ip}`);
    return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
  }

  next();
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// FIREBASE TOKEN VERIFICATION MIDDLEWARE
// ============================================================
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    logToFile(`Token verification failed: ${error.message}`);
    return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
  }
}

// ============================================================
// MULTER SETUP
// ============================================================
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    // Only allow image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// ============================================================
// GEMINI AI SETUP
// ============================================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// ============================================================
// ENDPOINT: /api/analyze-scrap (Full classification)
// Protected: requires Firebase auth token + rate limited
// ============================================================
app.post("/api/analyze-scrap", rateLimit, verifyFirebaseToken, upload.single("image"), async (req, res) => {
  logToFile(`--- Analysis Request from ${req.user.email || req.user.uid} ---`);
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }
    logToFile(`File: ${req.file.mimetype}, ${req.file.size} bytes`);

    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
      return res.status(500).json({ error: "Server configuration error: Missing API Key" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `
You are a scrap material expert in the Philippines. Analyze the image and classify the scrap material. 

Identify: 
- item_name (e.g. Plastic Bottle, Aluminum Can, Copper Wire, etc.)
- scrap_type (e.g. plastic, metal, e-waste, paper)
- category (ferrous, non-ferrous, recyclable, etc.)
- condition (damaged or still usable)
- possible_customers (e.g. junkshop, recycling plant, factory)

Return ONLY JSON format:
{
  "item_name": "",
  "scrap_type": "",
  "category": "",
  "condition": "",
  "possible_customers": [],
  "confidence": ""
}

If the image is NOT a scrap material, return EXACTLY this message:
"I'm not sure because this does not appear to be a scrap material."
`;

    const result = await model.generateContent([
      { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } },
      prompt,
    ]);

    const response = await result.response;

    if (!response.candidates || response.candidates.length === 0) {
      return res.status(500).json({ error: "AI failed to generate a response. Please try again." });
    }

    if (response.candidates[0].finishReason !== 'STOP') {
      const reason = response.candidates[0].finishReason;
      return res.status(400).json({
        error: `Analysis was interrupted: ${reason}. Try with a clearer image.`
      });
    }

    let text = response.text();

    // Check "not sure" response
    if (text.toLowerCase().includes("not sure") || text.toLowerCase().includes("not appear to be a scrap")) {
      return res.json({ error: "I'm not sure because this does not appear to be a scrap material." });
    }

    // Extract JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      text = jsonMatch[0];
    } else {
      text = text.replace(/```json|```/gi, '').trim();
    }

    if (!text.startsWith('{')) {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        text = text.substring(start, end + 1);
      }
    }

    const jsonData = JSON.parse(text);

    // Normalize possible_customers
    if (jsonData.possible_customers && !Array.isArray(jsonData.possible_customers)) {
      jsonData.possible_customers = typeof jsonData.possible_customers === 'string'
        ? jsonData.possible_customers.split(',').map(s => s.trim())
        : [String(jsonData.possible_customers)];
    } else if (!jsonData.possible_customers) {
      jsonData.possible_customers = [];
    }

    // Save to Firestore (non-blocking)
    db.collection('scrap_items').add({
      ...jsonData,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending_review',
      source: 'ai_classification',
      classifiedBy: req.user.email || req.user.uid
    }).catch(err => logToFile(`Firestore save error: ${err.message}`));

    logToFile(`Classification success: ${jsonData.item_name}`);
    res.json(jsonData);

  } catch (error) {
    logToFile(`ERROR /api/analyze-scrap: ${error.message}`);
    if (error instanceof SyntaxError) {
      return res.status(500).json({ error: "AI returned an invalid format. Please try again." });
    }
    res.status(500).json({ error: "Analysis failed. Please try again.", details: error.message });
  }
});

// ============================================================
// ENDPOINT: /api/classify (Simple classification for inventory)
// Protected: requires Firebase auth token + rate limited
// ============================================================
app.post("/api/classify", rateLimit, verifyFirebaseToken, upload.single("image"), async (req, res) => {
  logToFile(`--- Classify Request from ${req.user.email || req.user.uid} ---`);
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
      return res.status(500).json({ error: "Server configuration error: Missing API Key" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `You are a scrap material classification expert for a recycling/junkshop system.

Analyze the image and return ONLY valid JSON with exactly these fields:
{
  "item_name": "specific name of the scrap material (e.g. 'Aluminum Cans', 'PET Bottles', 'Cardboard Boxes')",
  "category": "one of: Metal, Plastic, Wood, Paper, Fiber",
  "condition": "Good or Poor",
  "confidence": "High, Medium, or Low",
  "notes": "brief 1-sentence observation about why you classified it this way"
}

Rules:
- item_name should be specific and descriptive
- category must be exactly one of: Metal, Plastic, Wood, Paper, Fiber
- condition: Good = clean/intact/usable; Poor = rusted/broken/contaminated
- Return ONLY the JSON object, no extra text`;

    const result = await model.generateContent([
      { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } },
      prompt
    ]);

    const response = await result.response;
    let text = response.text();

    // Extract JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0];
    else text = text.replace(/```json|```/gi, '').trim();

    const data = JSON.parse(text);
    logToFile(`Classify success: ${data.item_name} -> ${data.category}`);
    res.json(data);

  } catch (error) {
    logToFile(`ERROR /api/classify: ${error.message}`);
    res.status(500).json({ error: "Classification failed. Please try again." });
  }
});

// ============================================================
// LEGACY ENDPOINT: /predict (kept for backward compat, now protected)
// ============================================================
app.post("/predict", rateLimit, verifyFirebaseToken, upload.single("image"), async (req, res) => {
  logToFile('--- Predict Request (legacy) ---');
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Classify this scrap material. Return JSON: {"category": "Metal|Plastic|Wood|Paper|Fiber", "confidence": "0-100%"}`;

    const result = await model.generateContent([
      { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } },
      prompt
    ]);

    const response = await result.response;
    let text = response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0];

    const data = JSON.parse(text);
    res.json(data);
  } catch (error) {
    logToFile(`Error in /predict: ${error.message}`);
    res.status(500).json({ error: "Prediction failed" });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============================================================
// ERROR HANDLING
// ============================================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: "File too large. Maximum size is 10MB." });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  logToFile(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PM2V Server running on port ${PORT}`);
  logToFile(`Server started on port ${PORT}`);
});
