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

      sendJson(response, 200, {
        userId: data.userClaims.id,
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