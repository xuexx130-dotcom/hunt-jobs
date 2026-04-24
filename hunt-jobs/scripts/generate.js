#!/usr/bin/env node
/**
 * hunt-jobs/scripts/generate.js
 * For each job in jobs_today.json:
 *   1. Detect language (EN or FR) from job description
 *   2. Generate tailored Cover Letter via Gemini
 *   3. QC self-check
 *   4. Save to data/letters/{job_id}.json
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const ROOT       = path.join(__dirname, '..');
const TODAY_PATH = path.join(ROOT, 'data/jobs_today.json');
const LETTERS_DIR= path.join(ROOT, 'data/letters');
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_KEY) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
if (!fs.existsSync(LETTERS_DIR)) fs.mkdirSync(LETTERS_DIR, { recursive: true });

const CANDIDATE = {
  name:    'Xue Ke',
  email:   process.env.GMAIL_USER || '',
  phone:   '+33 783 991 866',
  tagline: 'Management PhD | UN ESCAP Bangkok · UNOG Geneva | L&D & ESG Consultant',
  background: `
- Management PhD (ESG-integrated asset pricing, Universidad Europea de Madrid, 2021; thesis in English)
- UN ESCAP Bangkok (2022): authored content for Economic and Social Survey of Asia and the Pacific; data visualisation for 58 member states
- UNOG Geneva SDG Lab (2021-2022): coordinated Building Bridges Week — dialogue between Swiss investors and African development projects; managed multilingual social media
- Universidad Europea de Madrid, Lecturer (2022–present): designed Business Intelligence curriculum from zero (5 modules, 40h+); facilitated live sessions for 300+ executives (avg age 40+) across 10+ industries; ESG/sustainable finance lecture series grounded in PhD research
- Languages: English (fluent, PhD thesis), French (fluent, 10+ years France), Chinese (native), Spanish & Arabic (working proficiency)
- French long-stay residence permit — no EU visa sponsorship needed
- Open to remote, Paris, Geneva, Dubai, Bangkok, Singapore, Hong Kong
`.trim()
};

// ── Gemini call ───────────────────────────────────────────────────────────────
function gemini(prompt, max_tokens = 1500) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: max_tokens }
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

async function gemini_text(prompt, max_tokens = 1500) {
  const res = await gemini(prompt, max_tokens);
  if (res.status !== 200) throw new Error('Gemini HTTP ' + res.status + ': ' + res.body.slice(0,200));
  const data = JSON.parse(res.body);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Language detection ────────────────────────────────────────────────────────
async function detect_language(job) {
  // Fast heuristic first — check for French keywords in title/company/location
  const text = (job.title + ' ' + job.company + ' ' + job.location + ' ' + job.description).toLowerCase();
  const fr_signals = ['français', 'french required', 'bilingue', 'francophone', 'paris', 'genève', 'suisse', 'luxembourg', 'québec', 'oecd', 'ocde'];
  const fr_hits = fr_signals.filter(s => text.includes(s)).length;

  // If strong French signals, use French; otherwise English
  if (fr_hits >= 2 || job.source === 'OECD') {
    console.log(`[Lang] ${job.title} → FR (signals: ${fr_hits})`);
    return 'FR';
  }
  console.log(`[Lang] ${job.title} → EN`);
  return 'EN';
}

// ── Cover Letter generation ───────────────────────────────────────────────────
async function generate_letter(job, lang) {
  const is_fr = lang === 'FR';

  const prompt = is_fr ? `
Tu es un expert en rédaction de lettres de motivation pour des postes de conseil international et de L&D.

PROFIL DU CANDIDAT :
${CANDIDATE.background}

Rédige une lettre de motivation professionnelle en français pour le poste suivant.
Longueur : 320-380 mots. 3 paragraphes.

Structure obligatoire :
§1 (Accroche, 2-3 phrases) : Commence par une connexion directe entre l'expérience ONU du candidat et le défi spécifique de ce poste. Ne pas commencer par "Je".
§2 (Valeur ajoutée, 4-5 phrases) : Deux preuves concrètes et chiffrées tirées du parcours (ESCAP, UEM, UNOG). Relier explicitement aux besoins du poste.
§3 (Closing, 2-3 phrases) : Intention claire, disponibilité, invitation à l'entretien.

Règles strictes :
- NE PAS mentionner de compétences que le candidat ne possède pas
- NE PAS utiliser de formules génériques ("je suis passionné par", "ce poste m'attire")
- Ton : expert qui se repositionne, pas étudiant qui cherche un stage
- Terminer par : "Veuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées."

POSTE :
Titre : ${job.title}
Organisation : ${job.company}
Lieu : ${job.location}
Description : ${job.description.slice(0, 1000)}

Retourne UNIQUEMENT le corps de la lettre (sans en-tête, sans signature).
` : `
You are an expert cover letter writer for international development, L&D, and ESG consulting roles.

CANDIDATE PROFILE:
${CANDIDATE.background}

Write a professional English cover letter for the following role.
Length: 320-380 words. 3 paragraphs.

Required structure:
§1 (Hook, 2-3 sentences): Open with a direct connection between the candidate's UN field experience and this role's specific challenge. Do NOT start with "I".
§2 (Value, 4-5 sentences): Two concrete, quantified proof points from the candidate's background (ESCAP, UEM, UNOG). Explicitly link them to the role's requirements.
§3 (Close, 2-3 sentences): Clear intent, availability, invite to interview.

Strict rules:
- Do NOT claim skills or experience the candidate does not have
- Do NOT use generic phrases ("I am passionate about", "this role excites me")
- Tone: senior expert repositioning, NOT graduate seeking first job
- End with: "I look forward to the opportunity to discuss how my background aligns with your team's objectives."

ROLE:
Title: ${job.title}
Organisation: ${job.company}
Location: ${job.location}
Description: ${job.description.slice(0, 1000)}

Return ONLY the letter body (no header, no signature block).
`;

  const letter = await gemini_text(prompt, 1200);
  return letter.trim();
}

// ── QC check ──────────────────────────────────────────────────────────────────
async function qc_letter(job, letter, lang) {
  const prompt = `You are a quality checker for job application cover letters.

Candidate: Xue Ke
Role: ${job.title} at ${job.company}
Language expected: ${lang}

Cover letter:
"""
${letter}
"""

Check for these failure conditions ONLY:
1. Wrong company name or role title mentioned (factual error)?
2. Template placeholder like [INSERT NAME] or [COMPANY] left unfilled?
3. Candidate claims skills clearly not in their background (e.g. "15 years at McKinsey", "certified PMP")?
4. Letter is in the wrong language?

Reply ONLY with JSON — no explanation outside JSON:
{"pass": true}
or
{"pass": false, "reason": "short description of the specific problem"}`;

  const text = await gemini_text(prompt, 120);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { pass: true };
  try { return JSON.parse(match[0]); }
  catch { return { pass: true }; }
}

// ── Build full email draft ────────────────────────────────────────────────────
function build_email(job, letter, lang) {
  const is_fr = lang === 'FR';
  const today = new Date().toLocaleDateString(is_fr ? 'fr-FR' : 'en-GB', { day:'numeric', month:'long', year:'numeric' });

  const subject = is_fr
    ? `Candidature — ${job.title} | Xue Ke | PhD Management, ex-ONU`
    : `Application — ${job.title} | Xue Ke | PhD, UN ESCAP & UNOG`;

  const header = is_fr
    ? `Madame, Monsieur,\n\n`
    : `Dear Hiring Manager,\n\n`;

  const signature = is_fr
    ? `\n\nXue Ke\n${CANDIDATE.tagline}\n${CANDIDATE.email} | ${CANDIDATE.phone}\nDisponible immédiatement | Télétravail & déplacements possibles`
    : `\n\nSincerely,\n\nXue Ke\n${CANDIDATE.tagline}\n${CANDIDATE.email} | ${CANDIDATE.phone}\nAvailable immediately | Remote & relocation ready`;

  return {
    subject,
    body: header + letter + signature,
    to: '',   // left blank — HR email to be filled manually or via apply link
    lang
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== GENERATE COVER LETTERS START', new Date().toISOString(), '===\n');

  const jobs = JSON.parse(fs.readFileSync(TODAY_PATH, 'utf8') || '[]');
  if (jobs.length === 0) { console.log('No jobs to process.'); return; }

  let generated = 0, skipped = 0;

  for (const job of jobs) {
    const out_path = path.join(LETTERS_DIR, `${job.id}.json`);

    // Skip if already generated today
    if (fs.existsSync(out_path)) {
      const existing = JSON.parse(fs.readFileSync(out_path, 'utf8'));
      if (existing.date === new Date().toISOString().slice(0,10)) {
        console.log(`[Skip] already generated: ${job.title}`);
        skipped++;
        continue;
      }
    }

    console.log(`\n[Generate] ${job.title} @ ${job.company} (score: ${job.score})`);

    try {
      // 1. Detect language
      const lang = await detect_language(job);

      // 2. Generate cover letter
      const letter = await generate_letter(job, lang);

      // 3. QC check
      const qc = await qc_letter(job, letter, lang);
      if (!qc.pass) {
        console.log(`  [QC FAIL] ${qc.reason} — skipping`);
        skipped++;
        continue;
      }

      // 4. Build full email
      const email = build_email(job, letter, lang);

      // 5. Save
      const result = {
        job_id:   job.id,
        date:     new Date().toISOString().slice(0,10),
        lang,
        subject:  email.subject,
        body:     email.body,
        letter,   // just the body paragraph
        qc_pass:  true,
        status:   'ready'   // ready → drafted → sent
      };
      fs.writeFileSync(out_path, JSON.stringify(result, null, 2));

      console.log(`  [✓] Generated (${lang}) — "${email.subject.slice(0,60)}"`);
      generated++;

      // Rate limit: 1 letter per 3 seconds to stay within Gemini free tier
      await sleep(3000);

    } catch (e) {
      console.error(`  [Error] ${job.title}: ${e.message}`);
      skipped++;
    }
  }

  console.log(`\n=== DONE: ${generated} letters generated, ${skipped} skipped ===`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
