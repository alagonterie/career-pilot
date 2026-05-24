import { Telegraf } from 'telegraf';
import { getDb } from './db';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const allowedChatId = process.env.ALLOWED_TELEGRAM_CHAT_ID;

if (!botToken || !allowedChatId) {
  throw new Error('TELEGRAM_BOT_TOKEN and ALLOWED_TELEGRAM_CHAT_ID must be set in env');
}

export const bot = new Telegraf(botToken);

// Middleware to authorize the chat ID
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id.toString();
  if (chatId !== allowedChatId) {
    console.warn(`Unauthorized access attempt from Chat ID: ${chatId}`);
    return; // Drop unauthorized message
  }
  await next();
});

interface OnboardingState {
  step: 'ASK_NAME' | 'ASK_ROLES' | 'ASK_PREFERENCES' | 'ASK_RESUME' | 'CONFIRM';
  name?: string;
  targetRoles?: string;
  preferences?: string;
  resumeText?: string;
}

let onboardingSession: OnboardingState | null = null;

// Start command
bot.start(async (ctx) => {
  const db = await getDb();
  const settings = await db.get('SELECT is_bootstrapped FROM system_settings WHERE id = 1');
  
  if (settings && settings.is_bootstrapped === 1) {
    await ctx.reply('Welcome back to Career Pilot! Send /status to see how your job search is going, or send a natural language message to discuss jobs.');
    return;
  }

  // Start onboarding
  onboardingSession = { step: 'ASK_NAME' };
  await ctx.reply(
    "Hello! I am Career Pilot, your AI job-hunting orchestrator. 🚀\n\n" +
    "Let's get set up! First, what is your **full name**?"
  );
});

// Status command
bot.command('status', async (ctx) => {
  const db = await getDb();
  const settings = await db.get('SELECT is_bootstrapped FROM system_settings WHERE id = 1');
  if (!settings || settings.is_bootstrapped === 0) {
    await ctx.reply('Please run /start to onboard first.');
    return;
  }

  const profile = await db.get('SELECT name, target_roles FROM candidate_profile WHERE id = 1');
  const count = await db.get('SELECT count(*) as total FROM job_applications');
  const activeInterviews = await db.get(
    "SELECT count(*) as count FROM interviews WHERE datetime(scheduled_time) >= datetime('now')"
  );

  const statusMessage = 
    `📊 **Career Pilot Status Report**\n\n` +
    `👤 **Candidate**: ${profile?.name || 'Not Set'}\n` +
    `🎯 **Target Roles**: ${profile?.target_roles || 'Not Set'}\n` +
    `📁 **Total Applications**: ${count?.total || 0}\n` +
    `📅 **Upcoming Interviews**: ${activeInterviews?.count || 0}\n\n` +
    `Use /applications to list recent activity or /sync to trigger Workspace scans.`;

  await ctx.replyWithMarkdown(statusMessage);
});

// Applications command
bot.command('applications', async (ctx) => {
  const db = await getDb();
  const apps = await db.all(
    'SELECT company, role, status, updated_date FROM job_applications ORDER BY updated_date DESC LIMIT 5'
  );

  if (apps.length === 0) {
    await ctx.reply('No applications logged yet.');
    return;
  }

  let message = '📋 **Recent Applications**\n\n';
  apps.forEach((app) => {
    message += `• **${app.company}** - ${app.role} (${app.status})\n  _Last updated: ${app.updated_date || 'N/A'}_\n\n`;
  });

  await ctx.replyWithMarkdown(message);
});

// Message listener (handles Onboarding and Hermes chatbot)
bot.on('message', async (ctx) => {
  const db = await getDb();
  const settings = await db.get('SELECT is_bootstrapped FROM system_settings WHERE id = 1');

  // Handle Onboarding
  if (!settings || settings.is_bootstrapped === 0) {
    await handleOnboarding(ctx);
    return;
  }

  // Handle Conversational Agent (Hermes)
  await handleConversation(ctx);
});

