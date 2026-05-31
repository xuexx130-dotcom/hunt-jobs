const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CONFIG = JSON.parse(fs.readFileSync('config/sources.json', 'utf8'));

let seenJobs = [];
try { seenJobs = JSON.parse(fs.readFileSync('data/seen_jobs.json', 'utf8')); } catch(e) {}

const jobHash = (job) => crypto.createHash('md5').update(job.title + job.org).digest('hex');

async function fetchUNDP() {
  return new Promise((resolve) => {
    https.get('https://jobs.undp.org/cj_view_jobs.cfm?res_lan=1&res_cty=0&descType=1', (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const jobs = [];
        const matches = data.matchAll(/<item>([\s\S]*?)<\/item>/g);
        for (const m of matches) {
          const title = (m[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || '';
          const link = (m[1].match(/<link>(.*?)<\/link>/) || [])[1] || '';
          if (title) jobs.push({ title, url: link, org: 'UNDP', source: 'undp', applyViaEmail: false });
        }
        resolve(jobs);
      });
    }).on('error', () => resolve([]));
  });
}

async function fetchUNTalent() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'careers.un.org',
      path: '/lbw/home.aspx?viewtype=rss',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const jobs = [];
        const matches = data.matchAll(/<item>([\s\S]*?)<\/item>/g);
        for (const m of matches) {
          const title = (m[1].match(/<title>(.*?)<\/title>/) || [])[1] || '';
          const link = (m[1].match(/<link>(.*?)<\/link>/) || [])[1] || '';
          if (title) jobs.push({ title, url: link, org: 'UN Secretariat', source: 'un_talent', applyViaEmail: false });
        }
        resolve(jobs);
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

async function scoreJobs(jobs) {
  if (!jobs.length) return [];
  const prompt = `You are evaluating job opportunities for Xue Ke (PhD Management, ex-UN ESCAP Bangkok + UNOG Geneva, trilingual EN/FR/ZH, L&D specialist who built BI course 0-to-1, teaching MBA executives).

Score each job 0-100 for fit. High scores for: L&D Consultant, Training, Capacity Building, ESG Consulting, International Development, Knowledge Management. Bonus for: UN/IO experience valued, Asia-Pacific focus, French required, ESG/sustainability.

Also detect if job accepts email applications (look for email addresses in description or "send CV to" language).

Jobs to score:
${jobs.map((j, i) => `${i}. "${j.title}" at ${j.org}`).join('\n')}

Respond ONLY with JSON array: [{"index":0,"score":75,"reason":"Brief reason","applyViaEmail":false,"emailAddress":null}]`;

  return new Promise((resolve) => {
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          const text = resp.candidates[0].content.parts[0].text;
          const clean = text.replace(/```json|```/g, '').trim();
          const scores = JSON.parse(clean);
          resolve(jobs.map((job, i) => {
            const s = scores.find(x => x.index === i) || { score: 0, reason: 'No score', applyViaEmail: false, emailAddress: null };
            return { ...job, score: s.score, reason: s.reason, applyViaEmail: s.applyViaEmail, emailAddress: s.emailAddress };
          }));
        } catch(e) {
          resolve(jobs.map(j => ({ ...j, score: 0, reason: 'Score failed', applyViaEmail: false, emailAddress: null })));
        }
      });
    });
    req.on('error', () => resolve(jobs.map(j => ({ ...j, score: 0, reason: 'Error', applyViaEmail: false, emailAddress: null }))));
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Fetching jobs...');
  const [undpJobs, unJobs] = await Promise.all([fetchUNDP(), fetchUNTalent()]);
  const allJobs = [...undpJobs, ...unJobs];
  console.log(`Fetched ${allJobs.length} total jobs`);
  const newJobs = allJobs.filter(j => {
    const h = jobHash(j);
    if (seenJobs.includes(h)) return false;
    seenJobs.push(h);
    return true;
  });
  console.log(`${newJobs.length} new jobs after dedup`);
  if (!newJobs.length) {
    fs.writeFileSync('data/jobs_today.json', JSON.stringify([], null, 2));
    console.log('No new jobs today');
    return;
  }
  const scored = await scoreJobs(newJobs);
  const filtered = scored.filter(j => j.score >= CONFIG.scoring.dashboard_threshold);
  filtered.sort((a, b) => b.score - a.score);
  console.log(`${filtered.length} jobs above threshold`);
  fs.writeFileSync('data/seen_jobs.json', JSON.stringify(seenJobs, null, 2));
  fs.writeFileSync('data/jobs_today.json', JSON.stringify(filtered, null, 2));
  console.log('Done. Top jobs:', filtered.slice(0,3).map(j => `${j.score}: ${j.title}`));
}

main().catch(console.error);
