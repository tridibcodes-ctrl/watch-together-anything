const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
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

  sendJson(response, 404, { error: "Not found" });
});

server.listen(3000, "127.0.0.1", () => {
  console.log("Backend running at http://127.0.0.1:3000");
});