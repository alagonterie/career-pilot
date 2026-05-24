import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDb, getDb } from './db';
import { startTelegramBot } from './telegram';
import { startTaskOrchestrator } from './orchestrator';
import { getAuthUrl, exchangeCodeForTokens, syncGmailAndCalendar } from './google';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API Endpoints
app.get('/api/status', async (req, res) => {
  try {
    const db = await getDb();
    const settings = await db.get('SELECT is_bootstrapped FROM system_settings WHERE id = 1');
    res.json({ bootstrapped: settings?.is_bootstrapped === 1 });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/profile', async (req, res) => {
  try {
    const db = await getDb();
    const profile = await db.get('SELECT name, target_roles, preferences, resume_text FROM candidate_profile WHERE id = 1');
    res.json(profile || null);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/applications', async (req, res) => {
  try {
    const db = await getDb();
    const apps = await db.all('SELECT * FROM job_applications ORDER BY updated_date DESC');
    res.json(apps);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/interviews', async (req, res) => {
  try {
    const db = await getDb();
    const interviews = await db.all(`
      SELECT i.*, j.company, j.role 
      FROM interviews i 
      JOIN job_applications j ON i.job_application_id = j.id 
      ORDER BY i.scheduled_time ASC
    `);
    res.json(interviews);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Google OAuth Endpoints
app.get('/api/google/auth-url', (req, res) => {
  const url = getAuthUrl();
  res.json({ url });
});

app.get('/api/google/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    return res.status(400).send('Missing code parameter');
  }
  try {
    await exchangeCodeForTokens(code);
    // Redirect back to frontend dashboard
    const domainName = process.env.DOMAIN_NAME || 'alagonterie.com';
    res.redirect(`https://hire.${domainName}`);
  } catch (error: any) {
    res.status(500).send(`OAuth Error: ${error.message}`);
  }
});

// Sync Workspace Endpoint (triggered by bot or frontend)
app.post('/api/sync', async (req, res) => {
  try {
    const db = await getDb();
    const settings = await db.get('SELECT is_bootstrapped FROM system_settings WHERE id = 1');
    if (!settings || settings.is_bootstrapped === 0) {
      return res.status(400).json({ error: 'App not bootstrapped' });
    }

    console.log('Manually triggering Workspace Sync...');
    await syncGmailAndCalendar();
    await db.run('UPDATE system_settings SET last_sync_time = ? WHERE id = 1', [new Date().toISOString()]);

    res.json({ success: true, message: 'Workspace sync completed.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Bootstrapping function
async function startServer() {
  await initDb();
  console.log('Database initialized.');

  // Start Express API Server
  app.listen(PORT, () => {
    console.log(`Express API Server listening on port ${PORT}`);
  });

  // Start Telegram bot listener
  try {
    await startTelegramBot();
  } catch (err) {
    console.error('Failed to start Telegram Bot:', err);
  }

  // Start background task runner
  try {
    await startTaskOrchestrator();
  } catch (err) {
    console.error('Failed to start Task Orchestrator:', err);
  }
}

startServer();
