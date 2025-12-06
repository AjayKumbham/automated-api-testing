import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import validator from "validator";
import { GoogleGenerativeAI } from "@google/generative-ai";
import NodeCache from 'node-cache';
import pLimit from 'p-limit';

dotenv.config();

// Validate environment on startup
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY is required");
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
    }
  }
}));

// CORS configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173', 'http://localhost:3001'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};
app.use(cors(corsOptions));

app.use(bodyParser.json({ limit: '10mb' }));

// Rate limiting
const testGenerationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { success: false, error: 'Too many requests. Please try again later.' }
});

// =============
// CACHING + CONCURRENCY
// =============
const generatedCache = new NodeCache({ stdTTL: 60 * 60 }); // 1 hour TTL
const defaultConcurrency = parseInt(process.env.REQUEST_CONCURRENCY || '8', 10);

// ============================================
// GEMINI INITIALIZATION (JSON mode, no strict schema)
// ============================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.15,
    topP: 0.8,
    topK: 40,
    maxOutputTokens: 8192,
    // Keep JSON output but avoid strict responseSchema that enforces object properties
    responseMimeType: "application/json"
  }
});

// ============================================
// VALIDATION UTILITIES
// ============================================
class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    throw new ValidationError('Email is required', 'email');
  }
  const trimmed = email.trim();
  if (!validator.isEmail(trimmed)) {
    throw new ValidationError('Invalid email format', 'email');
  }
  const parts = trimmed.split('@');
  if (parts[0].length === 0 || parts[1].length < 3) {
    throw new ValidationError('Invalid email format', 'email');
  }
  if (trimmed.length > 254) {
    throw new ValidationError('Email too long', 'email');
  }
  return trimmed;
}

function containsXSS(input) {
  if (!input || typeof input !== 'string') return false;
  const xssPatterns = [
    /<script[\s\S]*?>/i,
    /<iframe[\s\S]*?>/i,
    /<object[\s\S]*?>/i,
    /<embed[\s\S]*?>/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /<img[\s\S]*?onerror/i,
    /<svg[\s\S]*?onload/i,
    /<body[\s\S]*?onload/i,
    /eval\(/i,
    /expression\(/i,
    /vbscript:/i,
    /data:text\/html/i
  ];
  return xssPatterns.some(pattern => pattern.test(input));
}

function containsSQLInjection(input) {
  if (!input || typeof input !== 'string') return false;
  const sqlPatterns = [
    /(\bOR\b|\bAND\b).*?=.*?/i,
    /'\s*(OR|AND)\s*'?\d*'?\s*=\s*'?\d/i,
    /--/,
    /;.*?(DROP|DELETE|INSERT|UPDATE|CREATE|ALTER)/i,
    /UNION.*?SELECT/i,
    /\/\*.*?\*\//,
    /xp_cmdshell/i,
    /EXEC\s*\(/i,
    /EXECUTE\s*\(/i,
    /'\s*;\s*/,
    /0x[0-9a-f]+/i,
    /CHAR\s*\(/i,
    /CONCAT\s*\(/i,
    /LOAD_FILE/i,
    /INTO\s+OUTFILE/i,
    /WAITFOR\s+DELAY/i,
    /BENCHMARK\s*\(/i
  ];
  return sqlPatterns.some(pattern => pattern.test(input));
}

function containsPathTraversal(input) {
  if (!input || typeof input !== 'string') return false;
  const pathPatterns = [
    /\.\.[\/\\]/,
    /[\/\\]\.\.[\/\\]/,
    /%2e%2e[\/\\]/i,
    /\.\.%2f/i,
    /etc[\/\\]passwd/i,
    /windows[\/\\]system/i
  ];
  return pathPatterns.some(pattern => pattern.test(input));
}

function sanitizeString(input, maxLength = 100) {
  if (!input || typeof input !== 'string') {
    throw new ValidationError('Invalid input type', 'input');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('Input cannot be empty', 'input');
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(`Input too long (max ${maxLength} characters)`, 'input');
  }
  if (containsXSS(trimmed)) {
    throw new ValidationError('Invalid characters detected (XSS)', 'input');
  }
  if (containsSQLInjection(trimmed)) {
    throw new ValidationError('Invalid characters detected (SQL)', 'input');
  }
  if (containsPathTraversal(trimmed)) {
    throw new ValidationError('Invalid characters detected (Path)', 'input');
  }
  return trimmed;
}

function validateMethod(method) {
  const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
  const upper = method?.toUpperCase();
  if (!validMethods.includes(upper)) {
    throw new ValidationError('Invalid HTTP method', 'method');
  }
  return upper;
}

function validateEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new ValidationError('Endpoint is required', 'endpoint');
  }
  const trimmed = endpoint.trim();
  if (!trimmed.startsWith('/')) {
    throw new ValidationError('Endpoint must start with /', 'endpoint');
  }
  if (trimmed.length > 500) {
    throw new ValidationError('Endpoint too long', 'endpoint');
  }
  if (containsPathTraversal(trimmed)) {
    throw new ValidationError('Invalid endpoint pattern', 'endpoint');
  }
  return trimmed;
}

// ============================================
// MOCK API ENDPOINTS
// ============================================
app.get("/", (req, res) => {
  res.json({ 
    status: "✅ Backend running with native JSON mode!",
    version: "2.2.0",
    features: [
      "Native JSON output (loose mode)",
      "Caching for generation results",
      "Concurrency-limited test execution",
      "Improved retry/backoff for Gemini",
      "SSE streaming endpoint for real-time updates"
    ]
  });
});

app.post("/users", (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ 
        success: false,
        error: "Request body is required",
        code: "INVALID_BODY"
      });
    }
    const { name, email } = req.body;
    let sanitizedName;
    try {
      sanitizedName = sanitizeString(name, 100);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err.message,
        field: err.field,
        code: "INVALID_NAME"
      });
    }
    let sanitizedEmail;
    try {
      sanitizedEmail = validateEmail(email);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err.message,
        field: err.field,
        code: "INVALID_EMAIL"
      });
    }
    res.status(201).json({
      success: true,
      data: {
        id: Math.random().toString(36).substr(2, 9),
        name: sanitizedName,
        email: sanitizedEmail,
        created_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error("Error in /users:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "SERVER_ERROR"
    });
  }
});

