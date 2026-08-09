# NEWSDESK — cloud edition

Automatic daily news monitoring. Runs every morning on GitHub Actions,
publishes results to GitHub Pages, and pushes urgent items to Telegram.

## One-time setup (~15 minutes)

### 1. Create the repository
1. Create a GitHub account at github.com (if you don't have one)
2. Click **+** (top right) → **New repository**
3. Name: `newsdesk` · visibility: **Private** → **Create repository**
4. Upload all files from this package: **Add file → Upload files** →
   drag the entire folder contents (including the `.github` folder — if drag
   misses it, create the file `.github/workflows/scan.yml` manually via
   **Add file → Create new file** and paste its contents)

### 2. Add your Anthropic API key
1. Get a key at **console.anthropic.com** → API Keys → Create Key
   (add billing credits first: Settings → Billing; $5 goes a long way)
2. In your repo: **Settings → Secrets and variables → Actions → New repository secret**
3. Name: `ANTHROPIC_API_KEY` · Value: your `sk-ant-...` key → **Add secret**

### 3. Telegram alerts (optional but recommended)
1. In Telegram, message **@BotFather** → send `/newbot` → follow prompts →
   copy the **bot token** (looks like `123456:ABC-DEF...`)
2. Message **your new bot** anything (e.g. "hi") so it can reply to you
3. Message **@userinfobot** → it replies with your **numeric id**
4. Add two more repository secrets:
   - `TELEGRAM_BOT_TOKEN` = the bot token
   - `TELEGRAM_CHAT_ID` = your numeric id

### 4. Turn on the website
1. Repo **Settings → Pages**
2. Source: **Deploy from a branch** · Branch: **main** · Folder: **/ (root)** → Save
3. Your dashboard will live at `https://YOURNAME.github.io/newsdesk/`
   (private repos need GitHub Pro for Pages — alternatively make the repo
   public, or skip Pages and read results from Telegram + the repo itself)

### 5. First run
1. **Actions** tab → **Daily news scan** → **Run workflow**
2. Watch it run (~3-5 min). When green, open your Pages URL — done.
3. From now on it runs by itself every morning (04:00 UTC by default —
   edit the cron line in `.github/workflows/scan.yml` to change the time).

## Daily life
- **Nothing to do.** The scan runs automatically; the page is always current.
- Urgent items (urgency 4-5) arrive as Telegram messages.
- Edit `config.json` to change projects, keywords, briefs, the alert
  threshold (`alert_min_urgency`), or retention days. Commit = applied.

## Costs
- GitHub Actions + Pages: free tier is plenty
- Anthropic API: roughly $0.10-0.30 per daily scan (web searches billed per use)
