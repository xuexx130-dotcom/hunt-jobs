# hunt-jobs

Automated job pipeline: fetch → score → generate cover letter → Gmail draft.

**You review drafts in Gmail and hit Send when ready. That's your only task.**

---

## Setup (20 minutes total)

### Step 1 — Gmail App Password (5 min)

1. Go to [myaccount.google.com/security](https://myaccount.google.com/security)
2. Enable **2-Step Verification** (required)
3. Search for **"App passwords"** → Create → Name it "hunt-bot" → Copy the 16-character password

### Step 2 — GitHub Repository (5 min)

1. Create a new **private** GitHub repository named `hunt-jobs`
2. Upload all files from this zip
3. **Settings → Secrets → Actions → New repository secret** — add these 3:

| Secret | Value |
|---|---|
| `GEMINI_API_KEY` | Free at [aistudio.google.com](https://aistudio.google.com) |
| `GMAIL_USER` | your@gmail.com |
| `GMAIL_APP_PASSWORD` | 16-char App Password from Step 1 |

### Step 3 — Deploy Dashboard to Vercel (5 min)

1. [vercel.com](https://vercel.com) → New Project → Import `hunt-jobs` repo
2. Root Directory → `public`
3. Deploy

### Step 4 — Test run (2 min)

GitHub → Actions → **Daily Job Hunt** → **Run workflow**

After ~3 minutes: check `data/jobs_today.json`, `data/letters/`, and your **Gmail Drafts folder**.

---

## Daily workflow (fully automatic)

```
08:00 UTC — GitHub Actions runs
  Fetch: UN Talent API + UNDP RSS + Upwork RSS + OECD
  Dedup: skip jobs seen before
  Filter: discard ETL/dev/SQL roles (zero AI cost)
  Score: Gemini 1.5 Flash — all jobs in 1 API call
  For each job ≥6/10:
    → Detect language (EN or FR)
    → Generate cover letter
    → QC self-check
    → Append to Gmail Drafts via IMAP
  Commit data files → Dashboard updates on Vercel

You open Gmail Drafts when convenient
  Add HR email address → review → Send (or delete)
```

---

## Customise

Edit `config/sources.json` to adjust keywords, excluded terms, min score, and candidate background.

---

## Cost: $0/month

GitHub Actions free tier (2000 min/month) + Gemini Flash free tier (1500 req/day) + Vercel free tier.