app.get("/users", (req, res) => {
  res.status(200).json({
    success: true,
    data: [
      { id: "1", name: "John Doe", email: "john@example.com" },
      { id: "2", name: "Jane Smith", email: "jane@example.com" }
    ]
  });
});

app.get("/users/:id", (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).json({
      success: false,
      error: "Invalid user ID format",
      code: "INVALID_ID"
    });
  }
  if (id === "1") {
    return res.status(200).json({
      success: true,
      data: { id: "1", name: "John Doe", email: "john@example.com" }
    });
  }
  res.status(404).json({
    success: false,
    error: "User not found",
    code: "NOT_FOUND"
  });
});

// ============================================
// PROMPT BUILDER (simplified)
// ============================================
function buildEnhancedPrompt(spec) {
  const methodsWithBody = ['POST', 'PUT', 'PATCH'];
  const hasBody = methodsWithBody.includes(spec.method);
  return `Generate exactly 12 API test cases for this endpoint:

API Details:
- Method: ${spec.method}
- Endpoint: ${spec.endpoint}
- Expected Success Status: ${spec.expected_response?.status || 200}
${hasBody ? `- Request Body Structure: ${JSON.stringify(spec.body || {})}` : '- No body (GET/DELETE request)'}

Requirements:
1. Generate exactly 12 test cases with IDs: TC_001 through TC_012

2. Distribution:
   - TC_001 to TC_003: category "valid" - Tests that should succeed with status ${spec.expected_response?.status || 200}
   - TC_004 to TC_007: category "invalid" - Missing required fields, wrong data types, malformed data. Status 400
   - TC_008 to TC_010: category "boundary" - Empty values, extremely long strings, edge cases. Status 400
   - TC_011 to TC_012: category "security" - XSS attempts, SQL injection attempts. Status 400

3. For each test case provide: id, category, description, request (method, endpoint, headers, optional body), expected_response (status, optional body_contains/body_not_contains).

CRITICAL: Return ONLY a valid JSON array starting with [ and ending with ]. Do not include any markdown formatting, explanations, or code blocks. Just the raw JSON array.

Example format:
[
  {
    "id": "TC_001",
    "category": "valid",
    "description": "Valid request with all required fields",
    "request": {
      "method": "${spec.method}",
      "endpoint": "${spec.endpoint}",
      "headers": {"Content-Type": "application/json"},
      "body": ${hasBody ? JSON.stringify(spec.body || {}) : 'null'}
    },
    "expected_response": {
      "status": ${spec.expected_response?.status || 200}
    }
  }
]`;
}

