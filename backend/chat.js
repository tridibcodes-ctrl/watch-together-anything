const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authenticate(request) {
  const { verifyAuth } = await import("@supabase/server/core");
  const headers = new Headers();
  if (request.headers.authorization) headers.set("authorization", request.headers.authorization);
  if (request.headers.apikey) headers.set("apikey", request.headers.apikey);
  return verifyAuth(new Request(new URL(request.url, "http://localhost:3000"), { headers }), { auth: "user" });
}

function createChatHandler({ authenticateUser = authenticate, fetchImpl = fetch } = {}) {
  return async function handleChat(request, response, sendJson) {
    const match = /^\/api\/rooms\/([^/]+)\/messages$/.exec(request.url);
    if (!match) return false;
    try {
      if (!["GET", "POST"].includes(request.method)) {
        sendJson(response, 405, { error: "Use GET or POST for room messages" });
        return true;
      }
      const roomId = match[1];
      if (!UUID.test(roomId)) {
        sendJson(response, 400, { error: "Invalid room ID" });
        return true;
      }
      const { data, error } = await authenticateUser(request);
      if (error) {
        sendJson(response, 401, { error: "Sign-in required or token invalid" });
        return true;
      }
      const userId = data.userClaims.id;
      const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "") + "/rest/v1";
      const headers = { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: request.headers.authorization };
      if (!process.env.SUPABASE_URL || !headers.apikey) throw new Error("Supabase configuration missing");
      const upstream = (path, options = {}) => fetchImpl(base + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(10000) });
      const membership = await upstream(`/watch_room_members?room_id=eq.${roomId}&user_id=eq.${userId}&select=user_id`);
      if (!membership.ok) throw new Error("Membership lookup failed");
      if (!(await membership.json()).length) {
        sendJson(response, 403, { error: "You are not a member of this room" });
        return true;
      }
      if (request.method === "GET") {
        const result = await upstream(`/watch_room_messages?room_id=eq.${roomId}&select=id,sender_id,sender_name,body,kind,created_at&order=created_at.desc,id.desc&limit=100`);
        if (!result.ok) throw new Error("Message lookup failed");
        const rows = await result.json();
        sendJson(response, 200, { items: rows.reverse().map(row => ({ id: row.id, senderId: row.sender_id, senderName: row.sender_name, body: row.body, kind: row.kind, sentAt: row.created_at })) });
        return true;
      }
      let raw = "";
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 16384) {
          sendJson(response, 413, { error: "Message request is too large" });
          return true;
        }
        raw += chunk;
      }
      let input;
      try { input = JSON.parse(raw); }
      catch { sendJson(response, 400, { error: "Request body must be valid JSON" }); return true; }
      const body = typeof input?.body === "string" ? input.body.trim() : "";
      if (!body || body.length > 2000 || !UUID.test(input?.clientMessageId || "")) {
        sendJson(response, 400, { error: "Enter a message of 1 to 2000 characters and a valid message ID" });
        return true;
      }
      const profileResult = await upstream(`/profiles?user_id=eq.${userId}&select=display_name`);
      if (!profileResult.ok) throw new Error("Sender profile lookup failed");
      const profiles = await profileResult.json();
      const senderName = profiles[0]?.display_name?.trim() || "Partner";
      const result = await upstream("/watch_room_messages?on_conflict=room_id,sender_id,client_message_id", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ room_id: roomId, sender_id: userId, sender_name: senderName, body, client_message_id: input.clientMessageId }),
      });
      if (!result.ok) throw new Error("Message insert failed");
      sendJson(response, 201, { sent: true });
    } catch (error) {
      console.error("Room chat failed:", error.message);
      sendJson(response, 502, { error: "Could not load or send messages. Check that the chat schema is installed." });
    }
    return true;
  };
}

module.exports = { createChatHandler, handleChat: createChatHandler() };
