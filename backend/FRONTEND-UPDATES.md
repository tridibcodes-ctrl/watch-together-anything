# Discovery and account setup

The frontend includes a last-watched poster, a three-second discovery carousel,
genre browsing, keyboard-accessible title suggestions, a live Kanban watchlist,
profile avatar icons, and email/password registration.

## Message retention

After the existing `schema.sql`, `playback.sql`, and `phase2.sql` migrations,
enable **pg_cron** under Supabase **Integrations → Cron**, then apply
`backend/message-retention.sql` in the Supabase SQL Editor as the database owner.
It can be reapplied safely. The migration hides expired messages immediately and
deletes them every minute, including when no clients are online. It also removes
existing messages older than 24 hours. Expiry does not delete playback history.

The chat API also filters messages to the last 24 hours, and an open chat removes
each expired message locally. Physical deletion requires the migration and a
working Cron job. Monitor `multiplay-message-retention` in Supabase Cron.

## New accounts

Enable new user signups and the Email provider in Supabase Authentication.
Configure the Site URL and allowed redirect URLs for the actual app origin,
including the local backend URL while developing. Email confirmations are
supported: a new user either enters the app with their returned session or sees
a prompt to confirm their email and sign in. Display name and avatar are saved
in signup metadata, then copied into the profile on first authenticated access.

Registration is available in the signed-out Profile view and the sign-in panel.
`#signup` opens the registration form directly. Supabase settings remain the
authority for whether new users can register.

TMDB genre metadata uses the existing server-side TMDB token. Suggestions search
both movies and TV series. Genre sections sort alphabetically; cards stay aligned
to the left. The carousel pauses on hover/focus, when its view is hidden, and by
default when reduced motion is requested. The watchlist updates after actions,
through room-scoped Realtime events, and through polling as a fallback. Its
columns reflect actual shared playback progress; completing a TV episode keeps
the series in Watching rather than marking the whole series Watched.

References: [Supabase signup](https://supabase.com/docs/reference/javascript/auth-signup),
[Supabase Cron](https://supabase.com/docs/guides/cron/quickstart), and
[TMDB genres](https://developer.themoviedb.org/reference/genre-movie-list).