// ============================================
// Small JSON extractor fallback (robust but simple)
// ============================================
function extractArrayFromText(text) {
  if (!text || typeof text !== 'string') return null;
  
  // Try multiple extraction strategies
  
  // Strategy 1: Remove Markdown code fences if present
  const codeBlockMatch = text.match(/```(?:json)?([\s\S]*?)```/i);
  if (codeBlockMatch) {
    const cleanedText = codeBlockMatch[1].trim();
    try {
      const parsed = JSON.parse(cleanedText);
      if (Array.isArray(parsed)) return parsed;
      if (parsed?.testCases && Array.isArray(parsed.testCases)) return parsed.testCases;
    } catch (e) {
      // continue to next strategy
    }
  }
  
  // Strategy 2: Find first and last brackets
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = text.substring(first, last + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // continue to next strategy
    }
  }
  
  // Strategy 3: Look for {testCases: [...]} pattern
  const testCasesMatch = text.match(/"?testCases"?\s*:\s*(\[[\s\S]*?\])/i);
  if (testCasesMatch) {
    try {
      const parsed = JSON.parse(testCasesMatch[1]);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // fall through
    }
  }
  
  return null;
}

// ============================================
// GENERATE WITH RETRY (429-aware, JSON-first)
// ============================================
// Replace your generateWithRetry with this improved version
const USE_IMMEDIATE_FALLBACK_ON_QUOTA = false; // set true to avoid waiting and return fallback immediately
const MAX_RETRY_DELAY_MS = 60 * 1000; // cap waits to 60s

