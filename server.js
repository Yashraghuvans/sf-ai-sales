require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini SDK
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Using gemini-1.5-pro as the standard high-performance model
const model = genAI.getGenerativeModel({ 
  model: 'gemini-1.5-pro',
  generationConfig: { responseMimeType: "application/json" }
});

// Helper to safely parse Gemini responses and strip markdown blocks
function parseGeminiResponse(rawText) {
  try {
    const cleanText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(cleanText);
  } catch (error) {
    console.error("AI JSON Parse Error. Raw Output:", rawText);
    throw new Error("Gemini returned malformed JSON.");
  }
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Safe Data Loading Initialization
let salesforceData = { leads: [], accounts: [], opportunities: [], users: [] };
let listings = [];

try {
    const sfPath = path.join(__dirname, 'data', 'salesforce_data.json');
    const listingsPath = path.join(__dirname, 'data', 'listings.json');

    if (!fs.existsSync(sfPath) || !fs.existsSync(listingsPath)) {
        throw new Error("Data files missing. Please ensure /data/salesforce_data.json and /data/listings.json exist.");
    }

    salesforceData = JSON.parse(fs.readFileSync(sfPath, 'utf8'));
    listings = JSON.parse(fs.readFileSync(listingsPath, 'utf8'));
    console.log("✅ Mock data successfully loaded into memory.");
} catch (error) {
    console.error("❌ CRITICAL ERROR: Failed to load JSON data on startup.", error.message);
    process.exit(1);
}

// Leads and sync history in memory
const leads = salesforceData.leads || [];
const accounts = salesforceData.accounts || [];
const opportunities = salesforceData.opportunities || [];
const agents = salesforceData.users || [];
const syncHistory = [];

// --- Mock Salesforce REST Endpoints ---

const logSync = (type, id, body) => {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    id,
    body,
    status: 'SUCCESS'
  };
  syncHistory.push(logEntry);
  console.log(`[SF MOCK] ${type} for ID: ${id || 'N/A'}`);
  return logEntry;
};

app.patch('/services/data/v57.0/sobjects/Lead/:id', (req, res) => {
  const { id } = req.params;
  logSync('PATCH_LEAD', id, req.body);
  res.status(204).send();
});

app.post('/services/data/v57.0/sobjects/Task', (req, res) => {
  logSync('POST_TASK', null, req.body);
  res.status(201).json({ id: `mock-task-${Date.now()}`, success: true, errors: [] });
});

app.patch('/services/data/v57.0/sobjects/Opportunity/:id', (req, res) => {
  const { id } = req.params;
  logSync('PATCH_OPPORTUNITY', id, req.body);
  res.status(204).send();
});

// --- AI Lead Processing Endpoint ---

app.post('/api/process-lead/:id', async (req, res) => {
  const { id } = req.params;
  const lead = leads.find(l => l.Id === id);

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  try {
    const systemInstruction = `
      You are an expert commercial real estate strategist. Analyze the lead and return structured JSON.
      
      CONTEXT DATA:
      - Current Lead: ${JSON.stringify(lead)}
      - Available Listings: ${JSON.stringify(listings)}
      - Active Sales Agents: ${JSON.stringify(agents.filter(a => a.IsActive))}

      STRATEGY GUIDELINES:
      1. MATCHING: Find the top 3 best listings.
      2. INTELLIGENCE: Identify red flags and next steps.
      3. ROUTING: Assign the best agent.
      
      OUTPUT FORMAT (JSON):
      {
        "matched_listings": [
          { "listing_id": "string", "rank": "number", "reasoning": "string" }
        ],
        "lead_intelligence": {
          "priority": "High | Medium | Low | Spam",
          "summary": "string",
          "red_flags": ["string"],
          "talking_points": ["string"],
          "next_steps": ["string"]
        },
        "agent_routing": {
          "agent_id": "string",
          "agent_name": "string",
          "reasoning": "string"
        }
      }
    `;

    const result = await model.generateContent(systemInstruction);
    const aiResponse = parseGeminiResponse(result.response.text());

    // --- Execute Mock Salesforce Updates ---

    logSync('PATCH_LEAD', id, {
      OwnerId: aiResponse.agent_routing.agent_id,
      Status: 'Working',
      AI_Summary__c: aiResponse.lead_intelligence.summary
    });

    logSync('POST_TASK', null, {
      WhoId: id,
      OwnerId: aiResponse.agent_routing.agent_id,
      Subject: `Follow up on AI-Processed Lead: ${lead.Company}`,
      Description: (aiResponse.lead_intelligence.next_steps || []).join('\n'),
      Priority: aiResponse.lead_intelligence.priority === 'High' ? 'High' : 'Normal'
    });

    res.json(aiResponse);

  } catch (error) {
    console.error('AI Processing Error:', error);
    res.status(500).json({ error: error.message || 'Failed to process lead with AI' });
  }
});

app.get('/api/leads', (req, res) => res.json(leads));
app.get('/api/sync-history', (req, res) => res.json(syncHistory));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
