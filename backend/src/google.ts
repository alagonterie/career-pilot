import { getDb } from './db';
import dotenv from 'dotenv';

dotenv.config();

const clientID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const domainName = process.env.DOMAIN_NAME || 'alagonterie.com';
const redirectURI = `https://api.hire.${domainName}/api/google/callback`;

export function getAuthUrl(): string {
  if (!clientID) return '';
  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly'
  ].join(' ');

  return `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientID)}&` +
    `redirect_uri=${encodeURIComponent(redirectURI)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `access_type=offline&` +
    `prompt=consent`;
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  if (!clientID || !clientSecret) {
    throw new Error('Google OAuth Credentials are not configured.');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientID,
      client_secret: clientSecret,
      redirect_uri: redirectURI,
      grant_type: 'authorization_code'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to exchange code: ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const db = await getDb();
  const expiryDate = Date.now() + (data.expires_in * 1000);

  // Store tokens (only allow one row with id = 1)
  await db.run(
    `INSERT OR REPLACE INTO google_credentials (id, access_token, refresh_token, expiry_date)
     VALUES (1, ?, ?, ?)`,
    [data.access_token, data.refresh_token, expiryDate]
  );
}

export async function getValidAccessToken(): Promise<string> {
  const db = await getDb();
  const creds = await db.get('SELECT * FROM google_credentials WHERE id = 1');

  if (!creds) {
    throw new Error('Google Workspace is not authenticated. Please authenticate via the admin panel first.');
  }

  // If token is still valid (with 5-minute buffer)
  if (creds.expiry_date > Date.now() + 300000) {
    return creds.access_token;
  }

  // If expired, perform refresh token exchange
  if (!clientID || !clientSecret) {
    throw new Error('Google OAuth credentials not configured.');
  }

  console.log('Refreshing Google Access Token...');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientID,
      client_secret: clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Google OAuth token: ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    expires_in: number;
  };

  const newExpiryDate = Date.now() + (data.expires_in * 1000);

  await db.run(
    `UPDATE google_credentials SET access_token = ?, expiry_date = ? WHERE id = 1`,
    [data.access_token, newExpiryDate]
  );

  return data.access_token;
}

// Google Workspace Sync Poller
export async function syncGmailAndCalendar(): Promise<void> {
  try {
    const accessToken = await getValidAccessToken();
    console.log('Syncing Gmail and Calendar events...');

    // 1. Gmail Poll (newer_than:1d for interview-related strings)
    const query = encodeURIComponent('newer_than:1d (interview OR "schedule your call" OR "application received")');
    const gmailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}`;
    
    const gmailResponse = await fetch(gmailUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (gmailResponse.ok) {
      const data = await gmailResponse.json() as { messages?: { id: string }[] };
      const messages = data.messages || [];
      console.log(`Found ${messages.length} recent matching emails.`);
      
      // In a full implementation, we'd loop messages, download the snippet, 
      // and send it to our LLM parser to extract scheduling dates.
    }

    // 2. Calendar Poll (Upcoming events next 7 days)
    const now = new Date().toISOString();
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const calendarUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${nextWeek}&singleEvents=true&orderBy=startTime`;

    const calResponse = await fetch(calendarUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (calResponse.ok) {
      const data = await calResponse.json() as { items?: any[] };
      const events = data.items || [];
      console.log(`Found ${events.length} upcoming calendar events.`);
      // Sync events to local database
    }

  } catch (error: any) {
    console.error('Workspace Sync failed:', error.message);
  }
}