async function handleOnboarding(ctx: any) {
  if (!onboardingSession) {
    onboardingSession = { step: 'ASK_NAME' };
    await ctx.reply("Let's start your onboarding! What is your **full name**?");
    return;
  }

  const text = ctx.message?.text?.trim();

  switch (onboardingSession.step) {
    case 'ASK_NAME':
      if (!text) {
        await ctx.reply('Please reply with a valid name.');
        return;
      }
      onboardingSession.name = text;
      onboardingSession.step = 'ASK_ROLES';
      await ctx.reply(
        `Nice to meet you, ${text}!\n\n` +
        `What **target roles** are you seeking? (e.g. "Staff Software Engineer, AI Tech Lead")`
      );
      break;

    case 'ASK_ROLES':
      if (!text) {
        await ctx.reply('Please list your target roles.');
        return;
      }
      onboardingSession.targetRoles = text;
      onboardingSession.step = 'ASK_PREFERENCES';
      await ctx.reply(
        `Got it: "${text}".\n\n` +
        `What are your **job preferences**? (e.g. "Remote only, minimum $150k base salary, no defense industry")`
      );
      break;

    case 'ASK_PREFERENCES':
      if (!text) {
        await ctx.reply('Please state your preferences.');
        return;
      }
      onboardingSession.preferences = text;
      onboardingSession.step = 'ASK_RESUME';
      await ctx.reply(
        `Got those down. Finally, I need your **master resume**.\n\n` +
        `Please paste your complete resume text here, or upload a text/markdown file (` +
        `use the attachment button). This will be used to tailor all applications.`
      );
      break;

    case 'ASK_RESUME':
      let resumeContent = '';
      if (ctx.message && 'document' in ctx.message) {
        const fileId = ctx.message.document.file_id;
        try {
          const fileLink = await ctx.telegram.getFileLink(fileId);
          const response = await axios.get(fileLink.toString());
          resumeContent = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        } catch (err) {
          console.error(err);
          await ctx.reply('Failed to read the uploaded document. Please paste the resume text directly instead.');
          return;
        }
      } else if (text) {
        resumeContent = text;
      } else {
        await ctx.reply('Please paste your resume text or upload a plain text/markdown file.');
        return;
      }

      onboardingSession.resumeText = resumeContent;
      onboardingSession.step = 'CONFIRM';

      const summary = 
        `📋 **Verify Your Profile Details**\n\n` +
        `👤 **Name**: ${onboardingSession.name}\n` +
        `🎯 **Roles**: ${onboardingSession.targetRoles}\n` +
        `⚙️ **Preferences**: ${onboardingSession.preferences}\n` +
        `📄 **Resume**: Captured (${resumeContent.length} characters)\n\n` +
        `Does this look correct? Reply **"YES"** to complete setup, or send **/start** to start over.`;
      
      await ctx.replyWithMarkdown(summary);
      break;

    case 'CONFIRM':
      if (text?.toUpperCase() === 'YES') {
        const db = await getDb();
        await db.run(
          `INSERT OR REPLACE INTO candidate_profile (id, name, target_roles, preferences, resume_text)
           VALUES (1, ?, ?, ?, ?)`,
          [
            onboardingSession.name,
            onboardingSession.targetRoles,
            onboardingSession.preferences,
            onboardingSession.resumeText
          ]
        );
        await db.run('UPDATE system_settings SET is_bootstrapped = 1 WHERE id = 1');
        onboardingSession = null;
        await ctx.reply(
          "🎉 Onboarding complete! Setup has been saved to the database.\n\n" +
          "I will now start scanning for job listings and syncing with Gmail. Use /status at any time to monitor progress."
        );
      } else {
        await ctx.reply('Please type "YES" to confirm and save your profile, or send /start to restart.');
      }
      break;
  }
}

async function handleConversation(ctx: any) {
  const text = ctx.message?.text;
  if (!text) {
    await ctx.reply("I can only process text messages. Try asking about your current jobs or search status!");
    return;
  }

  // Placeholder for Hermes Chatbot logic
  // In the future, this will call Portkey/Gemini and feed it database state
  await ctx.reply(`Conversation received: "${text}". The AI routing loop is starting soon!`);
}

// Start bot helper
export async function startTelegramBot() {
  bot.launch();
  console.log('Telegram bot listener active.');
  
  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
