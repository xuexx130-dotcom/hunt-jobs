#!/usr/bin/env node
/**
 * hunt-jobs/scripts/draft.js
 * Reads generated cover letters from data/letters/
 * Creates Gmail DRAFTS via IMAP APPEND (no OAuth needed — uses App Password)
 * Drafts appear in your Gmail Drafts folder for you to review and send.
 */

const fs   = require('fs');
const path = require('path');
const net  = require('net');
const tls  = require('tls');

const ROOT        = path.join(__dirname, '..');
const LETTERS_DIR = path.join(ROOT, 'data/letters');
const TODAY_PATH  = path.join(ROOT, 'data/jobs_today.json');
const LOG_PATH    = path.join(ROOT, 'data/job_log.json');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

if (!GMAIL_USER || !GMAIL_PASS) {
  console.error('GMAIL_USER and GMAIL_APP_PASSWORD must be set');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── RFC 2822 message builder ──────────────────────────────────────────────────
function build_mime(to, subject, body, from_name, from_email) {
  const date = new Date().toUTCString();
  // Encode subject for non-ASCII safety
  const enc_subject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const lines = [
    `From: ${from_name} <${from_email}>`,
    `To: ${to || from_email}`,   // if no HR email, draft to self
    `Subject: ${enc_subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n')
  ];
  return lines.join('\r\n');
}

// ── IMAP APPEND to Gmail Drafts (TLS) ────────────────────────────────────────
function imap_append_draft(mime_message) {
  return new Promise((resolve, reject) => {
    let tag_counter = 1;
    const tag = () => `A${String(tag_counter++).padStart(3,'0')}`;
    let buf = '';
    let state = 'greeting';

    const socket = tls.connect({ host: 'imap.gmail.com', port: 993 }, () => {
      console.log('  [IMAP] Connected');
    });

    socket.setEncoding('utf8');
    socket.setTimeout(20000);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('IMAP timeout')); });
    socket.on('error', reject);

    function send(cmd) {
      console.log('  [IMAP →]', cmd.slice(0, 80));
      socket.write(cmd + '\r\n');
    }

    socket.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\r\n');
      buf = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line) continue;
        console.log('  [IMAP ←]', line.slice(0, 100));

        if (state === 'greeting' && line.startsWith('* OK')) {
          state = 'login';
          const t = tag();
          send(`${t} LOGIN "${GMAIL_USER}" "${GMAIL_PASS}"`);

        } else if (state === 'login' && line.includes(' OK ')) {
          state = 'append';
          const msg_bytes = Buffer.byteLength(mime_message, 'utf8');
          const t = tag();
          send(`${t} APPEND "[Gmail]/Drafts" (\\Draft) {${msg_bytes}}`);

        } else if (state === 'append' && line.startsWith('+')) {
          // Server ready for message literal
          socket.write(mime_message + '\r\n');
          state = 'append_wait';

        } else if (state === 'append_wait' && line.includes(' OK ')) {
          state = 'logout';
          send(`${tag()} LOGOUT`);

        } else if (state === 'logout') {
          socket.destroy();
          resolve();
          return;

        } else if (line.includes(' NO ') || line.includes(' BAD ')) {
          socket.destroy();
          reject(new Error('IMAP error: ' + line));
          return;
        }
      }
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== DRAFT TO GMAIL START', new Date().toISOString(), '===\n');

  if (!fs.existsSync(LETTERS_DIR)) { console.log('No letters directory.'); return; }

  const today = new Date().toISOString().slice(0,10);
  const files = fs.readdirSync(LETTERS_DIR).filter(f => f.endsWith('.json'));

  const jobs = JSON.parse(fs.readFileSync(TODAY_PATH, 'utf8') || '[]');
  const job_map = {};
  for (const j of jobs) job_map[j.id] = j;

  let drafted = 0, skipped = 0;

  for (const file of files) {
    const letter_path = path.join(LETTERS_DIR, file);
    const letter = JSON.parse(fs.readFileSync(letter_path, 'utf8'));

    // Only process today's ready letters
    if (letter.date !== today)   { skipped++; continue; }
    if (letter.status !== 'ready') { skipped++; continue; }

    const job = job_map[letter.job_id];
    if (!job) { skipped++; continue; }

    console.log(`[Draft] ${job.title} @ ${job.company}`);

    try {
      // Build MIME message
      // 'to' field: if job has a direct HR email, use it; otherwise leave as sender (self-draft)
      const to = job.hr_email || '';
      const mime = build_mime(to, letter.subject, letter.body, 'Xue Ke', GMAIL_USER);

      // Append to Gmail Drafts
      await imap_append_draft(mime);

      // Mark as drafted
      letter.status = 'drafted';
      letter.drafted_at = new Date().toISOString();
      fs.writeFileSync(letter_path, JSON.stringify(letter, null, 2));

      console.log(`  [✓] Draft created in Gmail`);
      drafted++;

      await sleep(2000); // small delay between IMAP connections

    } catch (e) {
      console.error(`  [Error] ${e.message}`);
      skipped++;
    }
  }

  // Update log with draft counts
  const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8') || '[]');
  if (log.length > 0 && log[0].run_date === today) {
    log[0].drafted = drafted;
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  }

  console.log(`\n=== DONE: ${drafted} drafts created, ${skipped} skipped ===`);
  console.log('Check your Gmail Drafts folder to review and send.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