async function generateWithRetry(prompt, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`\n🚀 Generation Attempt ${attempt}/${maxRetries}`);
      const result = await model.generateContent(prompt);
      const responseText = result.response.text() || '';
      console.log(`📥 Received response (${responseText.length} chars)`);
      
      // Debug: log first 500 chars to see what we're getting
      console.log(`📄 Response preview: ${responseText.substring(0, 500)}...`);

      // Try parse
      let testCases = null;
      try {
        const parsed = JSON.parse(responseText);
        testCases = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.testCases) ? parsed.testCases : null);
        console.log(`✅ Direct JSON parse successful, found ${testCases?.length || 0} tests`);
      } catch (e) {
        console.log(`⚠️ Direct JSON parse failed: ${e.message}, trying extraction...`);
        // fallback: try to extract array heuristically
        testCases = extractArrayFromText(responseText);
        if (testCases) {
          console.log(`✅ Extraction successful, found ${testCases.length} tests`);
        } else {
          console.log(`❌ Extraction failed`);
        }
      }

      if (!Array.isArray(testCases) || testCases.length < 4) {
        throw new Error(`Insufficient tests: got ${testCases?.length || 0}`);
      }

      // Ensure exactly 12 tests
      while (testCases.length < 12) {
        const idx = testCases.length + 1;
        testCases.push({
          id: `TC_${String(idx).padStart(3, '0')}`,
          category: idx <= 3 ? 'valid' : idx <= 7 ? 'invalid' : idx <= 10 ? 'boundary' : 'security',
          description: `Auto-filled ${idx}`,
          request: testCases[0]?.request || {},
          expected_response: { status: idx <= 3 ? 200 : 400 }
        });
      }

      return testCases.slice(0, 12);
    } catch (error) {
      lastError = error;
      // Try to read HTTP / API structured info (SDK error wrappers vary)
      const apiData = error?.response?.data || error?.data || null;
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      if (apiData) console.error('API error details:', JSON.stringify(apiData));

      // If it's a quota / 429 from Google Gemini, it often includes RetryInfo with retryDelay:
      // e.g. error.response.data includes something like { '@type': '...', 'retryDelay':'43s', 'violations': [...] }
      const isQuota = /429|Too Many Requests|quota/i.test(error.message) || (apiData && JSON.stringify(apiData).match(/quota/i));
      if (isQuota) {
        // Try to extract a retryDelay from various possible places
        let retryDelayMs = null;

        // If the SDK provides retry info in headers or body, parse it
        try {
          // body might include google.rpc.RetryInfo with retryDelay
          // search for patterns like "retryDelay":"43s" or "Retry-After" header
          if (apiData) {
            // If apiData.retryDelay exists as ISO duration string
            if (apiData.retryDelay) {
              // apiData.retryDelay could be "43s" or "43.36850369s"
              const m = String(apiData.retryDelay).match(/([0-9]+(?:\.[0-9]+)?)s/);
              if (m) retryDelayMs = Math.ceil(parseFloat(m[1]) * 1000);
            }

            // google.rpc.RetryInfo may be nested in apiData. Try a broad search for 'retryDelay'
            const asString = JSON.stringify(apiData);
            const rdMatch = asString.match(/\"retryDelay\"\s*[:]\s*\"?([0-9]+(?:\.[0-9]+)?)s\"?/i);
            if (!retryDelayMs && rdMatch) retryDelayMs = Math.ceil(parseFloat(rdMatch[1]) * 1000);

            // Check for 'Retry-After' header early fallback (in seconds)
            const retryAfterHeader = error?.response?.headers?.['retry-after'] || error?.headers?.['retry-after'];
            if (!retryDelayMs && retryAfterHeader) {
              const ra = parseFloat(String(retryAfterHeader));
              if (!isNaN(ra)) retryDelayMs = Math.ceil(ra * 1000);
            }
          }
        } catch (e) {
          // ignore parse issues
        }

        // Also check for explicit quota metrics indicating free-tier limit 0
        let freeTierDisabled = false;
        try {
          if (apiData) {
            const ad = JSON.stringify(apiData).toLowerCase();
            // Common message in your logs: "limit: 0"
            if (ad.includes('"limit":0') || ad.includes('limit: 0') || ad.includes('generate_content_free_tier_requests') && ad.includes('limit: 0')) {
              freeTierDisabled = true;
            }
          }
        } catch (e) {}

        // If free tier is disabled -> immediate fallback (no point retrying)
        if (freeTierDisabled) {
          console.warn('🛑 Detected free-tier disabled (limit 0). Returning fallback immediately.');
          return generateFallbackTestCases();
        }

        // If configured to fallback immediately on quota, do so
        if (USE_IMMEDIATE_FALLBACK_ON_QUOTA) {
          console.warn('🛑 Quota error — configured to return fallback immediately.');
          return generateFallbackTestCases();
        }

        // If we have a server-advised retryDelay, wait that exact time (capped)
        if (retryDelayMs && retryDelayMs > 0) {
          const waitMs = Math.min(retryDelayMs + 500, MAX_RETRY_DELAY_MS); // a little padding
          console.log(`🛑 Quota detected. Server asked to retry after ${retryDelayMs}ms. Waiting ${waitMs}ms before next attempt.`);
          await new Promise(r => setTimeout(r, waitMs));
          continue; // try next attempt
        }

        // Otherwise use exponential backoff with jitter
        const base = Math.min(1000 * Math.pow(2, attempt), 5000);
        const jitter = Math.floor(Math.random() * 1000);
        const wait = Math.min(base + jitter, MAX_RETRY_DELAY_MS);
        console.log(`🛑 Quota detected but no retryDelay found. Waiting ${wait}ms before retry...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      // Non-quota errors: if authentication/API key issues — bubble up
      if (/API key|authentication|invalid key/i.test(error.message)) {
        throw error;
      }

      // Otherwise normal exponential backoff for other errors
      if (attempt < maxRetries) {
        const base = Math.min(1000 * Math.pow(2, attempt), 5000);
        const jitter = Math.floor(Math.random() * 300);
        const wait = base + jitter;
        console.log(`⏳ Waiting ${wait}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }

  console.warn('⚠️ All generation attempts failed — returning fallback test cases.');
  return generateFallbackTestCases();
}
function generateFallbackTestCases() {
  const testCases = [];
  for (let i = 1; i <= 12; i++) {
    const id = `TC_${String(i).padStart(3, '0')}`;
    let category, status;
    if (i <= 3) { category = 'valid'; status = 200; }
    else if (i <= 7) { category = 'invalid'; status = 400; }
    else if (i <= 10) { category = 'boundary'; status = 400; }
    else { category = 'security'; status = 400; }
    testCases.push({
      id,
      category,
      description: `${category} test ${i}`,
      request: { method: 'GET', endpoint: '/api/test', headers: { 'Content-Type': 'application/json' } },
      expected_response: { status }
    });
  }
  return testCases;
}

// ============================================
// GENERATE TESTS ENDPOINT WITH CACHING
// ============================================
app.post("/generate-tests", testGenerationLimiter, async (req, res) => {
  try {
    const { spec } = req.body;
    if (!spec || typeof spec !== 'object') {
      return res.status(400).json({ success: false, error: "Spec object is required", code: "INVALID_SPEC" });
    }

    let validatedSpec;
    try {
      validatedSpec = {
        endpoint: validateEndpoint(spec.endpoint),
        method: validateMethod(spec.method),
        headers: spec.headers || {},
        body: spec.body || {},
        expected_response: spec.expected_response || {}
      };
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message, field: err.field, code: "VALIDATION_ERROR" });
    }

    const cacheKey = JSON.stringify(validatedSpec);
    const cached = generatedCache.get(cacheKey);
    if (cached) {
      console.log('⚡ Serving generated tests from cache');
      return res.json({ ...cached, cached: true });
    }

    console.log(`\n📋 Generating tests for ${validatedSpec.method} ${validatedSpec.endpoint}`);
    const prompt = buildEnhancedPrompt(validatedSpec);
    const testCases = await generateWithRetry(prompt);

    // Patch test cases to match validatedSpec (bodies, statuses)
    const methodsWithBody = ['POST', 'PUT', 'PATCH'];
    for (const tc of testCases) {
      tc.request = tc.request || {};
      tc.request.method = validatedSpec.method;
      tc.request.endpoint = validatedSpec.endpoint;
      tc.request.headers = validatedSpec.headers;

      if (methodsWithBody.includes(validatedSpec.method)) {
        if (tc.category === 'valid') {
          tc.request.body = validatedSpec.body;
        } else if (tc.category === 'invalid') {
          tc.request.body = { ...validatedSpec.body };
          // make simple invalid modifications if possible
          if (tc.id === 'TC_004') delete tc.request.body.name;
          else if (tc.id === 'TC_005') delete tc.request.body.email;
          else if (tc.id === 'TC_006') tc.request.body.email = 'notanemail';
          else tc.request.body = { invalid_field: 'wrong data' };
        } else if (tc.category === 'boundary') {
          tc.request.body = {
            name: tc.id === 'TC_008' ? '' : 'a'.repeat(1000),
            email: tc.id === 'TC_009' ? '' : (validatedSpec.body?.email || 'test@test.com')
          };
        } else if (tc.category === 'security') {
          tc.request.body = {
            name: "<script>alert('XSS')</script>",
            email: "test@test.com' OR '1'='1"
          };
        }
        tc.expected_response = tc.expected_response || {};
        tc.expected_response.status = tc.category === 'valid' ? (validatedSpec.method === 'POST' ? 201 : 200) : 400;
      } else {
        delete tc.request.body;
        tc.expected_response = tc.expected_response || {};
        tc.expected_response.status = tc.category === 'valid' ? 200 : 400;
      }
    }

    const summary = {
      total: testCases.length,
      valid: testCases.filter(tc => tc.category === 'valid').length,
      invalid: testCases.filter(tc => tc.category === 'invalid').length,
      boundary: testCases.filter(tc => tc.category === 'boundary').length,
      security: testCases.filter(tc => tc.category === 'security').length
    };

    const responseData = { success: true, testCases, summary, message: `Generated ${testCases.length} test cases` };
    generatedCache.set(cacheKey, responseData);

    res.json(responseData);
  } catch (error) {
    console.error("\n💥 Generation error:", error);
    let statusCode = 500;
    let errorCode = "GENERATION_ERROR";
    if (error.message.includes('API key')) { statusCode = 500; errorCode = "API_KEY_ERROR"; }
    else if (/quota|429|Too Many Requests/i.test(error.message)) { statusCode = 429; errorCode = "QUOTA_EXCEEDED"; }
    res.status(statusCode).json({ success: false, error: error.message, code: errorCode, suggestion: "Try again or check your API configuration." });
  }
});

