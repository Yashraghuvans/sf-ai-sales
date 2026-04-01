const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Synchronously read and parse data files into memory
const salesforceData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'salesforce_data.json'), 'utf8'));
const listings = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'listings.json'), 'utf8'));

// Leads and sync history in memory
const leads = salesforceData.leads || [];
const syncHistory = [];

// --- Frontend Endpoints ---

// GET /api/leads: Returns the array of leads
app.get('/api/leads', (req, res) => {
  res.json(leads);
});

// GET /api/sync-history: Returns the syncHistory array
app.get('/api/sync-history', (req, res) => {
  res.json(syncHistory);
});

// --- Mock Salesforce REST Endpoints ---

// Helper function to log sync history
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

// PATCH /services/data/v57.0/sobjects/Lead/:id
app.patch('/services/data/v57.0/sobjects/Lead/:id', (req, res) => {
  const { id } = req.params;
  logSync('PATCH_LEAD', id, req.body);
  res.status(204).send();
});

// POST /services/data/v57.0/sobjects/Task
app.post('/services/data/v57.0/sobjects/Task', (req, res) => {
  logSync('POST_TASK', null, req.body);
  res.status(201).json({ id: `mock-task-${Date.now()}`, success: true, errors: [] });
});

// PATCH /services/data/v57.0/sobjects/Opportunity/:id
app.patch('/services/data/v57.0/sobjects/Opportunity/:id', (req, res) => {
  const { id } = req.params;
  logSync('PATCH_OPPORTUNITY', id, req.body);
  res.status(204).send();
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
