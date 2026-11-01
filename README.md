# watch-together-anything

A plain HTML frontend and small Node.js backend for a private two-person watch-together project.

## Run locally

From `D:\Multiplay`, start the backend and static page together:

```powershell
node --env-file=D:\Multiplay\.env D:\Multiplay\backend\server.js
```

Open <http://127.0.0.1:3000/>. Keep the terminal running. The sign-in form uses Supabase Auth and checks the session with `GET /api/me`.

The frontend loads `@supabase/supabase-js` from jsDelivr. Its Project URL and publishable key are included in `index.html`; publishable keys are meant for browser code. Never put a Supabase Secret key in HTML or commit `.env`.

`.gitignore` excludes environment files and `node_modules/`. Only accounts created in Supabase can sign in; the page does not offer public sign-up. Run `backend/schema.sql` in the Supabase SQL Editor to create the profile table and its row-level security policies. `GET /api/me` verifies the signed-in user, then reads or creates that user's profile using their access token. Profile editing and room APIs still need to be built. The same schema file also creates one private room and a membership table capped at two users. Add the two Supabase Auth user IDs to `watch_room_members` in the SQL Editor; the migration keeps personal IDs out of Git.




