import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Career Pilot | AI Job Hunting Orchestrator",
  description: "Autonomous agent crawling, tailoring, and scheduling your software engineering career pipeline.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <div className="app-container">
          {/* Sidebar */}
          <aside className="sidebar">
            <div>
              <Link href="/" className="brand">
                <span style={{ fontSize: '1.5rem' }}>🚀</span>
                <span>Career Pilot</span>
              </Link>

              <ul className="nav-links">
                <li className="nav-item">
                  <Link href="/">
                    <span>📊</span> Dashboard
                  </Link>
                </li>
                <li className="nav-item">
                  <Link href="/applications">
                    <span>📋</span> Applications
                  </Link>
                </li>
                <li className="nav-item">
                  <Link href="/interviews">
                    <span>📅</span> Interviews
                  </Link>
                </li>
                <li className="nav-item">
                  <Link href="/profile">
                    <span>⚙️</span> Profile & Config
                  </Link>
                </li>
              </ul>
            </div>

            {/* Bottom Status panel */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <span className="glow-pulse" style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--success)',
                  boxShadow: '0 0 10px rgba(16, 185, 129, 0.4)'
                }}></span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '500' }}>
                  Orchestrator Active
                </span>
              </div>
              <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                Tunnel Connected
              </p>
            </div>
          </aside>

          {/* Main Content */}
          <main className="main-content">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
