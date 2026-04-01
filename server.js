require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini SDK
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: 'gemini-1.5-pro',
  generationConfig: { responseMimeType: "application/json" }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Synchronously read and parse data files into memory
const salesforceData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'salesforce_data.json'), 'utf8'));
const listings = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'listings.json'), 'utf8'));

// Leads and sync history in memory
const leads = salesforceData.leads || [];
const accounts = salesforceData.accounts || [];
const opportunities = salesforceData.opportunities || [];
const agents = salesforceData.users || []; // 'users' are our agents
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
      You are an expert commercial real estate strategist. Your task is to analyze a new lead, match it to the best property listings, and route it to the most suitable sales agent.
      
      CONTEXT DATA:
      - Current Lead: ${JSON.stringify(lead)}
      - Available Listings: ${JSON.stringify(listings)}
      - Existing Accounts: ${JSON.stringify(accounts)}
      - Existing Opportunities: ${JSON.stringify(opportunities)}
      - Active Sales Agents: ${JSON.stringify(agents.filter(a => a.IsActive))}

      STRATEGY GUIDELINES:
      1. MATCHING: Find the top 3 best listings. Catch hidden constraints (budget, location, specific needs).
      2. INTELLIGENCE: Identify red flags or linked accounts.
      3. ROUTING: Assign the best agent based on their Speciality__c.
      
      OUTPUT FORMAT:
      You must return a JSON object strictly following this schema:
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
    const aiResponse = JSON.parse(result.response.text());

    // --- Execute Mock Salesforce Updates ---

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
      Subject: `Follow up on AI-Processed Lead: ${lead.Company}`,
      Description: aiResponse.lead_intelligence.next_steps.join('\\n'),
      Priority: aiResponse.lead_intelligence.priority === 'High' ? 'High' : 'Normal'
    });

    // 3. Update Opportunity if identified
    const relatedOpp = opportunities.find(opp => 
      opp.Name.includes(lead.Company) || (lead.Email && opp.Description && opp.Description.includes(lead.Email))
    );
    if (relatedOpp) {
      logSync('PATCH_OPPORTUNITY', relatedOpp.Id, {
        StageName: 'Qualification',
        Description: `${relatedOpp.Description}\\n\\nAI Insight: ${aiResponse.lead_intelligence.summary}`
      });
    }

    res.json(aiResponse);

  } catch (error) {
    console.error('AI Processing Error:', error);
    res.status(500).json({ error: 'Failed to process lead with AI' });
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
