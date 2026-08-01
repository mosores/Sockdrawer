# SockDrawer

SockDrawer is an Android-first, installable web app that keeps your links, notes, files, extracted text, and search index in Chrome storage on your phone. It retrieves relevant sources locally, then sends only the selected excerpts to the ChatGPT mobile app through Android's Share sheet.

No Docker, PostgreSQL, Android Studio, Google Play listing, Tailscale, AI API key, or always-on computer is required.

## What you need

- The public SockDrawer Sites URL produced by deployment.
- The existing Vercel project, used only by the protected public-link reader.
- Google Chrome on your Android phone.
- The ChatGPT Android app.
- Node.js on the computer used for the one-time deployment. It is already installed on this computer.

## Part 1: Keep the Vercel link reader

These commands do not control your browser or desktop. Vercel may show a login URL; open it yourself and approve the login.

1. Open PowerShell.
2. Go to this project:

       cd C:\Users\mosor\Documents\MemorIA

3. Install the project dependencies:

       npm.cmd install

4. Generate the private link-reader key and save it somewhere temporarily:

       node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

   Copy the complete result. You will enter this same value in Vercel and once on your phone. Do not publish it.

5. Sign in to Vercel. This temporarily downloads the Vercel command-line tool; no global installation is needed:

       npx.cmd vercel login

6. Create the Vercel project if it does not already exist:

       npx.cmd vercel

   Answer the prompts as follows:

   - Set up and deploy: Y
   - Scope: choose your Vercel account
   - Link to an existing project: N
   - Project name: sockdrawer
   - Directory: press Enter to use ./
   - Modify project settings: N

7. Add the production secret:

       npx.cmd vercel env add MEMORIA_ACCESS_KEY production

   Paste the key from step 4. If asked whether it is sensitive, answer Y.

8. Deploy the production reader:

       npx.cmd vercel --prod

9. Keep the final HTTPS address shown by Vercel. Sites uses it as the fixed
   `MEMORIA_EXTRACTOR_ORIGIN`; do not put the access key in Sites.

       https://sockdrawer-xxxx.vercel.app

After this deployment, the computer can be turned off. Vercel temporarily
extracts public webpage text and retains none of it. Sites serves the PWA.

## Part 2: Install SockDrawer on Android

1. Install or update Google Chrome and the ChatGPT app from Google Play.
2. Open Chrome on the phone.
3. Open the public SockDrawer Sites HTTPS address.
4. Wait until the Save screen is fully visible.
5. Tap Chrome's three-dot menu.
6. Tap **Install app**.
7. Tap **Install** in the confirmation dialog.
8. Open **SockDrawer** from the new home-screen icon.

If Chrome shows **Add to Home screen** instead of **Install app**, use it, open SockDrawer once from the icon, then return to Chrome and check the menu again.

## Part 3: Connect public-link extraction

Notes, local files, search, and backup work without this key. The key is required only when SockDrawer reads a public webpage.

1. Open SockDrawer.
2. Tap **Review**.
3. Under **Public link reader**, paste the same MEMORIA_ACCESS_KEY created in Part 1.
4. Tap **Save key**.
5. Tap **Protect storage**.

The key is stored in SockDrawer's IndexedDB on this phone. Sites forwards it only
to your fixed Vercel `/api/extract` endpoint.

## Moving from an older Vercel installation

Browser storage belongs to the exact site address. If an older Vercel-installed
SockDrawer already contains material:

1. Open the old installed app and export a complete backup from **Review**.
2. Install SockDrawer from the new Sites URL.
3. Import the backup into the new installation.
4. Confirm the saved count and test Recall before removing the old installation.

## Part 4: Verify the app

### Save a note

1. Tap **Save**.
2. Enter a short note.
3. Optionally enter a label that you will remember.
4. Tap **Save material**.
5. Confirm the sock moves into its drawer and the message says it was saved safely on this phone.

### Save a link from Android

