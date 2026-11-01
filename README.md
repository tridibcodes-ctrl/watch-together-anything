# watch-together-anything

A plain HTML frontend and small Node.js backend for a private watch-together project for couples.

## Run locally

From `D:\Multiplay`, start the backend and static page together:

```powershell
node --env-file=D:\Multiplay\.env D:\Multiplay\backend\server.js
```

Open <http://127.0.0.1:3000/>. Keep the terminal running. The sign-in form uses Supabase Auth and checks the session with `GET /api/me`.

The frontend loads `@supabase/supabase-js` from jsDelivr. Its Project URL and publishable key are included in `index.html`; publishable keys are meant for browser code. Never put a Supabase Secret key in HTML or commit `.env`.

`.gitignore` excludes environment files and `node_modules/`. Only accounts created in Supabase can sign in; the page does not offer public sign-up. Run `backend/schema.sql` in the Supabase SQL Editor to create the profile table and its row-level security policies. `GET /api/me` verifies the signed-in user, then reads or creates that user's profile using their access token. Profile editing and room APIs still need to be built. The schema supports multiple rooms, with a two-member cap per room. Room creation and invitations will add members dynamically; no specific user IDs belong in the shared schema.






## Room text chat

Run the latest `backend/schema.sql` in Supabase SQL Editor, then restart Node. In Backend API mode, connect and select a room. The existing chat form sends messages; selecting a room loads the latest 100 messages in chronological order. Supabase Realtime listens for new inserts in that room and reloads messages automatically. Refresh chat is available if the live connection drops. Chat requires membership in the selected room, independently of playback presence. Messages persist in Supabase and are plain text. Older-message pagination is not implemented yet. Rerun the updated schema to add the message table to the supabase_realtime publication. Room switches and sign-out remove the previous live subscription.

- `GET /api/rooms/{roomId}/messages` returns `{items:[{id,senderId,senderName,body,sentAt}]}`.
- `POST /api/rooms/{roomId}/messages` accepts `{clientMessageId,body}`. The backend derives sender identity and name. Retrying the same message ID does not create a duplicate.