// ============================================
// TEST EXECUTION (p-limit concurrency used by /run-tests and SSE)
// ============================================
async function executeTest(test, baseUrl) {
  const startTime = Date.now();
  try {
    let fullUrl;
    if (test.request.endpoint.startsWith('http://') || test.request.endpoint.startsWith('https://')) {
      fullUrl = test.request.endpoint;
    } else {
      fullUrl = `${baseUrl}${test.request.endpoint.startsWith('/') ? '' : '/'}${test.request.endpoint}`;
    }

    const config = {
      method: test.request.method,
      url: fullUrl,
      headers: test.request.headers || {},
      timeout: 15000,
      validateStatus: () => true
    };

    const methodsWithBody = ['POST', 'PUT', 'PATCH'];
    if (methodsWithBody.includes(test.request.method.toUpperCase()) && test.request.body) {
      config.data = test.request.body;
    }

    const response = await axios(config);
    const duration = Date.now() - startTime;
    const validations = validateResponse(response, test.expected_response);

    return {
      id: test.id,
      category: test.category,
      description: test.description,
      status: validations.passed ? "PASSED ✅" : "FAILED ❌",
      duration: `${duration}ms`,
      validations,
      actual: { status: response.status, statusText: response.statusText, data: response.data },
      expected: test.expected_response,
      url: fullUrl
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return { id: test.id, category: test.category, description: test.description, status: "ERROR ❌", duration: `${duration}ms`, error: formatError(error), expected: test.expected_response };
  }
}

function validateResponse(response, expected) {
  const validations = { passed: true, details: [] };
  const statusMatch = response.status === expected.status;
  validations.details.push({ check: 'status_code', passed: statusMatch, expected: expected.status, actual: response.status });
  if (!statusMatch) validations.passed = false;
  if (expected.body_contains && Array.isArray(expected.body_contains)) {
    const responseStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    for (const text of expected.body_contains) {
      const contains = responseStr.includes(text);
      validations.details.push({ check: 'body_contains', passed: contains, expected: `contains \"${text}\"`, actual: contains ? 'found' : 'not found' });
      if (!contains) validations.passed = false;
    }
  }
  if (expected.body_not_contains && Array.isArray(expected.body_not_contains)) {
    const responseStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    for (const text of expected.body_not_contains) {
      const contains = responseStr.includes(text);
      validations.details.push({ check: 'body_not_contains', passed: !contains, expected: `does not contain \"${text}\"`, actual: contains ? 'found (should not be)' : 'not found (correct)' });
      if (contains) validations.passed = false;
    }
  }
  return validations;
}

function formatError(error) {
  if (!error) return 'Unknown error';
  if (error.code === 'ECONNREFUSED') return `Connection refused - Server not reachable`;
  else if (error.code === 'ETIMEDOUT') return 'Request timeout - Server took too long to respond';
  else if (error.response) return `HTTP ${error.response.status}: ${error.response.statusText}`;
  else if (error.code === 'ENOTFOUND') return 'DNS lookup failed - Invalid host';
  return error.message;
}

// ============================================
// RUN TESTS ENDPOINT (uses p-limit for concurrency)
// ============================================
app.post("/run-tests", async (req, res) => {
  try {
    const { testCases, baseUrl, targetUrl, concurrency } = req.body;
    if (!Array.isArray(testCases) || testCases.length === 0) {
      return res.status(400).json({ success: false, error: "Test cases array is required and must not be empty", code: "INVALID_TEST_CASES" });
    }
    const testTarget = targetUrl || baseUrl || "http://localhost:3000";
    try { new URL(testTarget); } catch (err) { return res.status(400).json({ success: false, error: "Invalid target URL format", code: "INVALID_URL" }); }

    console.log(`\n🧪 Running ${testCases.length} tests against ${testTarget}`);
    const startTime = Date.now();

    const limit = pLimit(concurrency && Number.isInteger(concurrency) ? concurrency : defaultConcurrency);
    const promises = testCases.map(tc => limit(() => executeTest(tc, testTarget)));
    const results = await Promise.all(promises);

    const totalDuration = Date.now() - startTime;
    const stats = {
      total: results.length,
      passed: results.filter(r => r.status === "PASSED ✅").length,
      failed: results.filter(r => r.status === "FAILED ❌").length,
      errors: results.filter(r => r.status === "ERROR ❌").length,
      duration: `${totalDuration}ms`,
      avgDuration: `${Math.round(totalDuration / results.length)}ms`,
      passRate: `${((results.filter(r => r.status === "PASSED ✅").length / results.length) * 100).toFixed(1)}%`,
      testedAgainst: testTarget
    };

    const byCategory = { valid: results.filter(r => r.category === 'valid'), invalid: results.filter(r => r.category === 'invalid'), boundary: results.filter(r => r.category === 'boundary'), security: results.filter(r => r.category === 'security') };

    console.log(`\n📊 Results: ${stats.passed} passed, ${stats.failed} failed, ${stats.errors} errors (${stats.duration})`);
    res.json({ success: true, results, summary: stats, byCategory: {
      valid: { total: byCategory.valid.length, passed: byCategory.valid.filter(r => r.status === "PASSED ✅").length },
      invalid: { total: byCategory.invalid.length, passed: byCategory.invalid.filter(r => r.status === "PASSED ✅").length },
      boundary: { total: byCategory.boundary.length, passed: byCategory.boundary.filter(r => r.status === "PASSED ✅").length },
      security: { total: byCategory.security.length, passed: byCategory.security.filter(r => r.status === "PASSED ✅").length }
    } });
  } catch (error) {
    console.error("Error running tests:", error);
    res.status(500).json({ success: false, error: error.message, code: "TEST_EXECUTION_ERROR" });
  }
});

// ============================================
// SSE STREAMING RUN (real-time updates)
// ============================================
app.post('/run-tests-stream', async (req, res) => {
  try {
    const { testCases, targetUrl, concurrency } = req.body;
    if (!Array.isArray(testCases) || testCases.length === 0) return res.status(400).json({ success: false, error: 'Test cases required' });
    const testTarget = targetUrl || 'http://localhost:3000';
    try { new URL(testTarget); } catch (e) { return res.status(400).json({ success: false, error: 'Invalid target URL' }); }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const limit = pLimit(concurrency && Number.isInteger(concurrency) ? concurrency : defaultConcurrency);
    const sendEvent = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const promises = testCases.map(tc => limit(async () => {
      const result = await executeTest(tc, testTarget);
      sendEvent('test-result', result);
      return result;
    }));

    const results = await Promise.all(promises);
    const summary = { total: results.length, passed: results.filter(r => r.status.includes('PASSED')).length, failed: results.filter(r => r.status.includes('FAILED')).length };
    sendEvent('done', { summary });
    res.end();
  } catch (err) {
    console.error('SSE error', err);
    try { res.write(`event: error\ndata: ${JSON.stringify({ message: formatError(err) })}\n\n`); } catch (e) {}
    res.end();
  }
});

// ============================================
// DEBUG ENDPOINT
// ============================================
app.post("/debug-api", async (req, res) => {
  try {
    const { targetUrl, endpoint, method = "GET", headers = {}, body } = req.body;
    if (!targetUrl || !endpoint) return res.status(400).json({ success: false, error: "targetUrl and endpoint are required", code: "MISSING_PARAMS" });
    try { new URL(targetUrl); } catch (err) { return res.status(400).json({ success: false, error: "Invalid target URL", code: "INVALID_URL" }); }
    const fullUrl = `${targetUrl}${endpoint}`;
    console.log(`\n🔍 DEBUG: ${method} ${fullUrl}`);
    const config = { method: method, url: fullUrl, headers: headers || {}, timeout: 10000, validateStatus: () => true };
    if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && body) config.data = body;
    const response = await axios(config);
    res.json({ success: true, request: { method, url: fullUrl, headers, body }, response: { status: response.status, statusText: response.statusText, headers: response.headers, data: response.data, dataType: typeof response.data, dataIsArray: Array.isArray(response.data), dataKeys: typeof response.data === 'object' ? Object.keys(response.data) : null } });
  } catch (error) {
    console.error("Debug API error:", error.message);
    res.status(500).json({ success: false, error: formatError(error), code: error.code || "DEBUG_ERROR" });
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/health", (req, res) => {
  res.json({ status: "healthy", version: "2.2.0", gemini: { configured: !!process.env.GEMINI_API_KEY, model: "gemini-2.5-flash", jsonMode: true }, features: { jsonMode: true, caching: true, concurrencyControl: true, sse: true }, timestamp: new Date().toISOString() });
});

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  console.error("Global error handler:", err);
  res.status(err.status || 500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message, code: err.code || "INTERNAL_ERROR" });
});

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ Enhanced API Test Generator v2.2.0`);
  console.log(`🌐 Server: http://localhost:${port}`);
  console.log(`🔑 Gemini API: ${process.env.GEMINI_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log(`${"=".repeat(60)}\n`);
  console.log("Features:");
  console.log("  ✓ Native JSON output (loose mode)");
  console.log("  ✓ Caching for generation results (NodeCache)");
  console.log("  ✓ Concurrency-limited test execution (p-limit)");
  console.log("  ✓ 429-aware retry/backoff for Gemini");
  console.log("  ✓ SSE streaming endpoint for real-time updates");
  console.log(`${"=".repeat(60)}\n`);
});