1. Open a public webpage in Chrome.
2. Tap Chrome's Share button.
3. Choose **SockDrawer**.
4. SockDrawer opens with the link filled in.
5. Tap **Save material**.
6. Reopen **Library** and confirm the label, extracted summary, and source appear.

### Save a file or PDF

1. Open SockDrawer and tap **Save**.
2. Tap **Add material**.
3. Choose a TXT, Markdown, CSV, PDF, image, or other file up to 25 MB.
4. Text documents and normal selectable-text PDFs become searchable locally. Images and unsupported files remain safely stored and can be opened later; OCR is not included.

Directly sharing a file into SockDrawer from another Android app is not supported yet. Use **Add material**.

### Ask ChatGPT

1. Tap **Recall**.
2. Enter a question and tap the send button.
3. SockDrawer retrieves up to six matching sources on the phone and prepares a citation-ready prompt.
4. Choose **ChatGPT** in Android's Share sheet.
5. If Android sharing is unavailable, SockDrawer copies the prompt; open ChatGPT and paste it.

Only the question and selected excerpts are shared. The full library and local index remain on the phone.

## Back up and restore

Chrome site data can be deleted if you uninstall the PWA, clear Chrome storage, reset the phone, or use Android storage cleanup. Export backups regularly.

To back up:

1. Open **Review**.
2. Tap **Export backup**.
3. Move the downloaded sockdrawer-backup-YYYY-MM-DD.json file to a safe location such as Google Drive, another device, or encrypted storage.

The backup contains metadata, chunks, canonical TXT archives, and original files. Treat it as private.

To restore on an empty SockDrawer:

1. Open **Review**.
2. Tap **Import backup**.
3. Select the backup JSON file.
4. Confirm the recovered item count.

If the phone already has overlapping items, SockDrawer rejects the import to avoid silent overwrites. Export anything important, tap **Clear library**, then import.

## Offline behavior

- Notes and files save without an internet connection after the app has loaded once.
- Search and retrieval are local and work offline.
- Public webpage extraction waits for a connection and resumes when SockDrawer is reopened or the phone reconnects.
- ChatGPT sharing opens the mobile app, which normally needs its own internet connection.

## Update the deployed app

The Sites deployment is published through the Sites workflow. The Vercel reader
can still be updated with:

    cd C:\Users\mosor\Documents\MemorIA
    npx.cmd vercel --prod

Open the Sites-installed SockDrawer online once after deployment so its service
worker can cache the new version.

## Troubleshooting

- **SockDrawer is missing from Android Share:** confirm it was installed from Chrome, open the installed app once, then retry. If needed, uninstall the icon and install it again from the HTTPS page.
- **A link says the key was rejected:** enter the exact same value in Vercel's production MEMORIA_ACCESS_KEY and SockDrawer's Review screen, then tap **Try again** on the saved link.
- **A link remains pending:** reconnect to the internet, open SockDrawer, and tap the refresh button or **Try again**.
- **A PDF is not searchable:** it is probably an image-only scan. SockDrawer stores it, but OCR is out of scope.
- **Storage is not protected:** keep regular backups. Chrome decides whether persistent storage is granted.
- **Import says items overlap:** use an empty library or restore a different backup.
- **You cleared Chrome site data:** restore from the most recent exported backup.

## Developer verification

Run before deploying:

    npm.cmd run typecheck
    npm.cmd run test
    npm.cmd run lint
    npm.cmd run build
    npm.cmd run sites:build

## Privacy boundary

- IndexedDB stores memory records, chunks, settings, and vectors.
- Origin Private File System stores sockdrawer/YYYY/MM/<id>.txt archives and original files.
- /api/extract validates the access key, blocks private-network targets and unsafe redirects, limits response size, returns cleaned public webpage text, sets no-store, and retains nothing.
- ChatGPT receives content only when you deliberately use **Ask ChatGPT** or **Share**.
