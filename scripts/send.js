const fs = require('fs');
const { sendEmail } = require('./gmail_auth');

const CONFIG = JSON.parse(fs.readFileSync('config/sources.json', 'utf8'));
const CV_PATH = 'assets/XueKe_Consultant_CV_v2.pdf';

async function main() {
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync('data/send_queue.json', 'utf8')); } catch(e) {
    console.log('No queue file found');
    return;
  }

  let log = [];
  try { log = JSON.parse(fs.readFileSync('data/job_log.json', 'utf8')); } catch(e) {}

  const now = new Date();
  const toSend = queue.filter(q =>
    !q.cancelled &&
    !q.sent &&
    new Date(q.sendAfter) <= now
  );

  console.log(`${toSend.length} emails ready to send`);

  for (const item of toSend) {
    const job = item.job;
    try {
      const subject = `Application: ${job.title} — Xue Ke (PhD, ex-UN)`;
      const body = `Hi,

${job.coverLetter || generateFallbackBody(job)}

Best,
Xue Ke
xuexx130@gmail.com`;

      await sendEmail(job.emailAddress, subject, body, CV_PATH);

      item.sent = true;
      item.sentAt = new Date().toISOString();

      log.push({
        jobId: item.jobId,
        title: job.title,
        org: job.org,
        emailAddress: job.emailAddress,
        score: job.score,
        sentAt: item.sentAt,
        status: 'sent'
      });

      console.log(`✅ Sent: ${job.title} → ${job.emailAddress}`);
      await new Promise(r => setTimeout(r, 2000));

    } catch(e) {
      console.error(`❌ Failed: ${job.title} — ${e.message}`);
      item.error = e.message;
      log.push({
        jobId: item.jobId,
        title: job.title,
        org: job.org,
        score: job.score,
        sentAt: new Date().toISOString(),
        status: 'failed',
        error: e.message
      });
    }
  }

  fs.writeFileSync('data/send_queue.json', JSON.stringify(queue, null, 2));
  fs.writeFileSync('data/job_log.json', JSON.stringify(log, null, 2));
  console.log('Send run complete.');
}

function generateFallbackBody(job) {
  return `Attaching my CV for the ${job.title} role at ${job.org}.

Brief context: PhD in Management, two UN postings (ESCAP Bangkok, UNOG Geneva), currently teaching MBA executives in Madrid. Trilingual EN/FR/ZH.

Happy to discuss.`;
}

main().catch(console.error);
