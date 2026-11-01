const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { handleChat } = require("./chat");
const { handleTmdb } = require("./tmdb");
const { handleWatchlist } = require("./watchlist");
const { handlePlayback } = require("./playback");

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  if (await handleTmdb(request, response, sendJson)) return;
  if (await handleChat(request, response, sendJson)) return;
  if (await handleWatchlist(request, response, sendJson)) return;
  if (await handlePlayback(request, response, sendJson)) return;
  if (request.method === "GET" && request.url === "/player.js") {
    fs.readFile(path.join(__dirname, "..", "player.js"), (error, script) => {
      if (error) { sendJson(response, 500, { error: "Could not load player integration" }); return; }
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      response.end(script);
    });
    return;
  }
  if (request.method === "GET" && request.url === "/") {
    fs.readFile(path.join(__dirname, "..", "index.html"), (error, html) => {
      if (error) {
        sendJson(response, 500, { error: "Could not load the frontend" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(html);
    });
    return;
  }
  if (request.method === "GET" && request.url === "/api/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && request.url === "/api/me") {
    try {
      const { verifyAuth } = await import("@supabase/server/core");
      const headers = new Headers();

      if (request.headers.authorization) {
        headers.set("authorization", request.headers.authorization);
      }
      if (request.headers.apikey) {
        headers.set("apikey", request.headers.apikey);
      }

      const authRequest = new Request(
        new URL(request.url, "http://localhost:3000"),
        { headers }
      );

      const { data, error } = await verifyAuth(authRequest, {
        auth: "user",
      });

      if (error) {
        sendJson(response, error.status || 401, {
          error: "Sign-in required or token invalid",
        });
        return;
      }

      const userId = data.userClaims.id;
      const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
      const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
      const authorization = request.headers.authorization;

      if (!supabaseUrl || !publishableKey || !authorization) {
        sendJson(response, 500, { error: "Supabase profile configuration is incomplete" });
        return;
      }

      const profileUrl = `${supabaseUrl}/rest/v1/profiles`;
      const profileHeaders = {
        apikey: publishableKey,
        Authorization: authorization,
      };
      const selectUrl = `${profileUrl}?user_id=eq.${encodeURIComponent(userId)}&select=user_id,display_name,avatar_key`;
      let profileResponse = await fetch(selectUrl, { headers: profileHeaders });

      if (!profileResponse.ok) {
        console.error("Profile lookup failed with HTTP", profileResponse.status);
        sendJson(response, 502, { error: "Could not load profile from Supabase" });
        return;
      }

      let profiles = await profileResponse.json();
      let profile = profiles[0];

      if (!profile) {
        profileResponse = await fetch(profileUrl, {
          method: "POST",
          headers: {
            ...profileHeaders,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify({ user_id: userId }),
        });

        if (profileResponse.ok) {
          profiles = await profileResponse.json();
          profile = profiles[0];
        } else if (profileResponse.status === 409) {
          profileResponse = await fetch(selectUrl, { headers: profileHeaders });
          if (profileResponse.ok) {
            profiles = await profileResponse.json();
            profile = profiles[0];
          }
        }
      }

      if (!profile) {
        console.error("Profile creation or lookup failed");
        sendJson(response, 502, { error: "Could not create or load profile" });
        return;
      }

      sendJson(response, 200, {
        userId,
        profile: {
          displayName: profile.display_name,
          avatarKey: profile.avatar_key,
        },
        groupId: null,
        roomId: null,
      });
    } catch (error) {
      console.error("Auth check failed:", error.message);
      sendJson(response, 500, { error: "Authentication check failed" });
    }
    return;
  }

  if (request.method === "PATCH" && request.url === "/api/me/profile") {
    try {
      const { verifyAuth } = await import("@supabase/server/core");
      const authHeaders = new Headers();
      if (request.headers.authorization) authHeaders.set("authorization", request.headers.authorization);
      if (request.headers.apikey) authHeaders.set("apikey", request.headers.apikey);
      const authRequest = new Request(new URL(request.url, "http://localhost:3000"), { headers: authHeaders });
      const { data, error } = await verifyAuth(authRequest, { auth: "user" });

      if (error) {
        sendJson(response, error.status || 401, { error: "Sign-in required or token invalid" });
        return;
      }

      let rawBody = "";
      for await (const chunk of request) {
        rawBody += chunk;
        if (rawBody.length > 4096) {
          sendJson(response, 413, { error: "Request body is too large" });
          return;
        }
      }

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        sendJson(response, 400, { error: "Request body must be valid JSON" });
        return;
      }

      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      const avatarKey = body.avatarKey;
      if (!displayName || displayName.length > 40) {
        sendJson(response, 400, { error: "Display name must be between 1 and 40 characters" });
        return;
      }
      if (!new Set(["moon", "sun", "star", "heart"]).has(avatarKey)) {
        sendJson(response, 400, { error: "Choose one of the available avatars" });
        return;
      }

      const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
      const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
      if (!supabaseUrl || !publishableKey) {
        sendJson(response, 500, { error: "Supabase profile configuration is incomplete" });
        return;
      }

      const updateUrl = `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(data.userClaims.id)}&select=user_id,display_name,avatar_key`;
      const profileResponse = await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          apikey: publishableKey,
          Authorization: request.headers.authorization,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ display_name: displayName, avatar_key: avatarKey, updated_at: new Date().toISOString() }),
      });

      if (!profileResponse.ok) {
        console.error("Profile update failed with HTTP", profileResponse.status);
        sendJson(response, 502, { error: "Could not save profile to Supabase" });
        return;
      }

      const profiles = await profileResponse.json();
      if (!profiles[0]) {
        sendJson(response, 404, { error: "Profile not found; connect first to create it" });
        return;
      }
      sendJson(response, 200, { profile: { displayName: profiles[0].display_name, avatarKey: profiles[0].avatar_key } });
    } catch (error) {
      console.error("Profile update failed:", error.message);
      sendJson(response, 500, { error: "Profile update failed" });
    }
    return;
  }
  if (request.method === "GET" && request.url === "/api/rooms") {
    try {
      const { verifyAuth } = await import("@supabase/server/core");
      const authHeaders = new Headers();
      if (request.headers.authorization) authHeaders.set("authorization", request.headers.authorization);
      if (request.headers.apikey) authHeaders.set("apikey", request.headers.apikey);
      const authRequest = new Request(new URL(request.url, "http://localhost:3000"), { headers: authHeaders });
      const { error } = await verifyAuth(authRequest, { auth: "user" });
      if (error) {
        sendJson(response, error.status || 401, { error: "Sign-in required or token invalid" });
        return;
      }
      const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
      const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
      if (!supabaseUrl || !publishableKey) {
        sendJson(response, 500, { error: "Supabase configuration is incomplete" });
        return;
      }
      const roomsResponse = await fetch(`${supabaseUrl}/rest/v1/watch_rooms?select=id,name,invite_code,created_at&order=created_at.desc`, {
        headers: { apikey: publishableKey, Authorization: request.headers.authorization },
      });
      const rooms = await roomsResponse.json().catch(() => ({}));
      if (!roomsResponse.ok) {
        console.error("Room list failed with HTTP", roomsResponse.status);
        sendJson(response, 502, { error: "Could not load your rooms" });
        return;
      }
      sendJson(response, 200, { items: rooms.map((room) => ({ roomId: room.id, name: room.name, inviteCode: room.invite_code })) });
    } catch (error) {
      console.error("Room list failed:", error.message);
      sendJson(response, 500, { error: "Could not load your rooms" });
    }
    return;
  }
  if (request.method === "POST" && ["/api/rooms", "/api/rooms/join"].includes(request.url)) {
    try {
      const { verifyAuth } = await import("@supabase/server/core");
      const authHeaders = new Headers();
      if (request.headers.authorization) authHeaders.set("authorization", request.headers.authorization);
      if (request.headers.apikey) authHeaders.set("apikey", request.headers.apikey);
      const authRequest = new Request(new URL(request.url, "http://localhost:3000"), { headers: authHeaders });
      const { data: authData, error: authError } = await verifyAuth(authRequest, { auth: "user" });
      if (authError) {
        sendJson(response, authError.status || 401, { error: "Sign-in required or token invalid" });
        return;
      }

      let rawBody = "";
      for await (const chunk of request) {
        rawBody += chunk;
        if (rawBody.length > 4096) {
          sendJson(response, 413, { error: "Request body is too large" });
          return;
        }
      }
      let body;
      try { body = rawBody ? JSON.parse(rawBody) : {}; }
      catch { sendJson(response, 400, { error: "Request body must be valid JSON" }); return; }

      const isJoin = request.url === "/api/rooms/join";
      const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
      const roomName = typeof body.name === "string" ? body.name.trim() : "Our room";
      if (isJoin && (!inviteCode || inviteCode.length > 32)) {
        sendJson(response, 400, { error: "Enter a valid invite code" });
        return;
      }
      if (!isJoin && (!roomName || roomName.length > 60)) {
        sendJson(response, 400, { error: "Room name must be between 1 and 60 characters" });
        return;
      }

      const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
      const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
      if (!supabaseUrl || !publishableKey) {
        sendJson(response, 500, { error: "Supabase configuration is incomplete" });
        return;
      }
      const rpcName = isJoin ? "join_watch_room" : "create_watch_room";
      const rpcArgs = isJoin ? { p_invite_code: inviteCode } : { p_name: roomName };
      const rpcResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
        method: "POST",
        headers: {
          apikey: publishableKey,
          Authorization: request.headers.authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(rpcArgs),
      });
      const result = await rpcResponse.json().catch(() => ({}));
      if (!rpcResponse.ok) {
        const status = rpcResponse.status >= 500 ? 409 : rpcResponse.status;
        sendJson(response, status, { error: result.message || "Room operation failed" });
        return;
      }
      sendJson(response, isJoin ? 200 : 201, { ...result, createdBy: authData.userClaims.id });
    } catch (error) {
      console.error("Room operation failed:", error.message);
      sendJson(response, 500, { error: "Room operation failed" });
    }
    return;
  }
  sendJson(response, 404, { error: "Not found" });
});

server.listen(3000, "127.0.0.1", () => {
  console.log("Backend running at http://127.0.0.1:3000");
});
