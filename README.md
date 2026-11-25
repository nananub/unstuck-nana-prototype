# UnStuck

A story-writing workshop: a timeline story map, a Worldbuilding section for characters, places and world rules, and AI that finds plot holes, suggests ideas and lists the characters in your notes.

The project has two parts:

- **Website:** `index.html`, `writer-desktop.html` and `writer-phone.html`.
- **Backend:** `server.js`. It serves the website, forwards AI requests to Google Gemini (the API key is stored only on the server, so visitors never see it), and records anonymous usage stats for the admin page.
- **Admin page:** `admin.html`, shown at `/admin` after logging in with the admin password.

## Run it on your computer

1. Install [Node.js](https://nodejs.org) (version 18 or newer). There are no other packages to install.
2. Get a free Gemini API key at [Google AI Studio](https://aistudio.google.com/app/apikey).
3. Make a copy of `.env.example` named `.env` (in VS Code: right-click → Copy, Paste, then rename). Open `.env` and replace `paste-your-key-here` with your key:
   ```
   GEMINI_API_KEY=your-real-key
   ```
4. In a terminal in this folder, run:
   ```
   npm start
   ```
5. Open **http://localhost:3000**. The **✦ AI** button in the top bar turns gold when the AI is on.

VS Code's Live Server can't run the backend. If you open the files with Live Server, the site works but the AI only runs if you paste your own key in **✦ AI → Use your own key instead**.

## Put it online with Render

1. Push this folder to a GitHub repository. `.env` is listed in `.gitignore`, so your key is never uploaded.
2. On [Render](https://render.com), choose **New → Web Service** and connect the repository.
3. Use these settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Under **Environment**, add `GEMINI_API_KEY` with your key and `ADMIN_PASSWORD` with a password for the admin page. For stats that survive restarts, also add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (see **Admin page and stats** below). You can also add `GEMINI_MODEL` (default `gemini-3.8-flash`) and `RATE_LIMIT_PER_MINUTE` (default 20 AI requests per visitor per minute).
5. Deploy and open the `onrender.com` address Render gives you.

Free Render services go to sleep when nobody uses them, so the first visit after a break can take a little while to load.

### Keeping the GitHub Pages site instead

If the website stays on GitHub Pages and only the backend runs on Render:

1. In `writer-desktop.html` and `writer-phone.html`, set `const AI_SERVER = 'https://your-app.onrender.com';`.
2. On Render, add `ALLOWED_ORIGINS=https://aellanguyen.github.io`.

## Admin page and stats

Open **/admin** on your site (for example `https://your-app.onrender.com/admin`). The browser asks for a login: type anything as the username and your `ADMIN_PASSWORD` as the password.

The admin page shows:

- **Totals:** visitors, visits, page views, clicks, AI requests (and failures), phone vs desktop.
- **Daily activity:** a chart of visitors and page views per day.
- **Pages:** which screens people open.
- **AI usage:** how often each AI feature is used, how often it fails, and how long it takes.
- **Most-clicked buttons.**
- **Click map:** a live preview of each page with every click drawn on top, for desktop and phone.
- **Recent activity** and **Export CSV** for all raw events.
- **Don't count my own visits:** stops your browser from adding to the stats.

**What is recorded:** page names, button names, click positions (as a fraction of the screen), screen size, phone or desktop, and random IDs for the browser and the visit. Story text is never recorded; clicks on story nodes are stored by kind only (beat, flag, idea, plot hole). The landing page tells visitors this.

### Keeping stats with Supabase (free)

Render's free plan wipes the server's files whenever it restarts or sleeps, so without a database the stats reset. Supabase's free plan keeps them. Free Supabase projects pause after a week with no activity; the data is kept and you can resume the project from the Supabase dashboard.

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste this, and click **Run**:
   ```sql
   create table if not exists public.unstuck_events (
     id bigint generated always as identity primary key,
     ts timestamptz not null default now(),
     visitor text, session text, type text not null,
     page text, action text, label text,
     x real, y real, vw int, vh int,
     edition text, meta jsonb
   );
   create index if not exists unstuck_events_ts on public.unstuck_events (ts);
   -- Only the server (with the secret key) can read or write this table.
   alter table public.unstuck_events enable row level security;
   ```
3. In **Project Settings → API Keys**, copy a **secret key** (starts with `sb_secret_`). In **Project Settings → Data API** (or the project's Connect dialog), copy the **Project URL** (`https://….supabase.co`).
4. Add them to `.env` locally and to Render's environment variables:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   ```
5. Restart the server (or let Render redeploy). The server log says `Stats are saved to Supabase` when it's connected, and the admin page footer says "stored in Supabase".

Keep the secret key on the server only. It is never sent to the browser.

## How the AI works

- **✦ Scan with AI** (Story Map) reads the whole story: beats in order, character sheets, places and world rules. It marks plot holes between beats. Each one quotes the notes it is based on. A second AI pass double-checks every problem, and quotes that don't appear in the notes are thrown out.
- **✦ Ask AI for ideas / other fixes** (a node's Suggestions or Experiment tab) suggests beats that fit your characters and world, and says which notes each idea builds on.
- **✦ Find characters with AI** (Worldbuilding) lists characters mentioned in your notes that don't have a sheet yet.

The AI has no memory of its own, so the whole story is sent with every request. On Google's free tier, Google may use what you send to improve its products, so avoid pasting anything private.

## Backend endpoints

- `GET /api/health` returns `{ ok, ai, model }`. `ai` is true when a key is set.
- `POST /api/ai` with `{ system, prompt }` returns `{ text }`. It is rate-limited per visitor and accepts requests up to about 1.5 MB.
- `POST /api/track` receives anonymous page views and clicks from the app (up to 50 per request).
- `GET /admin`, `GET /api/admin/stats?days=1|7|30|0` and `GET /api/admin/export.csv` need the admin password.

Only the three app HTML files are public. `admin.html` is only served after logging in, and `server.js`, `.env` and `package.json` are never sent to the browser.

## Other features

- **Undo / redo:** Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y (⌘ on Mac), or the ↶ ↷ buttons. Press **?** for all shortcuts.
- **Phone and desktop views:** `index.html` opens the phone view only on phones. Use the link in the top bar to switch, or add `?view=desktop` or `?view=phone` to the address. `writer-phone.html` is the same file as `writer-desktop.html` except for `data-edition` on line 2.
