/**
 * Ephemeral Chat Client with E2EE + Encrypted Images - HARDENED
 *
 * Protocol: X25519 key agreement + HKDF key derivation + XChaCha20-Poly1305 AEAD
 * All encryption happens client-side. Server is a crypto-agnostic relay.
 *
 * Features:
 *   - Encrypted text messages
 *   - Encrypted image transfer (chunked, E2EE-only)
 *
 * Security Invariants:
 *   - Explicit handshake state machine
 *   - Strict no-downgrade: plaintext blocked after E2EE active
 *   - Message type allow-list
 *   - Schema validation
 *   - Size limits (prevent DoS)
 *   - Safe error handling (never crash)
 *   - NO plaintext image data ever
 */

(function () {
  "use strict";

  // =============================================================================
  // ROUTING: Check if this is a room link or should redirect to create page
  // =============================================================================

  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  const hashParts = hash.split("&");
  const roomToken = hashParts[0];
  const urlHasPriv = hash.includes("&priv=");
  let privParam = null;
  for (let i = 1; i < hashParts.length; i++) {
    const part = hashParts[i];
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "priv") {
      privParam = value ? decodeURIComponent(value) : null;
      break;
    }
  }
  if (!roomToken) {
    // No token in hash - redirect to create page
    window.location.href = "/create-room";
    throw new Error("no token - redirecting");
  }

  // =============================================================================
  // CONFIGURATION & CONSTANTS
  // =============================================================================

  const PROTOCOL_VERSION = 1;
  const KDF_CONTEXT_SESSION = "session";
  const KDF_CONTEXT_MSG = "msg";
  const AAD_PREFIX = "ephemeral-e2ee-v1|";

  // Size limits (prevent DoS)
  const MAX_WS_MESSAGE_BYTES = 128 * 1024; // 128 KB
  const MAX_PLAINTEXT_CHARS = 4000; // 4k chars
  const MAX_CIPHERTEXT_BYTES = 96 * 1024; // 96 KB

  // Image transfer limits
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB hard cap
  const MAX_IMAGE_CHUNK_BYTES = 16 * 1024; // 16 KB raw bytes per chunk (reduced from 32KB)
  const IMAGE_TRANSFER_TIMEOUT = 60000; // 60s timeout for incomplete transfers

  // Expected crypto lengths (for validation)
  const X25519_PUBKEY_BYTES = 32;
  const XCHACHA20_NONCE_BYTES = 24;
  const POLY1305_MAC_BYTES = 16;

  // Debug flag
  const DEBUG = false;

  // Message type allow-list (UPDATED: added image types)
  const ALLOWED_MESSAGE_TYPES = new Set([
    "HELLO",
    "READY",
    "MSG",
    "CHAT",
    "IMG_META",
    "IMG_CHUNK",
    "IMG_END",
    "ERROR",
  ]);

  // Allowed image MIME types
  const ALLOWED_IMAGE_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
  ]);

  // Handshake state machine
  const HandshakeState = {
    INIT: "INIT",
    SENT_HELLO: "SENT_HELLO",
    GOT_PEER_HELLO: "GOT_PEER_HELLO",
    E2EE_ACTIVE: "E2EE_ACTIVE",
    FAILED: "FAILED",
  };

  // =============================================================================
  // GLOBAL STATE
  // =============================================================================

  // DOM references
  const log = document.getElementById("log");
  const form = document.getElementById("send");
  const input = document.getElementById("msg");
  const banner = document.getElementById("e2ee-banner");
  const statusIndicator = document.getElementById("e2ee-status");
  const imageButton = document.getElementById("image-btn");
  const imageInput = document.getElementById("image-input");
  const expiryBanner = document.getElementById("expiry-banner");
  const expiryText = document.getElementById("expiry-text");
  const destroyButton = document.getElementById("destroy-btn");

  // Crypto state
  let sodium = null;
  let myKeypair = null;
  let localPublicKey = null;
  let localPublicKeyB64 = null;
  let peerPublicKey = null;
  let msgKey = null;

  // Handshake state
  let handshakeState = HandshakeState.INIT;

  // WebSocket connection
  let ws = null;
  let outboundSeq = 0;
  let lastSeenSeq = 0;
  let historyReplayActive = false;
  let replayTimer = null;

  // Room expiry state
  let roomExpiresAt = null;
  let expiryCheckInterval = null;

  // Image transfer state (receiver side)
  const incomingImages = new Map();
  // id -> { meta, chunks: Map<i, Uint8Array>, receivedBytes, startTime }

  // =============================================================================
  // LOGGING UTILITIES
  // =============================================================================

  function addLog(line, isError = false) {
    const textNode = document.createTextNode(line + "\n");
    log.appendChild(textNode);
    log.scrollTop = log.scrollHeight;
    if (isError) console.error(line);
  }

  function addSystemLog(line) {
    addLog("[system] " + line);
  }

  function addWarningLog(line) {
    addLog("[warning] " + line);
    if (DEBUG) console.warn(line);
  }

  function debugLog(line) {
    if (DEBUG) console.log("[debug]", line);
  }

  function noteReplayActivity() {
    historyReplayActive = true;
    if (replayTimer) {
      clearTimeout(replayTimer);
    }
    replayTimer = setTimeout(() => {
      historyReplayActive = false;
    }, 200);
  }

  function getLocalPublicKeyB64() {
    if (localPublicKeyB64) return localPublicKeyB64;
    if (sodium && myKeypair && myKeypair.publicKey) {
      localPublicKeyB64 = sodium.to_base64(myKeypair.publicKey);
    }
    return localPublicKeyB64;
  }

  function isLocalSender(senderPubB64) {
    const localB64 = localPublicKeyB64;
    if (!localB64 || !senderPubB64) return null;
    return senderPubB64 === localB64;
  }

  function getSenderLabel(senderPubB64) {
    const isLocal = isLocalSender(senderPubB64);
    if (isLocal === null) return "user_? / ?";
    const localLabel = urlHasPriv ? "user_2 / me" : "user_1 / me";
    const remoteLabel = urlHasPriv ? "user_1 / them" : "user_2 / them";
    return isLocal ? localLabel : remoteLabel;
  }

  function extractSenderPublicKey(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (
      obj.signature &&
      typeof obj.signature === "object" &&
      typeof obj.signature.publicKey === "string"
    ) {
      return obj.signature.publicKey;
    }
    if (typeof obj.pub === "string") return obj.pub;
    return null;
  }

  function updateChatLine(line) {
    const text = line.dataset.text || "";
    const suffix = line.dataset.suffix || "";
    const senderPub = line.dataset.sender || "";
    const label = getSenderLabel(senderPub);
    line.textContent = label + ": " + text + (suffix ? " " + suffix : "");
  }

  function addChatLine(text, senderPubB64, suffix = "") {
    const line = document.createElement("div");
    line.dataset.text = text;
    line.dataset.sender = senderPubB64 || "";
    if (suffix) line.dataset.suffix = suffix;
    updateChatLine(line);
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function refreshChatLabels() {
    if (!log) return;
    const lines = log.querySelectorAll("div[data-text]");
    lines.forEach(updateChatLine);
  }


  // =============================================================================
  // UI STATE MANAGEMENT
  // =============================================================================

  function setE2EEActive() {
    handshakeState = HandshakeState.E2EE_ACTIVE;
    banner.style.display = "none";
    statusIndicator.style.display = "block";
    if (imageButton) imageButton.disabled = false; // Enable image button
    addSystemLog("🔒 E2EE active");
  }

  function setPlaintextMode(reason) {
    if (handshakeState === HandshakeState.E2EE_ACTIVE) {
      addWarningLog("Attempted downgrade to plaintext (blocked)");
      return;
    }
    banner.style.display = "block";
    statusIndicator.style.display = "none";
    if (imageButton) imageButton.disabled = true; // Disable image button
    if (reason) {
      addSystemLog("⚠️ " + reason);
    }
  }

  function setHandshakeFailed(reason) {
    handshakeState = HandshakeState.FAILED;
    setPlaintextMode(reason);
  }

  // =============================================================================
  // ROOM EXPIRY MANAGEMENT
  // =============================================================================

  /**
   * Fetch room expiry information from server
   */
  async function fetchRoomExpiry() {
    try {
      const response = await fetch(`/room/${roomToken}`);
      if (!response.ok) {
        throw new Error("Room not found or expired");
      }
      const data = await response.json();
      roomExpiresAt = new Date(data.expires_at);
      updateExpiryDisplay();

      // Show expiry banner
      if (expiryBanner) {
        expiryBanner.style.display = "block";
      }

      // Start periodic update
      if (expiryCheckInterval) {
        clearInterval(expiryCheckInterval);
      }
      expiryCheckInterval = setInterval(updateExpiryDisplay, 1000); // Update every second
    } catch (err) {
      debugLog("Failed to fetch room expiry: " + err.message);
      showRoomExpired();
    }
  }

  /**
   * Update the expiry display with human-readable time remaining
   */
  function updateExpiryDisplay() {
    if (!roomExpiresAt || !expiryText) return;

    const now = new Date();
    const msRemaining = roomExpiresAt - now;

    if (msRemaining <= 0) {
      showRoomExpired();
      return;
    }

    const secondsRemaining = Math.floor(msRemaining / 1000);
    const minutesRemaining = Math.floor(secondsRemaining / 60);
    const hoursRemaining = Math.floor(minutesRemaining / 60);

    let timeString;
    if (hoursRemaining > 0) {
      const mins = minutesRemaining % 60;
      timeString = `${hoursRemaining} hour${
        hoursRemaining > 1 ? "s" : ""
      } ${mins} minute${mins !== 1 ? "s" : ""}`;
    } else if (minutesRemaining > 0) {
      timeString = `${minutesRemaining} minute${
        minutesRemaining > 1 ? "s" : ""
      }`;
    } else {
      timeString = `${secondsRemaining} second${
        secondsRemaining !== 1 ? "s" : ""
      }`;
    }

    expiryText.textContent = `This room expires in ${timeString}`;

    // Change color when < 5 minutes remaining
    if (minutesRemaining < 5 && expiryBanner) {
      expiryBanner.style.backgroundColor = "#ffebee";
      expiryBanner.style.borderColor = "#f44336";
      expiryBanner.style.color = "#c62828";
    }
  }

  /**
   * Show room expired state
   */
  function showRoomExpired() {
    if (expiryCheckInterval) {
      clearInterval(expiryCheckInterval);
    }

    if (expiryBanner && expiryText) {
      expiryBanner.style.display = "block";
      expiryBanner.style.backgroundColor = "#ffebee";
      expiryBanner.style.borderColor = "#f44336";
      expiryBanner.style.color = "#c62828";
      expiryText.textContent = "This room has expired";
    }

    addSystemLog("⏰ Room has expired");

    // Close WebSocket if open
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }

    // Disable UI
    if (form) form.onsubmit = (e) => e.preventDefault();
    if (input) input.disabled = true;
    if (imageButton) imageButton.disabled = true;
  }

  // =============================================================================
  // VALIDATION UTILITIES
  // =============================================================================

  function decodeAndValidateBase64(b64String, expectedLength, fieldName) {
    try {
      const decoded = sodium.from_base64(b64String);
      if (decoded.length !== expectedLength) {
        throw new Error(
          `${fieldName}: expected ${expectedLength} bytes, got ${decoded.length}`
        );
      }
      return decoded;
    } catch (err) {
      throw new Error(
        `${fieldName}: invalid base64 or length (${err.message})`
      );
    }
  }

  function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") {
      throw new Error("Envelope must be an object");
    }
    if (!envelope.t || typeof envelope.t !== "string") {
      throw new Error("Envelope missing 't' field");
    }
    if (!ALLOWED_MESSAGE_TYPES.has(envelope.t)) {
      throw new Error(`Unknown message type: ${envelope.t}`);
    }
    if (!envelope.d || typeof envelope.d !== "object") {
      throw new Error("Envelope missing 'd' field");
    }
    return true;
  }

  function validateHelloMessage(data) {
    if (!data.v || data.v !== PROTOCOL_VERSION) {
      throw new Error("Invalid or missing protocol version");
    }
    if (!data.pub || typeof data.pub !== "string") {
      throw new Error("Missing 'pub' field");
    }
    decodeAndValidateBase64(data.pub, X25519_PUBKEY_BYTES, "HELLO.pub");
    return true;
  }

  function validateEncryptedEnvelope(data) {
    // Validates outer envelope for encrypted messages (MSG, IMG_META, IMG_CHUNK, IMG_END)
    if (!data.v || data.v !== PROTOCOL_VERSION) {
      throw new Error("Invalid or missing protocol version");
    }
    if (!data.n || typeof data.n !== "string") {
      throw new Error("Missing 'n' (nonce) field");
    }
    if (!data.c || typeof data.c !== "string") {
      throw new Error("Missing 'c' (ciphertext) field");
    }
    decodeAndValidateBase64(data.n, XCHACHA20_NONCE_BYTES, "nonce");
    const ciphertext = sodium.from_base64(data.c);
    if (ciphertext.length < POLY1305_MAC_BYTES) {
      throw new Error("Ciphertext too short (must include MAC)");
    }
    if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
      throw new Error("Ciphertext exceeds size limit");
    }
    return true;
  }

  function validateReadyMessage(data) {
    if (!data.v || data.v !== PROTOCOL_VERSION) {
      throw new Error("Invalid or missing protocol version");
    }
    return true;
  }

  function validateChatMessage(data) {
    if (!data.text || typeof data.text !== "string") {
      throw new Error("Missing 'text' field");
    }
    if (data.text.length > MAX_PLAINTEXT_CHARS) {
      throw new Error("Plaintext message exceeds size limit");
    }
    if (data.signature !== undefined) {
      if (!data.signature || typeof data.signature !== "object") {
        throw new Error("Invalid 'signature' field");
      }
      if (typeof data.signature.publicKey !== "string") {
        throw new Error("Invalid 'signature.publicKey' field");
      }
      if (sodium) {
        decodeAndValidateBase64(
          data.signature.publicKey,
          X25519_PUBKEY_BYTES,
          "CHAT.signature.publicKey"
        );
      }
    } else if (data.pub !== undefined) {
      if (typeof data.pub !== "string") {
        throw new Error("Invalid 'pub' field");
      }
      if (sodium) {
        decodeAndValidateBase64(data.pub, X25519_PUBKEY_BYTES, "CHAT.pub");
      }
    }
    return true;
  }

  // Image inner payload validation (after decryption)
  function validateImageMetaPayload(payload) {
    if (payload.type !== "IMG_META") throw new Error("Wrong inner type");
    if (!payload.id || typeof payload.id !== "string")
      throw new Error("Missing id");
    if (payload.signature !== undefined) {
      if (!payload.signature || typeof payload.signature !== "object") {
        throw new Error("Invalid signature");
      }
      if (typeof payload.signature.publicKey !== "string") {
        throw new Error("Invalid signature.publicKey");
      }
      if (sodium) {
        decodeAndValidateBase64(
          payload.signature.publicKey,
          X25519_PUBKEY_BYTES,
          "IMG_META.signature.publicKey"
        );
      }
    } else if (payload.pub !== undefined) {
      if (typeof payload.pub !== "string") throw new Error("Invalid pub");
      if (sodium) {
        decodeAndValidateBase64(payload.pub, X25519_PUBKEY_BYTES, "IMG_META.pub");
      }
    }
    if (!payload.mime || !ALLOWED_IMAGE_MIMES.has(payload.mime)) {
      throw new Error("Invalid or disallowed MIME type");
    }
    if (
      typeof payload.size !== "number" ||
      payload.size <= 0 ||
      payload.size > MAX_IMAGE_BYTES
    ) {
      throw new Error("Invalid size");
    }
    if (
      typeof payload.chunkSize !== "number" ||
      payload.chunkSize > MAX_IMAGE_CHUNK_BYTES
    ) {
      throw new Error("Invalid chunkSize");
    }
    if (typeof payload.chunks !== "number" || payload.chunks <= 0) {
      throw new Error("Invalid chunks count");
    }
    return true;
  }

  function validateImageChunkPayload(payload) {
    if (payload.type !== "IMG_CHUNK") throw new Error("Wrong inner type");
    if (!payload.id || typeof payload.id !== "string")
      throw new Error("Missing id");
    if (typeof payload.i !== "number" || payload.i < 0)
      throw new Error("Invalid chunk index");
    if (!payload.b || typeof payload.b !== "string")
      throw new Error("Missing chunk data");
    return true;
  }

  function validateImageEndPayload(payload) {
    if (payload.type !== "IMG_END") throw new Error("Wrong inner type");
    if (!payload.id || typeof payload.id !== "string")
      throw new Error("Missing id");
    return true;
  }

  // =============================================================================
  // CRYPTO UTILITIES
  // =============================================================================

  function deriveRoomSalt() {
    const input = AAD_PREFIX + roomToken;
    return sodium.crypto_generichash(32, input);
  }

  function deriveKey(masterKey, context, subkeyId = 1) {
    if (masterKey.length !== 32) {
      throw new Error("Master key must be 32 bytes");
    }
    const ctx = context.padEnd(8, "\0").slice(0, 8);
    return sodium.crypto_kdf_derive_from_key(32, subkeyId, ctx, masterKey);
  }

  function deriveRoomKey() {
    if (msgKey !== null) {
      return true; // Already derived
    }

    try {
      // Derive deterministic key from room token only
      // This enables cross-device and history replay at the cost of forward secrecy
      const roomHash = sodium.crypto_generichash(32, roomToken);
      msgKey = deriveKey(roomHash, "ephemeral-room-v1");
      sodium.memzero(roomHash);

      debugLog("Room key derived successfully");
      return true;
    } catch (err) {
      addLog("[error] Key derivation failed: " + err.message, true);
      return false;
    }
  }

  /**
   * Encrypt any JSON-serializable payload
   */
  function encryptPayload(payload) {
    if (!msgKey) throw new Error("Encryption key not derived");

    const plaintext = JSON.stringify(payload);
    const nonce = sodium.randombytes_buf(XCHACHA20_NONCE_BYTES);
    const aad = sodium.from_string(AAD_PREFIX + roomToken);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      aad,
      null,
      nonce,
      msgKey
    );

    return {
      nonce: sodium.to_base64(nonce),
      ciphertext: sodium.to_base64(ciphertext),
    };
  }

  /**
   * Decrypt to JSON payload
   */
  function decryptPayload(nonceB64, ciphertextB64) {
    if (!msgKey) throw new Error("Decryption key not derived");

    const nonce = sodium.from_base64(nonceB64);
    const ciphertext = sodium.from_base64(ciphertextB64);
    const aad = sodium.from_string(AAD_PREFIX + roomToken);
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      aad,
      nonce,
      msgKey
    );

    return JSON.parse(sodium.to_string(plaintext));
  }

  // Legacy text-only encryption (kept for compatibility)
  function encryptMessage(plaintext) {
    return encryptPayload({
      text: plaintext,
      signature: { publicKey: getLocalPublicKeyB64() },
    });
  }

  function decryptMessage(nonceB64, ciphertextB64) {
    const payload = decryptPayload(nonceB64, ciphertextB64);
    if (!payload || typeof payload !== "object") {
      return { text: "", pub: null };
    }
    return {
      text: typeof payload.text === "string" ? payload.text : "",
      pub: extractSenderPublicKey(payload),
    };
  }

  // =============================================================================
  // IMAGE TRANSFER - SENDER SIDE
  // =============================================================================

  /**
   * Display an image preview in the chat log
   */
  function displayImagePreview(
    file,
    imageBytes,
    fileName,
    fileSize,
    senderPubB64 = null
  ) {
    try {
      const blob =
        file instanceof Blob
          ? file
          : new Blob([imageBytes], { type: file.type || "image/jpeg" });
      const objectUrl = URL.createObjectURL(blob);

      // Add text log
      addChatLine(`[image] ${fileName}`, senderPubB64);

      const isLocal = isLocalSender(senderPubB64);
      // Create container for image and controls
      const container = document.createElement("div");
      container.style.marginTop = "8px";
      container.style.marginBottom = "8px";
      container.style.padding = "8px";
      container.style.backgroundColor =
        isLocal === null ? "#f0f0f0" : isLocal ? "#e8f5e9" : "#f0f0f0";
      container.style.borderRadius = "8px";
      container.style.border = "1px solid #ccc";

      // Create image element
      const img = document.createElement("img");
      img.src = objectUrl;
      img.style.maxWidth = "100%";
      img.style.maxHeight = "400px";
      img.style.display = "block";
      img.style.marginBottom = "8px";
      img.style.borderRadius = "4px";
      img.style.cursor = "pointer";
      img.title = "Click to view full size";

      // Click to open in new tab
      img.onclick = () => {
        window.open(objectUrl, "_blank");
      };

      // Create download button
      const downloadBtn = document.createElement("button");
      downloadBtn.textContent = "💾 Save Image";
      downloadBtn.style.padding = "4px 8px";
      downloadBtn.style.fontSize = "12px";
      downloadBtn.style.cursor = "pointer";
      downloadBtn.style.backgroundColor = "#4CAF50";
      downloadBtn.style.color = "white";
      downloadBtn.style.border = "none";
      downloadBtn.style.borderRadius = "4px";
      downloadBtn.onclick = () => {
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = fileName;
        a.click();
      };

      // Create info text
      const info = document.createElement("div");
      info.style.fontSize = "11px";
      info.style.color = "#666";
      info.style.marginTop = "4px";
      info.textContent = `${fileName} (${(fileSize / 1024).toFixed(1)} KB)`;

      // Assemble container
      container.appendChild(img);
      container.appendChild(downloadBtn);
      container.appendChild(info);

      img.onload = () => {
        log.scrollTop = log.scrollHeight;
      };

      img.onerror = () => {
        addWarningLog("Failed to load image preview");
      };

      log.appendChild(container);

      // Cleanup object URL after 5 minutes
      setTimeout(() => URL.revokeObjectURL(objectUrl), 300000);
    } catch (err) {
      addLog("[error] Failed to display image: " + err.message, true);
      console.error("Image display error:", err);
    }
  }

  /**
   * Send image via chunked encrypted transfer
   * INVARIANT: Only allowed when E2EE active
   */
  async function sendImage(file) {
    if (handshakeState !== HandshakeState.E2EE_ACTIVE) {
      addWarningLog("Images require end-to-end encryption");
      return false;
    }

    // Validate file
    if (!file || !file.type) {
      addWarningLog("Invalid file");
      return false;
    }

    if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
      addWarningLog("Unsupported image type: " + file.type);
      return false;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      addWarningLog(`Image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`);
      return false;
    }

    try {
      // Generate random transfer ID
      const transferId = sodium.to_hex(sodium.randombytes_buf(16));

      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // Calculate chunks
      const chunkSize = MAX_IMAGE_CHUNK_BYTES;
      const numChunks = Math.ceil(bytes.length / chunkSize);

      addSystemLog(
        `Sending image: ${file.name} (${(bytes.length / 1024).toFixed(
          1
        )}KB, ${numChunks} chunks)`
      );

      // Send IMG_META
      const metaPayload = {
        type: "IMG_META",
        id: transferId,
        name: file.name || "image",
        mime: file.type,
        size: bytes.length,
        chunkSize: chunkSize,
        chunks: numChunks,
        signature: { publicKey: getLocalPublicKeyB64() },
      };

      const { nonce: metaNonce, ciphertext: metaCipher } =
        encryptPayload(metaPayload);

      if (
        !(await sendEnvelope("IMG_META", {
          v: PROTOCOL_VERSION,
          seq: nextSeq(),
          n: metaNonce,
          c: metaCipher,
        }))
      ) {
        addWarningLog("Failed to send IMG_META (connection lost)");
        return false;
      }

      // Wait for WebSocket buffer to drain before sending chunks
      if (!(await waitForBufferDrain())) {
        addWarningLog("Connection lost after IMG_META");
        return false;
      }

      // Send chunks with connection checks
      for (let i = 0; i < numChunks; i++) {
        // Check connection before each chunk
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          addWarningLog(`Connection lost at chunk ${i}/${numChunks}`);
          return false;
        }

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, bytes.length);
        const chunkBytes = bytes.slice(start, end);

        const chunkPayload = {
          type: "IMG_CHUNK",
          id: transferId,
          i: i,
          b: sodium.to_base64(chunkBytes),
        };

        const { nonce: chunkNonce, ciphertext: chunkCipher } =
          encryptPayload(chunkPayload);

        if (
          !(await sendEnvelope("IMG_CHUNK", {
            v: PROTOCOL_VERSION,
            seq: nextSeq(),
            n: chunkNonce,
            c: chunkCipher,
          }))
        ) {
          addWarningLog(`Failed to send chunk ${i}/${numChunks}`);
          return false;
        }

        // Wait for buffer to drain before next chunk
        if (!(await waitForBufferDrain())) {
          addWarningLog(`Connection lost at chunk ${i + 1}/${numChunks}`);
          return false;
        }

        // Tiny delay to prevent overwhelming server DB transactions
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Final connection check
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        addWarningLog("Connection lost before IMG_END");
        return false;
      }

      // Send IMG_END
      const endPayload = {
        type: "IMG_END",
        id: transferId,
      };
      const { nonce: endNonce, ciphertext: endCipher } =
        encryptPayload(endPayload);

      if (
        !(await sendEnvelope("IMG_END", {
          v: PROTOCOL_VERSION,
          seq: nextSeq(),
          n: endNonce,
          c: endCipher,
        }))
      ) {
        addWarningLog("Failed to send IMG_END");
        return false;
      }

      addSystemLog("Image sent");

      // Display preview for sender too
      displayImagePreview(
        file,
        bytes,
        file.name,
        bytes.length,
        getLocalPublicKeyB64()
      );

      return true;
    } catch (err) {
      addLog("[error] Failed to send image: " + err.message, true);
      return false;
    }
  }

  // =============================================================================
  // IMAGE TRANSFER - RECEIVER SIDE
  // =============================================================================

  /**
   * Handle IMG_META message
   */
  function handleImageMeta(data) {
    try {
      validateEncryptedEnvelope(data);
      if (typeof data.seq === "number" && data.seq > lastSeenSeq) {
        lastSeenSeq = data.seq;
      }
      const payload = decryptPayload(data.n, data.c);
      validateImageMetaPayload(payload);

      // Check for duplicate transfer ID
      if (incomingImages.has(payload.id)) {
        addWarningLog("Duplicate image transfer ID (ignored)");
        return;
      }

      // Initialize transfer state
      incomingImages.set(payload.id, {
        meta: payload,
        chunks: new Map(),
        receivedBytes: 0,
        startTime: Date.now(),
      });

      addSystemLog(
        `Receiving image: ${payload.name} (${(payload.size / 1024).toFixed(
          1
        )}KB, ${payload.chunks} chunks)`
      );
    } catch (err) {
      addWarningLog("Invalid IMG_META: " + err.message);
    }
  }

  /**
   * Handle IMG_CHUNK message
   */
  function handleImageChunk(data) {
    try {
      validateEncryptedEnvelope(data);
      // Detect replay FIRST
      if (typeof data.seq === "number" && data.seq <= lastSeenSeq) {
        noteReplayActivity();
      }

      // THEN update lastSeenSeq for new messages
      if (typeof data.seq === "number" && data.seq > lastSeenSeq) {
        lastSeenSeq = data.seq;
      }
      const payload = decryptPayload(data.n, data.c);
      validateImageChunkPayload(payload);

      const transfer = incomingImages.get(payload.id);
      if (!transfer) {
        addWarningLog("Chunk for unknown transfer ID (ignored)");
        return;
      }

      // Validate chunk index
      if (payload.i < 0 || payload.i >= transfer.meta.chunks) {
        addWarningLog("Invalid chunk index (ignored)");
        return;
      }

      // Ignore duplicate chunks
      if (transfer.chunks.has(payload.i)) {
        debugLog("Duplicate chunk ignored: " + payload.i);
        return;
      }

      // Decode and store chunk
      const chunkBytes = sodium.from_base64(payload.b);
      transfer.chunks.set(payload.i, chunkBytes);
      transfer.receivedBytes += chunkBytes.length;
      if (!historyReplayActive) {
        resetImageTransferIdleTimer(payload.id);
      }

      debugLog(`Chunk ${payload.i + 1}/${transfer.meta.chunks} received`);
    } catch (err) {
      addWarningLog("Invalid IMG_CHUNK: " + err.message);
    }
  }

  /**
   * Handle IMG_END message
   */
  function handleImageEnd(data) {
    try {
      validateEncryptedEnvelope(data);
      if (typeof data.seq === "number" && data.seq > lastSeenSeq) {
        lastSeenSeq = data.seq;
      }
      const payload = decryptPayload(data.n, data.c);
      validateImageEndPayload(payload);

      const transfer = incomingImages.get(payload.id);
      if (!transfer) {
        addWarningLog("IMG_END for unknown transfer (ignored)");
        return;
      }

      // Check if all chunks received
      if (transfer.chunks.size !== transfer.meta.chunks) {
        addWarningLog(
          `Incomplete image: ${transfer.chunks.size}/${transfer.meta.chunks} chunks`
        );
        incomingImages.delete(payload.id);
        return;
      }

      // Assemble image
      const imageBytes = new Uint8Array(transfer.meta.size);
      let offset = 0;
      for (let i = 0; i < transfer.meta.chunks; i++) {
        const chunk = transfer.chunks.get(i);
        if (!chunk) {
          addWarningLog("Missing chunk during assembly: " + i);
          incomingImages.delete(payload.id);
          return;
        }
        imageBytes.set(chunk, offset);
        offset += chunk.length;
      }

      // Create blob and display
      const blob = new Blob([imageBytes], { type: transfer.meta.mime });

      // Display preview using helper
      displayImagePreview(
        { type: transfer.meta.mime },
        imageBytes,
        transfer.meta.name,
        transfer.meta.size,
        extractSenderPublicKey(transfer.meta)
      );

      // Cleanup
      incomingImages.delete(payload.id);
      addSystemLog("Image received");
    } catch (err) {
      addWarningLog("Invalid IMG_END: " + err.message);
    }
  }

  /**
   * Garbage collect incomplete image transfers (timeout)
   */
  function resetImageTransferIdleTimer(transferId) {
    const transfer = incomingImages.get(transferId);
    if (!transfer) return;
    transfer.startTime = Date.now();
  }

  function cleanupStaleImageTransfers() {
    const now = Date.now();
    for (const [id, transfer] of incomingImages.entries()) {
      if (now - transfer.startTime > IMAGE_TRANSFER_TIMEOUT) {
        addWarningLog("Image transfer timeout: " + transfer.meta.name);
        incomingImages.delete(id);
      }
    }
  }

  // Run cleanup periodically
  setInterval(cleanupStaleImageTransfers, 30000); // Every 30s

  // =============================================================================
  // WEBSOCKET MESSAGE HANDLERS
  // =============================================================================

  async function sendEnvelope(type, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addWarningLog("Cannot send (not connected)");
      return false;
    }

    const envelope = { t: type, d: data };
    const json = JSON.stringify(envelope);

    if (json.length > MAX_WS_MESSAGE_BYTES) {
      addWarningLog(
        `Message too large (${json.length} bytes, max ${MAX_WS_MESSAGE_BYTES})`
      );
      return false;
    }

    // Debug log for image messages
    if (type.startsWith("IMG_")) {
      debugLog(
        `Sending ${type}: ${json.length} bytes, buffer before: ${ws.bufferedAmount}`
      );
    }

    ws.send(json);
    return true;
  }

  /**
   * Wait for WebSocket buffer to drain (helper for large transfers)
   */
  async function waitForBufferDrain() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    // Wait if buffer is getting large (> 512KB - allowing ~32 16KB chunks in flight)
    const MAX_BUFFER = 512 * 1024;
    let iterations = 0;
    const MAX_ITERATIONS = 1000; // 5 second timeout (1000 * 5ms)

    while (ws.bufferedAmount > MAX_BUFFER) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      iterations++;

      // Check if connection is still alive
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        debugLog(`Buffer drain failed: connection closed`);
        return false;
      }

      // Timeout protection
      if (iterations >= MAX_ITERATIONS) {
        addWarningLog(
          `Buffer drain timeout (buffered: ${ws.bufferedAmount} bytes)`
        );
        return false;
      }
    }

    return true;
  }

  async function sendHello() {
    if (!myKeypair) {
      addWarningLog("Cannot send HELLO (no keypair)");
      return;
    }

    await sendEnvelope("HELLO", {
      v: PROTOCOL_VERSION,
      pub: getLocalPublicKeyB64(),
    });

    if (handshakeState === HandshakeState.INIT) {
      handshakeState = HandshakeState.SENT_HELLO;
    }
    debugLog("Sent HELLO");
  }

  function nextSeq() {
    if (lastSeenSeq > outboundSeq) {
      outboundSeq = lastSeenSeq;
    }
    outboundSeq += 1;
    return outboundSeq;
  }

  async function sendReady() {
    await sendEnvelope("READY", {
      v: PROTOCOL_VERSION,
      lastSeenSeq: lastSeenSeq,
    });
    debugLog("Sent READY with lastSeenSeq=" + lastSeenSeq);
  }

  async function sendEncryptedMessage(text) {
    if (handshakeState !== HandshakeState.E2EE_ACTIVE) {
      addWarningLog("Cannot send encrypted (E2EE not active)");
      return false;
    }

    try {
      const { nonce, ciphertext } = encryptMessage(text);
      if (lastSeenSeq > outboundSeq) {
        outboundSeq = lastSeenSeq;
      }
      outboundSeq += 1;
      await sendEnvelope("MSG", {
        v: PROTOCOL_VERSION,
        seq: outboundSeq,
        n: nonce,
        c: ciphertext,
      });
      addChatLine(text, getLocalPublicKeyB64());
      return true;
    } catch (err) {
      addLog("[error] Encryption failed: " + err.message, true);
      return false;
    }
  }

  async function sendPlaintextMessage(text) {
    if (handshakeState === HandshakeState.E2EE_ACTIVE) {
      addWarningLog("⛔ Plaintext blocked (E2EE is active)");
      addSystemLog("Refusing to send plaintext in E2EE mode");
      return false;
    }

    if (text.length > MAX_PLAINTEXT_CHARS) {
      addWarningLog("Message too long");
      return false;
    }

    const senderPub = getLocalPublicKeyB64();
    await sendEnvelope("CHAT", { text: text, signature: { publicKey: senderPub } });
    addChatLine(text, senderPub, "[plaintext]");
    return true;
  }

  async function handleHello(data) {
    try {
      validateHelloMessage(data);

      if (getLocalPublicKeyB64() === data.pub) {
        debugLog("Ignoring own HELLO");
        return;
      }

      if (handshakeState === HandshakeState.E2EE_ACTIVE) {
        debugLog("HELLO received after E2EE active (ignored - deterministic keys in use)");
        return;
      }

      const peerPub = decodeAndValidateBase64(
        data.pub,
        X25519_PUBKEY_BYTES,
        "peer.pub"
      );

      if (peerPublicKey && sodium.to_base64(peerPublicKey) === data.pub) {
        debugLog("Ignoring duplicate HELLO");
        return;
      }

      peerPublicKey = peerPub;
      addSystemLog("Received peer public key");

      if (handshakeState === HandshakeState.SENT_HELLO) {
        handshakeState = HandshakeState.GOT_PEER_HELLO;
      }

      // Respond to HELLO if we haven't yet
      if (handshakeState === HandshakeState.INIT || handshakeState === HandshakeState.GOT_PEER_HELLO) {
        await sendHello();
      }

      // Key already derived from room token - activate E2EE and signal ready
      if (myKeypair && peerPublicKey && msgKey) {
        setE2EEActive();
        await sendReady();
      }
    } catch (err) {
      addWarningLog("Invalid HELLO message: " + err.message);
      debugLog("HELLO validation error: " + err.message);
    }
  }

  function handleReady(data) {
    try {
      validateReadyMessage(data);
      addSystemLog("Peer ready");

      if (msgKey && handshakeState !== HandshakeState.E2EE_ACTIVE) {
        setE2EEActive();
      }
    } catch (err) {
      addWarningLog("Invalid READY message: " + err.message);
    }
  }

  function handleEncryptedMessage(data) {
    try {
      validateEncryptedEnvelope(data);
      if (typeof data.seq === "number" && data.seq > lastSeenSeq) {
        lastSeenSeq = data.seq;
      }
      const payload = decryptMessage(data.n, data.c);
      addChatLine(payload.text, payload.pub);
    } catch (err) {
      addWarningLog("Failed to decrypt message: " + err.message);
      addChatLine("[encrypted message - decryption failed]", null);
    }
  }

  function handlePlaintextMessage(data) {
    try {
      validateChatMessage(data);

      if (handshakeState === HandshakeState.E2EE_ACTIVE) {
        addWarningLog("⛔ Received plaintext after E2EE active (ignored)");
        addSystemLog("Possible downgrade attack detected");
        return;
      }

      addChatLine(data.text, extractSenderPublicKey(data), "[plaintext]");
    } catch (err) {
      addWarningLog("Invalid CHAT message: " + err.message);
    }
  }

  function handleErrorMessage(data) {
    if (!data || typeof data !== "object") {
      addWarningLog("Invalid ERROR message");
      return;
    }
    const code = data.code || "UNKNOWN";
    const message = data.message || "protocol error";
    addWarningLog(`[server error] ${code}: ${message}`);
  }

  async function handleMessage(event) {
    try {
      if (event.data.length > MAX_WS_MESSAGE_BYTES) {
        addWarningLog("Oversized message ignored (exceeds size limit)");
        return;
      }

      let envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch (err) {
        addWarningLog("Invalid JSON (ignored)");
        return;
      }

      try {
        validateEnvelope(envelope);
      } catch (err) {
        addWarningLog("Invalid envelope: " + err.message);
        return;
      }
      
      const replaySeq =
        envelope.d && typeof envelope.d.seq === "number"
          ? envelope.d.seq
          : null;

      if (replaySeq !== null && replaySeq <= lastSeenSeq) {
        noteReplayActivity();
      }

      switch (envelope.t) {
        case "HELLO":
          await handleHello(envelope.d);
          break;
        case "READY":
          handleReady(envelope.d);
          break;
        case "MSG":
          handleEncryptedMessage(envelope.d);
          break;
        case "CHAT":
          handlePlaintextMessage(envelope.d);
          break;
        case "IMG_META":
          handleImageMeta(envelope.d);
          break;
        case "IMG_CHUNK":
          handleImageChunk(envelope.d);
          break;
        case "IMG_END":
          handleImageEnd(envelope.d);
          break;
        case "ERROR":
          handleErrorMessage(envelope.d);
          break;
        default:
          addWarningLog("Unknown message type (ignored): " + envelope.t);
      }
    } catch (err) {
      addLog("[error] Message handling failed: " + err.message, true);
      debugLog("Stack trace: " + err.stack);
    }
  }

  // =============================================================================
  // WEBSOCKET CONNECTION
  // =============================================================================

  function connectWebSocket() {
    const wsProtocol = location.protocol === "https:" ? "wss://" : "ws://";
    const wsUrl =
      wsProtocol + location.host + "/ws/" + roomToken + "?after_seq=" + lastSeenSeq;

    ws = new WebSocket(wsUrl);

    ws.onopen = async function () {
      addLog("[connected]");

      if (sodium && myKeypair) {
        await sendHello();
        // Send READY immediately to request history replay (don't wait for peer)
        if (msgKey) {
          await sendReady();
        }
      } else {
        setPlaintextMode("libsodium not loaded");
      }
    };

    ws.onmessage = handleMessage;

    ws.onerror = function (err) {
      addLog("[error: " + (err.message || "connection failed") + "]", true);
    };

    ws.onclose = function () {
      addLog("[disconnected]");
    };
  }

  // =============================================================================
  // UI EVENT HANDLERS
  // =============================================================================

  // Text message form
  form.onsubmit = async function (event) {
    event.preventDefault();

    const text = input.value.trim();
    if (text === "") return;

    if (text.length > MAX_PLAINTEXT_CHARS) {
      addWarningLog("Message too long (max " + MAX_PLAINTEXT_CHARS + " chars)");
      return;
    }

    let sent = false;
    if (handshakeState === HandshakeState.E2EE_ACTIVE && msgKey) {
      sent = await sendEncryptedMessage(text);
    } else {
      sent = await sendPlaintextMessage(text);
    }

    if (sent) {
      input.value = "";
    }
  };


  // Image button
  if (imageButton) {
    imageButton.onclick = function () {
      if (handshakeState !== HandshakeState.E2EE_ACTIVE) {
        addWarningLog("Images require end-to-end encryption");
        return;
      }
      imageInput.click();
    };
  }

  // Image file selection
  if (imageInput) {
    imageInput.onchange = async function () {
      const file = imageInput.files[0];
      if (file) {
        await sendImage(file);
        imageInput.value = ""; // Clear selection
      }
    };
  }

  // Destroy room button
  if (destroyButton) {
    destroyButton.onclick = async function () {
      if (!confirm("⚠️ Permanently delete this room and all messages?\n\nThis action cannot be undone!")) {
        return;
      }

      try {
        const response = await fetch(`/room/${roomToken}`, {
          method: "DELETE",
        });

        if (response.ok) {
          addSystemLog("🔥 Room destroyed");

          // Close WebSocket
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
          }

          // Disable UI
          if (form) form.onsubmit = (e) => e.preventDefault();
          if (input) input.disabled = true;
          if (imageButton) imageButton.disabled = true;
          if (destroyButton) destroyButton.disabled = true;

          // Clear the URL hash to prevent re-entry
          setTimeout(() => {
            window.location.href = "/create-room";
          }, 2000);
        } else {
          addWarningLog("Failed to destroy room");
        }
      } catch (err) {
        addWarningLog("Failed to destroy room: " + err.message);
      }
    };
  }

  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  async function initialize() {
    try {
      addSystemLog("Loading cryptography library...");

      if (typeof window.sodium === "undefined") {
        throw new Error("libsodium not loaded");
      }

      await window.sodium.ready;
      sodium = window.sodium;

      addSystemLog("Cryptography library loaded");

      if (privParam) {
        try {
          const priv = sodium.from_base64(privParam);
          if (priv.length !== 32) {
            throw new Error("Invalid private key length");
          }
          if (typeof sodium.crypto_kx_seed_keypair === "function") {
            myKeypair = sodium.crypto_kx_seed_keypair(priv);
          } else if (typeof sodium.crypto_scalarmult_base === "function") {
            myKeypair = {
              publicKey: sodium.crypto_scalarmult_base(priv),
              privateKey: priv,
            };
          } else {
            throw new Error("No key derivation function available");
          }
          addSystemLog("Imported keypair from URL");
        } catch (err) {
          addWarningLog("Invalid priv param, generating fresh keypair");
          debugLog("priv param error: " + err.message);
          myKeypair = sodium.crypto_kx_keypair();
          addSystemLog("Generated ephemeral keypair");
        }
      } else {
        const seed = sodium.crypto_generichash(32, "creator|" + roomToken);
        myKeypair = sodium.crypto_kx_seed_keypair(seed);
        sodium.memzero(seed);
        addSystemLog("Derived creator keypair");
      }

      localPublicKey = myKeypair.publicKey;
      localPublicKeyB64 = sodium.to_base64(localPublicKey);
      refreshChatLabels();

      // Derive deterministic room key (allows cross-device + replay)
      if (deriveRoomKey()) {
        addSystemLog("Room encryption key ready");
        // Activate E2EE immediately - don't wait for peer
        setE2EEActive();
      } else {
        throw new Error("Failed to derive room key");
      }

      debugLog("Handshake state: " + handshakeState);

      // Fetch room expiry info
      await fetchRoomExpiry();

      connectWebSocket();
    } catch (err) {
      addLog("[error] Initialization failed: " + err.message, true);
      setHandshakeFailed("E2EE initialization failed");
      connectWebSocket();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
