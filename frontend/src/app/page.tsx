'use client';

import { useState, useEffect } from 'react';

// Interfaces matching backend tables
interface Profile {
  name: string;
  target_roles: string;
  preferences: string;
  resume_text: string;
}

interface Application {
  id: number;
  company: string;
  role: string;
  status: 'APPLIED' | 'SCREENING' | 'INTERVIEWING' | 'OFFER' | 'REJECTED' | 'BOOKMARKED';
  url: string;
  updated_date: string;
}

interface Interview {
  id: number;
  company: string;
  role: string;
  scheduled_time: string;
  notes: string;
}

export default function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [usingMockData, setUsingMockData] = useState(false);

  const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        // 1. Fetch bootstrap status
        const statusRes = await fetch(`${API_BASE}/api/status`);
        if (!statusRes.ok) throw new Error('API offline');
        const statusData = await statusRes.json() as { bootstrapped: boolean };
        setBootstrapped(statusData.bootstrapped);

        if (statusData.bootstrapped) {
          // 2. Fetch profile, applications, and interviews
          const [profRes, appsRes, intRes] = await Promise.all([
            fetch(`${API_BASE}/api/profile`),
            fetch(`${API_BASE}/api/applications`),
            fetch(`${API_BASE}/api/interviews`)
          ]);

          const profData = await profRes.json() as Profile;
          const appsData = await appsRes.json() as Application[];
          const intData = await intRes.json() as Interview[];

          setProfile(profData);
          setApplications(appsData);
          setInterviews(intData);
        }
        setUsingMockData(false);
      } catch (err) {
        console.warn('API is offline or errored, falling back to mock dashboard visualization.');
        loadMockData();
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [API_BASE]);

  function loadMockData() {
    setUsingMockData(true);
    setBootstrapped(true);
    setProfile({
      name: 'Alexander LaGonterie',
      target_roles: 'Senior AI Specialist / Lead Software Engineer',
      preferences: 'Remote, Hybrid in Texas. Min $180k Base.',
      resume_text: 'Experienced developer specializing in agentic AI...'
    });
    setApplications([
      { id: 1, company: 'Google DeepMind', role: 'Research Engineer, Agents', status: 'INTERVIEWING', url: '#', updated_date: '2026-05-24' },
      { id: 2, company: 'Anthropic', role: 'Member of Technical Staff', status: 'SCREENING', url: '#', updated_date: '2026-05-23' },
      { id: 3, company: 'OpenAI', role: 'MTS, Frontend Systems', status: 'APPLIED', url: '#', updated_date: '2026-05-22' },
      { id: 4, company: 'Supabase', role: 'Developer Advocate', status: 'OFFER', url: '#', updated_date: '2026-05-20' },
      { id: 5, company: 'Stripe', role: 'Staff Engineer', status: 'REJECTED', url: '#', updated_date: '2026-05-15' }
    ]);
    setInterviews([
      { id: 1, company: 'Google DeepMind', role: 'Research Engineer, Agents', scheduled_time: '2026-05-26T10:00:00Z', notes: 'Technical interview on container architecture and state machines.' }
    ]);
  }

  async function triggerSync() {
    try {
      setSyncing(true);
      const res = await fetch(`${API_BASE}/api/sync`, { method: 'POST' });
      if (res.ok) {
        alert('Workspace sync completed successfully!');
      } else {
        alert('Failed to trigger sync. Is Google Workspace authenticated?');
      }
    } catch (err) {
      alert('Failed to contact backend API.');
    } finally {
      setSyncing(false);
    }
  }

  async function connectGoogle() {
    try {
      const res = await fetch(`${API_BASE}/api/google/auth-url`);
      const data = await res.json() as { url?: string };
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert('Google OAuth URL not found.');
      }
    } catch (err) {
      alert('Failed to contact backend API.');
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>Loading Career Pilot Dashboard...</div>
      </div>
    );
  }

  // Not bootstrapped display (Onboarding Wizard promo)
  if (!bootstrapped) {
    return (
      <div style={{ maxWidth: '600px', margin: '80px auto', textAlign: 'center' }}>
        <span style={{ fontSize: '4rem' }}>🤖</span>
        <h1 style={{ marginTop: '24px', fontSize: '2rem' }}>Awaiting Agent Activation</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '16px', lineHeight: '1.6' }}>
          Career Pilot has not been initialized. To get started, open Telegram and send a message to your bot.
        </p>
        <div className="card" style={{ marginTop: '32px', textAlign: 'left' }}>
          <h3 className="card-title">🚀 Bootstrapping Instructions</h3>
          <ol style={{ paddingLeft: '20px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <li>Find your bot on Telegram: <code>@your_bot_name</code>.</li>
            <li>Send the command <code>/start</code>.</li>
            <li>Answer the bot's conversational onboarding questions.</li>
            <li>Provide your master resume text or markdown file.</li>
            <li>Confirm your profile summaries, and this dashboard will automatically unlock!</li>
          </ol>
        </div>
      </div>
    );
  }

  const appCounts = applications.reduce((acc, app) => {
    acc[app.status] = (acc[app.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div>
      {usingMockData && (
        <div style={{
          backgroundColor: 'rgba(59, 130, 246, 0.15)',
          border: '1px solid var(--primary)',
          borderRadius: '12px',
          padding: '16px',
          marginBottom: '32px',
          display: 'flex',
          justifyContent: 'between',
          alignItems: 'center'
        }}>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            ⚠️ **Simulation Mode**: The local orchestrator API is not connected. Showing sample visualization.
          </p>
        </div>
      )}

      {/* Header bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2.5rem' }}>{profile?.name}</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '4px', fontWeight: '500' }}>
            {profile?.target_roles} ➔ <span style={{ color: 'var(--success)' }}>Active Agent Monitor</span>
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="btn btn-secondary" onClick={connectGoogle}>
            🔗 Link Workspace
          </button>
          <button className="btn btn-primary" onClick={triggerSync} disabled={syncing}>
            {syncing ? 'Syncing...' : '🔄 Sync Scans'}
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="dashboard-grid">
        <div className="card" style={{ gridColumn: 'span 4' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: '600' }}>TOTAL APPLICATIONS</p>
          <h2 className="stat-value" style={{ marginTop: '12px' }}>{applications.length}</h2>
        </div>
        <div className="card" style={{ gridColumn: 'span 4' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: '600' }}>INTERVIEWING</p>
          <h2 className="stat-value" style={{ marginTop: '12px', background: 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            {appCounts['INTERVIEWING'] || 0}
          </h2>
        </div>
        <div className="card" style={{ gridColumn: 'span 4' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: '600' }}>OFFERS RECEIVED</p>
          <h2 className="stat-value" style={{ marginTop: '12px', background: 'linear-gradient(135deg, #10b981 0%, #06b6d4 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            {appCounts['OFFER'] || 0}
          </h2>
        </div>
      </div>

      {/* Main sections */}
      <div className="dashboard-grid" style={{ marginTop: '24px' }}>
        {/* Applications table */}
        <div className="card" style={{ gridColumn: 'span 8' }}>
          <h3 className="card-title">📋 Job Hunting Pipeline</h3>
          <div style={{ overflowX: 'auto', marginTop: '16px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', paddingBottom: '12px' }}>
                  <th style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Company</th>
                  <th style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Role</th>
                  <th style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Status</th>
                  <th style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((app) => (
                  <tr key={app.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '16px 12px', fontWeight: '600' }}>{app.company}</td>
                    <td style={{ padding: '16px 12px', color: 'var(--text-secondary)' }}>{app.role}</td>
                    <td style={{ padding: '16px 12px' }}>
                      <span className={`status-badge status-${app.status.toLowerCase()}`}>
                        {app.status}
                      </span>
                    </td>
                    <td style={{ padding: '16px 12px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>{app.updated_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Interviews schedule */}
        <div className="card" style={{ gridColumn: 'span 4' }}>
          <h3 className="card-title">📅 Upcoming Interviews</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
            {interviews.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No upcoming interviews scheduled.</p>
            ) : (
              interviews.map((int) => (
                <div key={int.id} style={{
                  padding: '16px',
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border)',
                  borderRadius: '12px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                    <h4 style={{ fontWeight: '700' }}>{int.company}</h4>
                    <span className="status-badge status-interviewing" style={{ fontSize: '0.7rem' }}>LIVE</span>
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '4px' }}>{int.role}</p>
                  <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', marginTop: '8px', fontWeight: '600' }}>
                    ⏰ {new Date(int.scheduled_time).toLocaleString()}
                  </p>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '12px', borderTop: '1px dashed var(--border)', paddingTop: '8px' }}>
                    {int.notes}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
