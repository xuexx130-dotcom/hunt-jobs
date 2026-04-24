#!/usr/bin/env node
/**
 * hunt-jobs/scripts/fetch.js
 * 1. Fetch jobs from UN Talent API + Upwork RSS + OECD
 * 2. Deduplicate against seen_jobs.json
 * 3. Keyword pre-filter (zero AI cost)
 * 4. Batch score with Gemini (1 API call)
 * 5. Write results to data/jobs_today.json and data/job_log.json
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const ROOT        = path.join(__dirname, '..');
const CONFIG      = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/sources.json'), 'utf8'));
const SEEN_PATH   = path.join(ROOT, 'data/seen_jobs.json');
const TODAY_PATH  = path.join(ROOT, 'data/jobs_today.json');
const LOG_PATH    = path.join(ROOT, 'data/job_log.json');
const GEMINI_KEY  = process.env.GEMINI_API_KEY;

if (!GEMINI_KEY) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

// ── helpers ───────────────────────────────────────────────────────────────────
function fetch_url(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HuntBot/1.0)' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout: ' + url)); });
  });
}

function post_json(hostname, path_str, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname, path: path_str, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

function make_hash(title, company) {
  return crypto.createHash('md5').update(`${title}||${company}`.toLowerCase()).digest('hex').slice(0, 12);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── XML/RSS parser (no deps) ──────────────────────────────────────────────────
function parse_rss(xml) {
  const items = [];
  const item_re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = item_re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => { const r = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'); const x = r.exec(block); return x ? (x[1] || x[2] || '').trim() : ''; };
    items.push({ title: get('title'), description: get('description'), link: get('link') || get('guid'), pubDate: get('pubDate') });
  }
  return items;
}

// ── Source 1: UN Talent API ───────────────────────────────────────────────────
async function fetch_untalent() {
  console.log('[UN Talent] fetching...');
  const jobs = [];
  // UN Talent open API — filter by keyword clusters relevant to candidate
  const queries = ['learning', 'ESG', 'communication', 'consultant', 'training', 'sustainability'];
  for (const q of queries) {
    try {
      const url = `https://untalent.org/api/jobs?search=${encodeURIComponent(q)}&limit=20`;
      const res = await fetch_url(url);
      if (res.status !== 200) { console.warn(`[UN Talent] ${q} → HTTP ${res.status}`); continue; }
      const data = JSON.parse(res.body);
      const list = Array.isArray(data) ? data : (data.jobs || data.data || []);
      for (const j of list) {
        jobs.push({
          id:          'unt_' + (j.id || make_hash(j.title || '', j.organization || '')),
          title:       j.title || j.job_title || '',
          company:     j.organization || j.agency || 'UN',
          location:    j.location || j.duty_station || '',
          description: (j.description || j.summary || '').slice(0, 1200),
          url:         j.url || j.apply_url || `https://untalent.org/jobs/${j.id}`,
          source:      'UN Talent',
          date:        new Date().toISOString().slice(0, 10)
        });
      }
      await sleep(500);
    } catch (e) { console.warn('[UN Talent]', q, e.message); }
  }
  console.log(`[UN Talent] raw: ${jobs.length}`);
  return jobs;
}

// ── Source 2: UNDP RSS ────────────────────────────────────────────────────────
async function fetch_undp() {
  console.log('[UNDP] fetching RSS...');
  try {
    const res = await fetch_url('https://jobs.undp.org/cj_rss_feed.cfm');
    if (res.status !== 200) { console.warn('[UNDP] HTTP', res.status); return []; }
    const items = parse_rss(res.body);
    return items.map(i => ({
      id:          'undp_' + make_hash(i.title, 'UNDP'),
      title:       i.title,
      company:     'UNDP',
      location:    '',
      description: i.description.replace(/<[^>]+>/g, ' ').slice(0, 1200),
      url:         i.link,
      source:      'UNDP RSS',
      date:        new Date().toISOString().slice(0, 10)
    }));
  } catch (e) { console.warn('[UNDP]', e.message); return []; }
}

// ── Source 3: Upwork RSS ──────────────────────────────────────────────────────
async function fetch_upwork() {
  console.log('[Upwork] fetching RSS...');
  const jobs = [];
  const searches = [
    'learning+development+consultant',
    'ESG+consultant',
    'instructional+designer',
    'international+development+consultant',
    'corporate+training+consultant'
  ];
  for (const s of searches) {
    try {
      const url = `https://www.upwork.com/ab/feed/jobs/rss?q=${s}&sort=recency&paging=0%3B10`;
      const res = await fetch_url(url);
      if (res.status !== 200) { console.warn('[Upwork]', s, 'HTTP', res.status); continue; }
      const items = parse_rss(res.body);
      for (const i of items) {
        jobs.push({
          id:          'upw_' + make_hash(i.title, 'Upwork'),
          title:       i.title,
          company:     'Upwork Client',
          location:    'Remote',
          description: i.description.replace(/<[^>]+>/g, ' ').slice(0, 1200),
          url:         i.link,
          source:      'Upwork',
          date:        new Date().toISOString().slice(0, 10)
        });
      }
      await sleep(600);
    } catch (e) { console.warn('[Upwork]', s, e.message); }
  }
  console.log(`[Upwork] raw: ${jobs.length}`);
  return jobs;
}

// ── Source 4: OECD (SmartRecruiters) ─────────────────────────────────────────
async function fetch_oecd() {
  console.log('[OECD] fetching...');
  try {
    const url = 'https://api.smartrecruiters.com/v1/companies/OECD/postings?limit=20&offset=0';
    const res = await fetch_url(url);
    if (res.status !== 200) { console.warn('[OECD] HTTP', res.status); return []; }
    const data = JSON.parse(res.body);
    const list = data.content || [];
    return list.map(j => ({
      id:          'oecd_' + (j.id || make_hash(j.name, 'OECD')),
      title:       j.name || '',
      company:     'OECD',
      location:    (j.location && j.location.city) ? j.location.city + ', ' + (j.location.country || '') : 'Paris',
      description: (j.jobAd && j.jobAd.sections && j.jobAd.sections.jobDescription && j.jobAd.sections.jobDescription.text || '').replace(/<[^>]+>/g, ' ').slice(0, 1200),
      url:         `https://www.smartrecruiters.com/OECD/${j.id}`,
      source:      'OECD',
      date:        new Date().toISOString().slice(0, 10)
    }));
  } catch (e) { console.warn('[OECD]', e.message); return []; }
}

// ── Dedup ─────────────────────────────────────────────────────────────────────
function dedup(jobs) {
  const seen = new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8') || '[]'));
  const fresh = jobs.filter(j => {
    const h = make_hash(j.title, j.company);
    if (seen.has(h) || seen.has(j.id)) return false;
    return true;
  });
  console.log(`[Dedup] ${jobs.length} → ${fresh.length} new`);
  return fresh;
}

// ── Keyword pre-filter ────────────────────────────────────────────────────────
function pre_filter(jobs) {
  const exclude = CONFIG.exclude_keywords.map(k => k.toLowerCase());
  const filtered = jobs.filter(j => {
    const text = (j.title + ' ' + j.description).toLowerCase();
    const hit = exclude.find(k => text.includes(k));
    if (hit) { console.log(`[Filter] excluded "${j.title}" — matched: "${hit}"`); return false; }
    return true;
  });
  console.log(`[Filter] ${jobs.length} → ${filtered.length} passed keyword filter`);
  return filtered;
}

// ── Gemini batch score ────────────────────────────────────────────────────────
async function gemini_score(jobs) {
  if (jobs.length === 0) return [];

  const c = CONFIG.candidate;
  const system_prompt = `You are a senior executive recruiter screening jobs for a specific candidate.

CANDIDATE PROFILE:
${c.background}

AVOID: ${c.avoid}

SCORING RUBRIC:
9-10 (Perfect): Top consulting firm (Big 4, Palladium, DAI, Chemonics, GIZ, Accenture) OR international organisation. Keywords: ESG Strategy, L&D Lead, Capacity Building, Organizational Learning, Sustainable Finance, Corporate Training Director. Emphasises communication, facilitation, strategic advisory. Remote or preferred locations (Paris, Geneva, Dubai, Bangkok, Singapore, Hong Kong).

7-8 (Good): Senior/Lead L&D or sustainability role at multinational. Focus on design/facilitation not heavy coding. Location flexible or remote. Can leverage UN background.

4-6 (Neutral): Mid-level analyst role, some technical requirements but not dominant. Large employer but role is generic.

1-3 (Discard): Requires heavy coding/SQL/ETL as primary duty. Needs 10+ years big corporate management. Visa sponsorship required in restrictive country. Entry-level despite seniority required.

IMPORTANT: candidate has French long-stay permit — no EU visa sponsorship needed. PhD + UN experience = strong differentiator. Multilingual (EN/FR/ZH/ES/AR) = asset for international roles.

Return ONLY a valid JSON array, no markdown, no explanation:
[
  {
    "id": "<job id>",
    "score": <integer 1-10>,
    "match_reason": "<2 sentences why this fits or not>",
    "hook": "<60-word cover letter opening tailored to this specific role, first person, referencing PhD + UN experience naturally>"
  }
]`;

  const jobs_text = jobs.map(j =>
    `ID: ${j.id}\nTitle: ${j.title}\nCompany: ${j.company}\nLocation: ${j.location}\nDescription: ${j.description.slice(0, 800)}`
  ).join('\n\n---\n\n');

  const payload = {
    contents: [{ parts: [{ text: `${system_prompt}\n\nJOBS TO SCORE:\n\n${jobs_text}` }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
  };

  try {
    console.log(`[Gemini] scoring ${jobs.length} jobs in 1 API call...`);
    const res = await post_json(
      'generativelanguage.googleapis.com',
      `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      payload
    );
    if (res.status !== 200) {
      console.error('[Gemini] HTTP', res.status, res.body.slice(0, 300));
      return [];
    }
    const data = JSON.parse(res.body);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const json_match = text.match(/\[[\s\S]*\]/);
    if (!json_match) { console.error('[Gemini] no JSON array found in response'); return []; }
    const scores = JSON.parse(json_match[0]);
    console.log(`[Gemini] scored ${scores.length} jobs`);
    return scores;
  } catch (e) {
    console.error('[Gemini]', e.message);
    return [];
  }
}

// ── QC self-check ─────────────────────────────────────────────────────────────
async function qc_check(job, hook) {
  const payload = {
    contents: [{ parts: [{ text: `You are a quality checker for job application materials.

Check this cover letter opening for issues:
Candidate name: Xue Ke
Target company: ${job.company}
Target role: ${job.title}

Hook text: "${hook}"

Check for:
1. Wrong company or role name mentioned?
2. Template placeholders like [INSERT NAME]?
3. Claims candidate clearly cannot support (e.g. "10 years at Fortune 500")?
4. Factual contradictions?

Reply ONLY with JSON: {"pass": true} or {"pass": false, "reason": "..."}`
    }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 100 }
  };
  try {
    const res = await post_json(
      'generativelanguage.googleapis.com',
      `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      payload
    );
    const data = JSON.parse(res.body);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{"pass":true}';
    const json_match = text.match(/\{[\s\S]*\}/);
    return json_match ? JSON.parse(json_match[0]) : { pass: true };
  } catch (e) { return { pass: true }; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== HUNT JOB PIPELINE START', new Date().toISOString(), '===\n');

  // 1. Fetch all sources
  const [untalent, undp, upwork, oecd] = await Promise.all([
    fetch_untalent(),
    fetch_undp(),
    fetch_upwork(),
    fetch_oecd()
  ]);

  const all_raw = [...untalent, ...undp, ...upwork, ...oecd];
  console.log(`\n[Total raw] ${all_raw.length} jobs fetched`);

  // 2. Dedup
  const fresh = dedup(all_raw);

  // 3. Keyword pre-filter
  const candidates = pre_filter(fresh);

  // 4. Gemini batch score
  const scores = await gemini_score(candidates);

  // Build score map
  const score_map = {};
  for (const s of scores) score_map[s.id] = s;

  // 5. Filter by min_score + QC check
  const approved = [];
  for (const job of candidates) {
    const s = score_map[job.id];
    if (!s) continue;
    if (s.score < CONFIG.min_score) {
      console.log(`[Score] ${s.score}/10 SKIP — ${job.title} @ ${job.company}`);
      continue;
    }

    // QC check hook
    const qc = await qc_check(job, s.hook || '');
    if (!qc.pass) {
      console.log(`[QC] FAIL — ${job.title}: ${qc.reason}`);
      continue;
    }

    console.log(`[Score] ${s.score}/10 ✓ — ${job.title} @ ${job.company}`);
    approved.push({
      ...job,
      score:        s.score,
      match_reason: s.match_reason,
      hook:         s.hook,
      status:       'new'
    });
  }

  // Sort by score desc, cap at daily limit
  approved.sort((a, b) => b.score - a.score);
  const final = approved.slice(0, CONFIG.daily_limit);

  // 6. Update seen_jobs.json
  const seen = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8') || '[]');
  for (const j of all_raw) {
    seen.push(make_hash(j.title, j.company));
    seen.push(j.id);
  }
  // Keep last 3000 hashes to avoid unbounded growth
  const unique_seen = [...new Set(seen)].slice(-3000);
  fs.writeFileSync(SEEN_PATH, JSON.stringify(unique_seen, null, 2));

  // 7. Write today's jobs
  fs.writeFileSync(TODAY_PATH, JSON.stringify(final, null, 2));

  // 8. Append to log
  const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8') || '[]');
  log.unshift({
    run_date:    new Date().toISOString().slice(0, 10),
    run_time:    new Date().toISOString(),
    raw_fetched: all_raw.length,
    after_dedup: fresh.length,
    after_filter:candidates.length,
    approved:    final.length,
    jobs:        final.map(j => ({
      id: j.id, title: j.title, company: j.company,
      score: j.score, source: j.source, url: j.url, status: j.status
    }))
  });
  // Keep last 60 daily logs
  fs.writeFileSync(LOG_PATH, JSON.stringify(log.slice(0, 60), null, 2));

  console.log(`\n=== DONE: ${final.length} jobs approved today ===\n`);
  final.forEach(j => console.log(`  [${j.score}] ${j.title} @ ${j.company} (${j.source})`));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
