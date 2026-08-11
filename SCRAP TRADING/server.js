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
    // Allow any localhost/127.0.0.1 origin in development
    if (origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/)) {
      return callback(null, true);
    }
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
// ENDPOINT: /api/classify-yolo (YOLO-based scrap classification)
// Uses Ultralytics Platform Inference API for object detection
// Protected: requires Firebase auth token + rate limited
// Inactive until ULTRALYTICS_API_KEY is configured in .env
// ============================================================
app.post("/api/classify-yolo", rateLimit, verifyFirebaseToken, upload.single("image"), async (req, res) => {
  logToFile(`--- YOLO Classify Request from ${req.user.email || req.user.uid} ---`);
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const apiKey = process.env.ULTRALYTICS_API_KEY;
    let modelId = process.env.ULTRALYTICS_MODEL_ID;

    // Guard: API key must be set (not placeholder)
    if (!apiKey || apiKey === 'your_ultralytics_api_key_here') {
      return res.status(503).json({
        error: "YOLO classification is not configured yet. The administrator needs to set the ULTRALYTICS_API_KEY in the server .env file.",
        inactive: true
      });
    }

    if (!modelId || modelId === 'your_model_id_here') {
      return res.status(503).json({
        error: "YOLO model ID is not configured yet. The administrator needs to set ULTRALYTICS_MODEL_ID in the server .env file.",
        inactive: true
      });
    }

    // Resolve common model name shortcuts to official Ultralytics model slugs
    const officialModelMap = {
      'yolo26n': 'ultralytics/yolo26/yolo26n',
      'yolo26s': 'ultralytics/yolo26/yolo26s',
      'yolo26m': 'ultralytics/yolo26/yolo26m',
      'yolo26l': 'ultralytics/yolo26/yolo26l',
      'yolo26x': 'ultralytics/yolo26/yolo26x',
      'yolo11n': 'ultralytics/yolo11/yolo11n',
      'yolo11s': 'ultralytics/yolo11/yolo11s',
      'yolo11m': 'ultralytics/yolo11/yolo11m',
      'yolo11l': 'ultralytics/yolo11/yolo11l',
      'yolo11x': 'ultralytics/yolo11/yolo11x',
      'yolov8n': 'ultralytics/yolov8/yolov8n',
      'yolov8s': 'ultralytics/yolov8/yolov8s',
      'yolov8m': 'ultralytics/yolov8/yolov8m',
      'yolov8l': 'ultralytics/yolov8/yolov8l',
      'yolov8x': 'ultralytics/yolov8/yolov8x',
    };

    // Normalize: strip .pt suffix, lowercase
    const modelKey = modelId.replace(/\.pt$/i, '').toLowerCase();
    if (officialModelMap[modelKey]) {
      modelId = officialModelMap[modelKey];
    }

    logToFile(`YOLO: Sending image to Ultralytics Platform API (model: ${modelId}, ${req.file.size} bytes)`);

    // Build multipart form data for Ultralytics Platform API
    // Field name must be "file", params are "conf", "iou", "imgsz"
    const boundary = '----FormBoundary' + Date.now().toString(16);
    const fileName = req.file.originalname || 'scrap-image.jpg';

    const parts = [];

    // Image file part (field name: "file")
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${req.file.mimetype}\r\n\r\n`
    ));
    parts.push(req.file.buffer);
    parts.push(Buffer.from('\r\n'));

    // Inference params (correct field names for Platform API)
    const params = { conf: 0.15, iou: 0.7, imgsz: 640 };
    for (const [key, value] of Object.entries(params)) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
        `${value}\r\n`
      ));
    }

    // Closing boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    // Call Ultralytics Platform Inference API
    // Try multiple URL formats to find the model
    const urlsToTry = [
      // Platform API with path segments (official models: ultralytics/yolo26/yolo26n)
      `https://platform.ultralytics.com/api/models/${modelId}/predict`,
      // Legacy HUB API format (older keys may use this)
      `https://api.ultralytics.com/v1/predict/${modelId}`,
    ];

    let response = null;
    let lastError = '';

    for (const url of urlsToTry) {
      logToFile(`YOLO: Trying ${url}`);
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'x-api-key': apiKey,
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          },
          body: body
        });

        if (response.ok) {
          logToFile(`YOLO: Success with ${url}`);
          break;
        }

        const errText = await response.text();
        lastError = errText;
        logToFile(`YOLO: ${url} returned ${response.status}: ${errText.substring(0, 150)}`);
        response = null; // Reset so we try next URL
      } catch (fetchErr) {
        lastError = fetchErr.message;
        logToFile(`YOLO: ${url} fetch error: ${fetchErr.message}`);
        response = null;
      }
    }

    if (!response || !response.ok) {
      // All URLs failed
      logToFile(`YOLO: All endpoints failed. Last error: ${lastError.substring(0, 200)}`);
      return res.status(502).json({
        error: `Could not reach YOLO model "${modelId}". Make sure your ULTRALYTICS_MODEL_ID is a valid model ID from your Ultralytics Platform account (found under your project's model list).`,
        details: lastError.substring(0, 200)
      });
    }

    const apiResult = await response.json();
    logToFile(`YOLO: Raw response keys: ${Object.keys(apiResult).join(', ')}`);
    if (apiResult.images) {
      logToFile(`YOLO: images array length: ${apiResult.images.length}`);
      if (apiResult.images[0]) {
        logToFile(`YOLO: images[0] keys: ${Object.keys(apiResult.images[0]).join(', ')}`);
        logToFile(`YOLO: images[0] results: ${JSON.stringify(apiResult.images[0].results || apiResult.images[0]).substring(0, 500)}`);
      }
    }
    logToFile(`YOLO: Full response (first 800 chars): ${JSON.stringify(apiResult).substring(0, 800)}`);

    // Parse Ultralytics Platform API response format:
    // { images: [{ shape: [h, w], results: [{class, name, confidence, box}] }], metadata: {...} }
    let detections = [];
    if (apiResult.images && apiResult.images.length > 0) {
      const img = apiResult.images[0];
      if (img.results && img.results.length > 0) {
        detections = img.results;
      } else if (img.data && Array.isArray(img.data)) {
        detections = img.data;
      }
    } else if (Array.isArray(apiResult)) {
      // Legacy format: direct array of detections
      detections = apiResult;
    } else if (apiResult.results) {
      detections = apiResult.results;
    } else if (apiResult.data) {
      detections = Array.isArray(apiResult.data) ? apiResult.data : [apiResult.data];
    }

    logToFile(`YOLO: Parsed ${detections.length} detections`);

    // No detections
    if (!detections || detections.length === 0) {
      return res.json({
        item_name: "Unknown",
        category: "Other",
        condition: "Good",
        confidence: "Low",
        notes: "No objects detected in the image. Try a clearer photo with the scrap material in focus.",
        detections: []
      });
    }

    // Get the top detection (highest confidence)
    const sortedDetections = detections.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const topDetection = sortedDetections[0];
    const detectedClass = topDetection.name || topDetection.class || String(topDetection.class ?? 'Unknown');
    const detectedConfidence = topDetection.confidence || 0;

    // Map detected class to scrap categories
    // This maps COCO-80 classes to scrap material types
    const categoryMap = {
      // Metal items (COCO objects that are typically metal)
      'scissors': 'Metal', 'knife': 'Metal', 'fork': 'Metal', 'spoon': 'Metal',
      'toaster': 'Metal', 'oven': 'Metal', 'microwave': 'Metal', 'sink': 'Metal',
      'refrigerator': 'Metal', 'bicycle': 'Metal', 'car': 'Metal', 'motorcycle': 'Metal',
      'bus': 'Metal', 'train': 'Metal', 'truck': 'Metal', 'boat': 'Metal',
      'fire hydrant': 'Metal', 'stop sign': 'Metal', 'parking meter': 'Metal',
      'keyboard': 'Metal', 'laptop': 'Metal', 'cell phone': 'Metal', 'mouse': 'Metal',
      'remote': 'Metal', 'clock': 'Metal', 'tv': 'Metal',
      'metal': 'Metal', 'aluminum': 'Metal', 'steel': 'Metal', 'iron': 'Metal',
      'copper': 'Metal', 'can': 'Metal', 'tin': 'Metal',
      // Plastic items
      'bottle': 'Plastic', 'cup': 'Plastic', 'bowl': 'Plastic', 'vase': 'Plastic',
      'frisbee': 'Plastic', 'sports ball': 'Plastic', 'skateboard': 'Plastic',
      'surfboard': 'Plastic', 'tennis racket': 'Plastic', 'wine glass': 'Plastic',
      'plastic': 'Plastic', 'container': 'Plastic', 'toothbrush': 'Plastic',
      'hair drier': 'Plastic',
      // Wood items
      'bench': 'Wood', 'chair': 'Wood', 'dining table': 'Wood', 'bed': 'Wood',
      'couch': 'Wood', 'baseball bat': 'Wood', 'skis': 'Wood',
      'wood': 'Wood', 'pallet': 'Wood', 'lumber': 'Wood',
      // Paper items
      'book': 'Paper', 'kite': 'Paper',
      'paper': 'Paper', 'cardboard': 'Paper', 'carton': 'Paper', 'box': 'Paper',
      // Fiber items
      'backpack': 'Fiber', 'handbag': 'Fiber', 'suitcase': 'Fiber',
      'tie': 'Fiber', 'umbrella': 'Fiber', 'teddy bear': 'Fiber',
      'fiber': 'Fiber', 'cloth': 'Fiber', 'textile': 'Fiber', 'sack': 'Fiber'
    };

    const classLower = detectedClass.toLowerCase().replace(/[_-]/g, ' ');
    let category = 'Other';
    for (const [keyword, cat] of Object.entries(categoryMap)) {
      if (classLower.includes(keyword)) {
        category = cat;
        break;
      }
    }

    // Map confidence to readable level
    let confidenceLevel = 'Low';
    if (detectedConfidence >= 0.75) confidenceLevel = 'High';
    else if (detectedConfidence >= 0.45) confidenceLevel = 'Medium';

    // Determine condition heuristic
    const condition = detectedConfidence >= 0.5 ? 'Good' : 'Poor';

    const result = {
      item_name: detectedClass.charAt(0).toUpperCase() + detectedClass.slice(1).replace(/_/g, ' '),
      category: category,
      condition: condition,
      confidence: confidenceLevel,
      confidence_score: Math.round(detectedConfidence * 100),
      notes: `YOLO detected "${detectedClass}" with ${Math.round(detectedConfidence * 100)}% confidence.${sortedDetections.length > 1 ? ` (${sortedDetections.length} objects detected total)` : ''}`,
      detections: sortedDetections.slice(0, 5).map(d => ({
        class: d.name || d.class || String(d.class ?? '?'),
        confidence: Math.round((d.confidence || 0) * 100)
      }))
    };

    // Save to Firestore (non-blocking)
    db.collection('scrap_classifications').add({
      ...result,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      source: 'yolo_classification',
      classifiedBy: req.user.email || req.user.uid
    }).catch(err => logToFile(`Firestore save error: ${err.message}`));

    logToFile(`YOLO Classification success: ${result.item_name} -> ${result.category} (${result.confidence_score}%)`);
    res.json(result);

  } catch (error) {
    logToFile(`ERROR /api/classify-yolo: ${error.message}`);
    res.status(500).json({ error: "YOLO classification failed. Please try again.", details: error.message });
  }
});

// ============================================================
// ENDPOINT: /api/classify-yolo/status
// Check if YOLO API is configured and active
// ============================================================
app.get("/api/classify-yolo/status", (req, res) => {
  const apiKey = process.env.ULTRALYTICS_API_KEY;
  const modelId = process.env.ULTRALYTICS_MODEL_ID;
  const isActive = apiKey && apiKey !== 'your_ultralytics_api_key_here' &&
                   modelId && modelId !== 'your_model_id_here';
  res.json({
    active: isActive,
    model: modelId || null,
    message: isActive
      ? "YOLO classification is active and ready."
      : "YOLO classification is inactive. Set ULTRALYTICS_API_KEY and ULTRALYTICS_MODEL_ID in .env to activate."
  });
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
