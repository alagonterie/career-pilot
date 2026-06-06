// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude, mock) don't appear here.
//
// Skills add a new provider by appending one import line below.

// Routes the agent runtime through Portkey when ANTHROPIC_BASE_URL is set
// (STRATEGY §24.44). Inert otherwise.
import './claude.js';
