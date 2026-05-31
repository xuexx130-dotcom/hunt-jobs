const https = require('https');
const fs = require('fs');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const CV_SUMMARY = `Xue Ke - PhD Management (asset pricing + CSR factors, thesis in English)
- UN ESCAP Bangkok (Apr-Nov 2022): Economic Survey of Asia-Pacific, data visualization
- UNOG Geneva SDG Lab (2021-2022): Building Bridges Week summit, social media
- UEM Madrid (2022-present): MBA/Masters lecturer, built BI course 0-to-1 (5 modules, 40h+), 300+ students, 4.8/5 rating
- Trilingual: English (fluent), French (fluent, DALF C1, 10+ years France), Chinese (native)
- Based: Bali/Southeast Asia (digital nomad), French long-stay visa holder`;

async function generateCoverLetter(job) {
  const lang = job.title.match(/français|francophone|french/i) ? 'French' : 'English';
  
  const prompt = `Write a concise, direct cover letter in ${lang} for this job application.

Applicant: ${CV_SUMMARY}

Job: "${job.title}" at ${job.org}
URL: ${job.url}

Style: Brief and direct (style B - not overly formal). 3-4 short paragraphs max.
- Para 1: One punchy hook connecting specific experience to this role
- Para 2: Most relevant achievement (quantified if possible)  
- Para 3: Why this org/role specifically
- Para 4: Simple close

Sign off as: Xue Ke | xuexx130@gmail.com

Do NOT use generic phrases like "I am writing to express my interest". Start with something specific and compelling.`;

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
          resolve(resp.candidates[0].content.parts[0].text);
        } catch(e) {
          resolve('Cover letter generation failed.');
        }
      });
    });
    req.on('error', () => resolve('Cover letter generation failed.'));
    req.write(body);
    req.end();
  });
}

async function main() {
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync('data/jobs_today.json', 'utf8')); } catch(e) {}
  
  const CONFIG = JSON.parse(fs.readFileSync('config/sources.json', 'utf8'));
  const topJobs = jobs.filter(j => j.score >= CONFIG.scoring.dashboard_threshold);
  
  console.log(`Generating cover letters for ${topJobs.length} jobs...`);
  
  for (const job of topJobs) {
    if (!job.coverLetter) {
      console.log(`Generating for: ${job.title}`);
      job.coverLetter = await generateCoverLetter(job);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  fs.writeFileSync('data/jobs_today.json', JSON.stringify(jobs, null, 2));
  console.log('Cover letters generated.');
}

main().catch(console.error);
