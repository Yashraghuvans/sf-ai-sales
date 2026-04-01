require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * AI SDK Initialization
 * Using gemini-1.5-pro (Standard production model)
 */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: 'gemini-1.5-pro',
  generationConfig: { 
    responseMimeType: "application/json",
    temperature: 0.1 
  }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** 
 * Data Initialization with Error Handling
 * Prevents server crash if data files are missing or malformed.
 */
let leads = [];
let listings = [];
let accounts = [];
let opportunities = [];
let agents = [];
const syncHistory = [];

try {
  const salesforceDataPath = path.join(__dirname, 'data', 'salesforce_data.json');
  const listingsPath = path.join(__dirname, 'data', 'listings.json');

  if (fs.existsSync(salesforceDataPath)) {
    const salesforceData = JSON.parse(fs.readFileSync(salesforceDataPath, 'utf8'));
    leads = salesforceData.leads || [];
    accounts = salesforceData.accounts || [];
    opportunities = salesforceData.opportunities || [];
    agents = salesforceData.users || [];
  }

  if (fs.existsSync(listingsPath)) {
    listings = JSON.parse(fs.readFileSync(listingsPath, 'utf8'));
  }
} catch (error) {
  console.error('[CRITICAL] Error loading initial data:', error.message);
}

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
    const activeAgents = agents.filter(a => a.IsActive);
    
    const systemInstruction = `
      You are an expert commercial real estate strategist. Analyze the lead and return structured JSON.
      
      CONTEXT:
      - Current Lead: ${JSON.stringify(lead)}
      - Top Listings: ${JSON.stringify(listings.slice(0, 15))}
      - Available Agents: ${JSON.stringify(activeAgents)}

      OUTPUT SCHEMA:
      {
        "matched_listings": [
          { "listing_id": "string", "rank": "number", "reasoning": "string" }
        ],
        "lead_intelligence": {
          "priority": "High | Medium | Low | Spam",
          "summary": "string",
          "red_flags": ["string"],
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
    const rawText = result.response.text();
    
    let aiResponse;
    try {
      const cleanJson = rawText.replace(/```json|```/g, '').trim();
      aiResponse = JSON.parse(cleanJson);
    } catch (parseError) {
      console.error('AI JSON Parse Error:', rawText);
      return res.status(502).json({ error: 'Invalid response format from AI' });
    }

    // --- Execute Mock Salesforce Updates ---
    
    logSync('AI_ANALYSIS', id, aiResponse);

    // 1. Update Lead with recommended agent
    logSync('PATCH_LEAD', id, {
      OwnerId: aiResponse.agent_routing.agent_id,
      Status: 'Working',
      AI_Summary__c: aiResponse.lead_intelligence.summary
    });

    // 2. Create Task for the routed agent
    logSync('POST_TASK', null, {
      WhoId: id,
      OwnerId: aiResponse.agent_routing.agent_id,
      Subject: `AI Lead: ${lead.Company}`,
      Description: aiResponse.lead_intelligence.next_steps.join('\n'),
      Priority: aiResponse.lead_intelligence.priority === 'High' ? 'High' : 'Normal'
    });

    res.json(aiResponse);

  } catch (error) {
    console.error('AI Processing Error:', error);
    res.status(500).json({ error: 'Failed to process lead' });
  }
});

// --- Frontend Endpoints ---

app.get('/api/leads', (req, res) => {
  res.json(leads);
});

app.get('/api/sync-history', (req, res) => {
  res.json(syncHistory);
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
