console.log("Script loading...");
import { Session, ready as sessionReady } from "@session.js/client";
import { generateSeedHex } from "@session.js/keypair";
import { encode as encodeMnemonic } from "@session.js/mnemonic";
import sodium from "libsodium-wrappers";
import WebSocket from "ws";
import { Database } from "bun:sqlite";
import path from "path";

const PORT = 3000;
const AAD_PREFIX = "ephemeral-e2ee-v1|";
const DB_PATH = path.join(import.meta.dir, "data", "bot_sessions.db");

// Initialize Database
const db = new Database(DB_PATH, { create: true });
db.run(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
        roomToken TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        senderPublicKey TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

async function run() {
    console.log("Run started");
    await sessionReady;
    console.log("Session ready");
    await sodium.ready;
    console.log("Sodium ready");

    // Restore sessions
    const activeSessions = db.query("SELECT * FROM bot_sessions").all() as any[];
    console.log(`Restoring ${activeSessions.length} sessions...`);
    for (const row of activeSessions) {
        startForwarder(row.roomToken, row.sessionId, row.senderPublicKey);
    }

    console.log("Bot service starting on port");

    Bun.serve({
        port: PORT,
        hostname: "0.0.0.0",
        async fetch(req) {
            if (req.method === "POST" && new URL(req.url).pathname === "/forward") {
                console.log("POST /forward received");
                try {
                    const body: any = await req.json();
                    const { roomToken, sessionId, senderPublicKey } = body;

                    if (!roomToken || !sessionId) {
                        console.log("Validation failed: missing fields");
                        return new Response(JSON.stringify({ error: "Missing roomToken or sessionId" }), {
                            status: 400,
                            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                        });
                    }

                    // Store in DB
                    db.run(
                        "INSERT OR REPLACE INTO bot_sessions (roomToken, sessionId, senderPublicKey) VALUES (?, ?, ?)",
                        [roomToken, sessionId, senderPublicKey]
                    );

                    console.log("Calling startForwarder");
                    startForwarder(roomToken, sessionId, senderPublicKey);

                    return new Response(JSON.stringify({ status: "Forwarding initiated and persisted" }), {
                        headers: {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*",
                        },
                    });
                } catch (err: any) {
                    return new Response(JSON.stringify({ error: err.message }), {
                        status: 500,
                        headers: { "Content-Type": "application/json" },
                    });
                }
            }

            if (req.method === "GET" && new URL(req.url).pathname === "/status") {
                const url = new URL(req.url);
                const roomToken = url.searchParams.get("roomToken");
                if (!roomToken) {
                    return new Response(JSON.stringify({ error: "Missing roomToken" }), {
                        status: 400,
                        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                    });
                }

                const result = db.query("SELECT sessionId FROM bot_sessions WHERE roomToken = ?").get(roomToken) as any;
                return new Response(JSON.stringify({ sessionId: result?.sessionId || null }), {
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    },
                });
            }

            // Handle CORS for browser requests
            if (req.method === "OPTIONS") {
                return new Response(null, {
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "POST, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                    },
                });
            }

            return new Response("Not Found", { status: 404 });
        },
    });
}

const activeForwards = new Set<string>();

function startForwarder(roomToken: string, sessionId: string, senderPublicKey?: string) {
    if (activeForwards.has(roomToken)) {
        console.log(`[${roomToken}] Already active, skipping.`);
        return;
    }
    activeForwards.add(roomToken);

    console.log(`[${roomToken}] Starting forwarder to ${sessionId}`);

    // 1. Initialize Session
    const session = new Session();
    const mnemonic = encodeMnemonic(generateSeedHex());
    session.setMnemonic(mnemonic);

    // 2. Derive room key (must match app.js)
    const roomHash = sodium.crypto_generichash(32, roomToken, null);

    const context = "ephemeral-room-v1".padEnd(8, "\0").slice(0, 8);
    const msgKey = sodium.crypto_kdf_derive_from_key(32, 1, context, roomHash);
    sodium.memzero(roomHash);

    // 3. Connect to Ephemeral WebSocket
    const serverUrl = process.env.SERVER_URL || "http://127.0.0.1:4000";
    const wsBaseUrl = serverUrl.replace(/^http/, "ws");
    const wsUrl = `${wsBaseUrl}/ws/${roomToken}`;

    let ws: WebSocket;
    let isReconnecting = false;
    let retryCount = 0;

    const connect = () => {
        console.log(`[${roomToken}] Connecting to room (attempt ${retryCount + 1})...`);
        ws = new WebSocket(wsUrl);

        ws.on("open", () => {
            console.log(`[${roomToken}] Connected to room`);
            ws.send(JSON.stringify({ t: "READY", d: { v: 1, lastSeenSeq: 0 } }));
            retryCount = 0;
            isReconnecting = false;
        });

        ws.on("message", async (data: any) => {
            try {
                const stringData = data.toString();
                const envelope = JSON.parse(stringData);
                if (envelope.t === "MSG") {
                    console.log(`Decrypting message...`);
                    const payload = envelope.d;
                    const nonce = sodium.from_base64(payload.n || payload.nonce);
                    const ciphertext = sodium.from_base64(payload.c || payload.ciphertext);
                    const aad = sodium.from_string(AAD_PREFIX + roomToken);

                    try {
                        const plaintextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                            null,
                            ciphertext,
                            aad,
                            nonce,
                            msgKey
                        );
                        const plaintext = sodium.to_string(plaintextBytes);
                        const decryptedPayload = JSON.parse(plaintext);

                        if (decryptedPayload.text) {
                            const senderPub = decryptedPayload.signature?.publicKey;
                            if (senderPublicKey && senderPub === senderPublicKey) {
                                console.log(`Skipping self-sent message`);
                            } else {
                                console.log(`Forwarding message: ${decryptedPayload.text.substring(0, 20)}...`);
                                await session.sendMessage({
                                    to: sessionId,
                                    text: `[Ephemeral] ${decryptedPayload.text}`,
                                });
                                console.log(`Message forwarded successfully`);
                            }
                        }
                    } catch (e: any) {
                        console.log(`Decryption failed:`, e.message);
                    }
                }
            } catch (err) {
                console.error(`Process error`, err);
            }
        });

        ws.on("error", (err: any) => {
            console.error(`WebSocket error`, err);
        });

        ws.on("close", async (code, reason) => {
            console.log(`WebSocket closed (code: ${code}, reason: ${reason})`);

            // Check if room still exists
            try {
                const resp = await fetch(`${serverUrl}/room/${roomToken}`);
                if (resp.status === 404) {
                    console.log(`Room expired or deleted. Cleaning up.`);
                    db.run("DELETE FROM bot_sessions WHERE roomToken = ?", [roomToken]);
                    activeForwards.delete(roomToken);
                    return;
                }
            } catch (err) {
                console.error(`[${roomToken}] Failed to check room status`, err);
            }

            // Retry if not gone
            if (!isReconnecting && retryCount < 10) {
                isReconnecting = true;
                retryCount++;
                const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
                console.log(`[${roomToken}] Retrying in ${delay}ms...`);
                setTimeout(connect, delay);
            } else {
                console.log(`[${roomToken}] Giving up on reconnection or max retries reached.`);
                activeForwards.delete(roomToken);
            }
        });
    };

    connect();
}

run().catch(console.error);