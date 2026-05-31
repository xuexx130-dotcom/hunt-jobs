const https = require('https');
const fs = require('fs');

const CONFIG = JSON.parse(fs.readFileSync('config/sources.json', 'utf8'));

function gmailSend(to, subject, body) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ to, subject, body });
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    resolve(true);
  });
}

async function sendNotificationEmail(queuedJobs) {
  const { GoogleAuth } = await loadGmailAuth();
  
  const jobList = queuedJobs.map((j, i) => 
    `${i+1}. [${j.score}] ${j.title} at ${j.org}
   📧 Email: ${j.emailAddress || 'N/A'}
   ❌ Cancel: ${process.env.VERCEL_URL || 'https://hunt-jobs.vercel.app'}/cancel?id=${j.queueId}`
  ).join('\n\n');

  const subject = `📬 Hunt Jobs: ${queuedJobs.length} email(s) queued - send in 24h`;
  const body = `Hi Xue Ke,

${queuedJobs.length} job application(s) are queued to send automatically in 24 hours.

${jobList}

To cancel any, click the cancel link above before the deadline.
To view all jobs: ${process.env.VERCEL_URL || 'https://hunt-jobs.vercel.app'}

— Hunt Jobs System`;

  await sendViaGmail(subject, body, CONFIG.sender.email);
  console.log('Notification email sent to', CONFIG.sender.email);
}

async function sendViaGmail(subject, body, to) {
  const { getAccessToken } = require('./gmail_auth');
  const accessToken = await getAccessToken();
  
  const email = [
    `To: ${to}`,
    `From: ${CONFIG.sender.name} <${CONFIG.sender.email}>`,
    `Subject: ${subject}`,
    '',
    body
  ].join('\n');
  
  const encoded = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  
  return new Promise((resolve, reject) => {
    const body_data = JSON.stringify({ raw: encoded });
    const options = {
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/messages/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body_data)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body_data);
    req.end();
  });
}

async function main() {
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync('data/jobs_today.json', 'utf8')); } catch(e) {}
  
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync('data/send_queue.json', 'utf8')); } catch(e) {}

  const autoSendJobs = jobs.filter(j => 
    j.score >= CONFIG.scoring.auto_send_threshold && 
    j.applyViaEmail && 
    j.emailAddress
  );
  
  const dailyLimit = CONFIG.scoring.daily_send_limit;
  const todayQueued = queue.filter(q => {
    const d = new Date(q.queuedAt);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;
  
  const slotsLeft = dailyLimit - todayQueued;
  const toQueue = autoSendJobs.slice(0, slotsLeft);
  
  console.log(`${autoSendJobs.length} eligible for auto-send, ${slotsLeft} slots left today`);
  
  const newQueued = [];
  for (const job of toQueue) {
    const alreadyQueued = queue.find(q => q.jobId === (job.title + job.org));
    if (!alreadyQueued) {
      const queueItem = {
        queueId: Date.now() + Math.random().toString(36).substr(2,5),
        jobId: job.title + job.org,
        job,
        queuedAt: new Date().toISOString(),
        sendAfter: new Date(Date.now() + 24*60*60*1000).toISOString(),
        cancelled: false
      };
      queue.push(queueItem);
      newQueued.push(queueItem);
      console.log(`Queued: ${job.title}`);
    }
  }
  
  fs.writeFileSync('data/send_queue.json', JSON.stringify(queue, null, 2));
  
  if (newQueued.length > 0) {
    try {
      await sendViaGmail(
        `📬 Hunt Jobs: ${newQueued.length} email(s) queued - sends in 24h`,
        `Hi Xue Ke,\n\n${newQueued.length} job application(s) queued to send in 24 hours:\n\n` +
        newQueued.map((q,i) => `${i+1}. [${q.job.score}] ${q.job.title} at ${q.job.org}\n   Cancel: ${process.env.VERCEL_URL || 'https://hunt-jobs.vercel.app'}?cancel=${q.queueId}`).join('\n\n') +
        `\n\nView dashboard: ${process.env.VERCEL_URL || 'https://hunt-jobs.vercel.app'}`,
        CONFIG.sender.email
      );
    } catch(e) {
      console.log('Notification email failed:', e.message);
    }
  }
  
  console.log(`Queue updated. Total queued: ${queue.filter(q => !q.cancelled).length}`);
}

main().catch(console.error);
