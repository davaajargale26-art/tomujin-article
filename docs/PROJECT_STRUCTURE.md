# Project Structure

This project keeps the running app paths stable while separating local helpers and generated files from the app code.

```text
backend/                  Node/Express API, auth, database, uploads, and local fallback data
frontend/public/          Static public site and admin UI served by the backend and Firebase Hosting
frontend/public/images/   Public image assets
functions/                Firebase Functions package
tools/                    Local developer helper scripts
logs/                     Local runtime logs and pid files
```

Important entry points:

```text
backend/index.js          Server, API routes, auth, MySQL setup, and static frontend serving
frontend/public/index.html
frontend/public/app.js    Browser app state, routing, rendering, and admin bindings
frontend/public/styles.css
firebase.json             Firebase Hosting and Functions paths
package.json              Root scripts for start/dev/build/assistant
```

Local commands:

```powershell
npm run build
npm start
npm run dev
npm run assistant -- --all
```
