/**
 * DAILY STANDUP BOT - Jira to Teams
 * Auto-pulls work logs mỗi sáng 9h và post lên Teams channel
 * 
 * Setup:
 * 1. npm install axios node-cron dotenv
 * 2. Set environment variables (see .env.example)
 * 3. node daily-standup-bot.js
 */

const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

// ===== CONFIG =====
const JIRA_HOST = process.env.JIRA_HOST; // e.g., https://your-jira.atlassian.net
const JIRA_USER = process.env.JIRA_USER; // email
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN; // API token
const TEAMS_WEBHOOK = process.env.TEAMS_WEBHOOK; // Teams incoming webhook URL
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'DOH'; // Jira project key

// Jira auth header
const jiraAuth = Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64');

// ===== JIRA API CALLS =====

/**
 * Get all team members assigned to project
 */
async function getTeamMembers() {
  try {
    const jql = `project = "${JIRA_PROJECT_KEY}" AND assignee is not EMPTY`;
    const response = await axios.get(
      `${JIRA_HOST}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=assignee`,
      { headers: { Authorization: `Basic ${jiraAuth}` } }
    );

    const assignees = new Set();
    response.data.issues.forEach(issue => {
      if (issue.fields.assignee) {
        assignees.add(JSON.stringify({
          name: issue.fields.assignee.displayName,
          email: issue.fields.assignee.emailAddress,
          key: issue.fields.assignee.key
        }));
      }
    });

    return Array.from(assignees).map(a => JSON.parse(a));
  } catch (error) {
    console.error('❌ Error fetching team members:', error.message);
    return [];
  }
}

/**
 * Get work logs for today from Jira
 */
async function getDailyWorkLogs(teamMembers) {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    // JQL: Get all issues in project with work logs updated today
    const jql = `project = "${JIRA_PROJECT_KEY}" AND updated >= ${today}`;
    
    const response = await axios.get(
      `${JIRA_HOST}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=key,summary,assignee,status,worklog`,
      { headers: { Authorization: `Basic ${jiraAuth}` } }
    );

    const workLogsByPerson = {};
    const today_start = new Date(today).getTime();
    const today_end = today_start + 86400000; // +24 hours

    response.data.issues.forEach(issue => {
      const assignee = issue.fields.assignee?.displayName || 'Unassigned';
      const status = issue.fields.status?.name || 'Unknown';
      
      if (!workLogsByPerson[assignee]) {
        workLogsByPerson[assignee] = [];
      }

      // Get work logs for this issue that were created today
      if (issue.fields.worklog?.worklogs) {
        issue.fields.worklog.worklogs.forEach(log => {
          const logDate = new Date(log.created).getTime();
          
          // Check if worklog was created today
          if (logDate >= today_start && logDate <= today_end) {
            workLogsByPerson[assignee].push({
              issue: issue.key,
              summary: issue.fields.summary,
              timeSpent: log.timeSpent || '0m',
              author: log.author?.displayName || 'Unknown',
              comment: log.comment || '(no comment)',
              status: status
            });
          }
        });
      }
    });

    return workLogsByPerson;
  } catch (error) {
    console.error('❌ Error fetching work logs:', error.message);
    return {};
  }
}

/**
 * Format work logs for Teams adaptive card
 */
function formatTeamsMessage(workLogs) {
  const today = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric' 
  });

  let hasLogs = false;
  let logSummary = '';

  for (const [person, logs] of Object.entries(workLogs)) {
    if (logs.length > 0) {
      hasLogs = true;
      const totalTime = logs.reduce((sum, log) => {
        // Simple time parsing (e.g., "2h 30m" -> minutes)
        const match = log.timeSpent.match(/(\d+)h?\s*(\d+)?m?/);
        const hours = match ? parseInt(match[1]) || 0 : 0;
        const mins = match ? parseInt(match[2]) || 0 : 0;
        return sum + (hours * 60 + mins);
      }, 0);

      const hours = Math.floor(totalTime / 60);
      const mins = totalTime % 60;
      const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

      logSummary += `\n\n**${person}** (${timeStr})\n`;
      logs.forEach(log => {
        logSummary += `• [${log.issue}](${JIRA_HOST}/browse/${log.issue}) - ${log.summary}\n`;
        logSummary += `  └ "${log.comment}" | Status: ${log.status}\n`;
      });
    }
  }

  if (!hasLogs) {
    logSummary = 'No work logs recorded yet today.';
  }

  // Teams Adaptive Card
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: `Daily Standup - ${today}`,
    themeColor: hasLogs ? '28a745' : 'ffc107',
    sections: [
      {
        activityTitle: `📋 Daily Standup - ${today}`,
        activitySubtitle: `${JIRA_PROJECT_KEY} Project`,
        text: logSummary,
        markdown: true
      },
      {
        activityTitle: '🔗 Quick Links',
        facts: [
          {
            name: 'Project:',
            value: `[${JIRA_PROJECT_KEY}](${JIRA_HOST}/jira/software/projects/${JIRA_PROJECT_KEY})`
          },
          {
            name: 'View all issues:',
            value: `[Today's Issues](${JIRA_HOST}/issues/?jql=project%20%3D%20${JIRA_PROJECT_KEY}%20AND%20updated%20%3E%3D%20-1d)`
          }
        ]
      }
    ]
  };
}

// ===== TEAMS WEBHOOK =====

/**
 * Send message to Teams channel
 */
async function sendToTeams(message) {
  try {
    const response = await axios.post(TEAMS_WEBHOOK, message);
    console.log('✅ Message sent to Teams successfully');
    return response.status === 200;
  } catch (error) {
    console.error('❌ Error sending to Teams:', error.message);
    return false;
  }
}

// ===== MAIN FUNCTION =====

/**
 * Run the daily standup report
 */
async function runDailyStandup() {
  console.log(`\n⏰ Running Daily Standup at ${new Date().toLocaleTimeString()}`);
  
  try {
    const teamMembers = await getTeamMembers();
    console.log(`📌 Found ${teamMembers.length} team members`);

    const workLogs = await getDailyWorkLogs(teamMembers);
    console.log(`📝 Fetched work logs for ${Object.keys(workLogs).length} people`);

    const teamsMessage = formatTeamsMessage(workLogs);
    
    console.log('\n📤 Sending to Teams...');
    const success = await sendToTeams(teamsMessage);
    
    if (success) {
      console.log('✨ Daily standup completed successfully!\n');
    } else {
      console.error('Failed to send Teams message\n');
    }
  } catch (error) {
    console.error('❌ Fatal error in daily standup:', error.message);
  }
}

// ===== SCHEDULER =====

/**
 * Schedule: Run every day at 9:00 AM Vietnam time (GMT+7)
 * Cron format: minute hour day month day-of-week
 * 9 AM = 0 9 * * * (in UTC needs adjustment, but node-cron uses local time by default)
 */
function startScheduler() {
  // Option 1: Run at 9:00 AM local time
  cron.schedule('0 9 * * *', () => {
    runDailyStandup();
  });

  console.log('🤖 Daily Standup Bot started!');
  console.log('⏰ Scheduled to run every day at 9:00 AM\n');

  // For testing: uncomment to run immediately
  // runDailyStandup();
}

// ===== STARTUP =====

if (!JIRA_HOST || !JIRA_USER || !JIRA_API_TOKEN || !TEAMS_WEBHOOK) {
  console.error('❌ Missing required environment variables!');
  console.error('Please set: JIRA_HOST, JIRA_USER, JIRA_API_TOKEN, TEAMS_WEBHOOK');
  process.exit(1);
}

startScheduler();

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n👋 Bot stopped');
  process.exit(0);
});
