// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';
// The custom `portal` channel (HTTP+SSE transport) — carries the public
// Recruiter Simulator. Not from upstream NanoClaw. See STRATEGY.md §7 + §24.19.
import './portal/adapter.js';
