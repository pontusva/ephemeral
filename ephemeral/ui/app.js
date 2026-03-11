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
  let sessionParam = null;

  for (let i = 1; i < hashParts.length; i++) {
    const part = hashParts[i];
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "priv") {
      privParam = value ? decodeURIComponent(value) : null;
    } else if (key === "session") {
      sessionParam = value ? decodeURIComponent(value) : null;
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
  const MAX_WS_MESSAGE_BYTES = 1024 * 1024; // 1 MB
  const MAX_PLAINTEXT_CHARS = 4000; // 4k chars
  const MAX_CIPHERTEXT_BYTES = 192 * 1024; // 192 KB (large enough for 96KB chunks + base64 overhead)

  // Image transfer limits
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB hard cap
  const MAX_IMAGE_CHUNK_BYTES = 16 * 1024; // 16 KB raw bytes per chunk (reduced from 32KB)
  const MAX_VIDEO_CHUNK_BYTES = 128 * 1024; // 128 KB raw bytes per chunk for video
  const IMAGE_TRANSFER_TIMEOUT = 60000; // 60s timeout for incomplete transfers
  const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
  const VIDEO_TRANSFER_TIMEOUT = 120000; // 120s timeout for video transfers

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
    "VID_META",
    "VID_CHUNK",
    "VID_END",
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

  // Allowed video MIME types
  const ALLOWED_VIDEO_MIMES = new Set([
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
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
  const sendButton = document.getElementById("send-btn");
  const banner = document.getElementById("e2ee-banner");
  const statusIndicator = document.getElementById("e2ee-status");
  const imageButton = document.getElementById("image-btn");
  const imageInput = document.getElementById("image-input");
  const videoButton = document.getElementById("video-btn");
  const videoInput = document.getElementById("video-input");
  const expiryBanner = document.getElementById("expiry-banner");
  const expiryText = document.getElementById("expiry-text");
  const destroyButton = document.getElementById("destroy-btn");
  const progressArea = document.getElementById("progress-area");

  // Session Forwarding references
  const sessionIdInput = document.getElementById("session-id");
  const forwardButton = document.getElementById("forward-btn");
  const forwardStatus = document.getElementById("forward-status");

  // Image Modal references
  const imageModal = document.getElementById("image-modal");
  const modalImg = document.getElementById("modal-img");
  const modalSave = document.getElementById("modal-save");
  const modalClose = document.getElementById("modal-close");

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
  let lastSeenSeq = 0;
  let historyReplayActive = false;
  let activeTransfers = 0;
  let replayTimer = null;

  // Room expiry state
  let roomExpiresAt = null;
  let expiryCheckInterval = null;

  // Image transfer state (receiver side)
  const incomingImages = new Map();
  // id -> { meta, chunks: Map<i, Uint8Array>, receivedBytes, startTime }

  // Video transfer state (receiver side)
  const incomingVideos = new Map();
  // id -> { meta, chunks: Map<i, Uint8Array>, receivedBytes, startTime }

  // =============================================================================
  // LOGGING UTILITIES
  // =============================================================================

  function addLog(line, className = "") {
    const div = document.createElement("div");
    if (className) div.className = className;
    div.textContent = line;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function addSystemLog(line) {
    addLog("[system] " + line, "log-system");
  }

  function addWarningLog(line) {
    addLog("[warning] " + line, "log-warning");
    if (DEBUG) console.warn(line);
  }

  function addErrorLog(line) {
    addLog("[error] " + line, "log-error");
    console.error(line);
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
  // UI UTILITIES - PROGRESS BARS
  // =============================================================================

  function updateProgressBar(id, progress, label) {
    if (!progressArea) return;

    let wrapper = document.getElementById("progress-" + id);
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.id = "progress-" + id;
      wrapper.className = "progress-wrapper";
      wrapper.innerHTML = `
        <div class="progress-info">
          <span class="progress-label"></span>
          <span class="progress-percent">0%</span>
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar-fill"></div>
        </div>
      `;
      progressArea.appendChild(wrapper);
    }

    const labelEl = wrapper.querySelector(".progress-label");
    const percentEl = wrapper.querySelector(".progress-percent");
    const fillEl = wrapper.querySelector(".progress-bar-fill");

    const displayLabel = historyReplayActive ? `[Replaying] ${label}` : label;
    labelEl.textContent = displayLabel;

    const percent = Math.min(100, Math.max(0, Math.round(progress)));
    percentEl.textContent = percent + "%";
    fillEl.style.width = percent + "%";
  }

  function removeProgressBar(id) {
    const wrapper = document.getElementById("progress-" + id);
    if (wrapper) {
      wrapper.style.opacity = "0";
      wrapper.style.transform = "translateY(-10px)";
      wrapper.style.transition = "all 0.3s ease";
      setTimeout(() => {
        if (wrapper.parentNode) {
          wrapper.remove();
        }
      }, 300);
    }
  }

  /**
   * Update input and send button state based on ongoing transfers
   */
  function updateInputState() {
    const isDisabled = activeTransfers > 0;
    if (input) input.disabled = isDisabled;
    if (sendButton) sendButton.disabled = isDisabled;
    if (imageButton) {
      if (isDisabled) imageButton.classList.add("disabled");
      else if (handshakeState === HandshakeState.E2EE_ACTIVE) imageButton.classList.remove("disabled");
    }
    if (videoButton) {
      if (isDisabled) videoButton.classList.add("disabled");
      else if (handshakeState === HandshakeState.E2EE_ACTIVE) videoButton.classList.remove("disabled");
    }
    if (isDisabled && input) {
      input.placeholder = "transferring...";
    } else if (input) {
      input.placeholder = "type something...";
    }
  }


  // =============================================================================
  // UI STATE MANAGEMENT
  // =============================================================================

  function setE2EEActive() {
    handshakeState = HandshakeState.E2EE_ACTIVE;
    banner.style.display = "none";
    statusIndicator.style.display = "block";
    if (imageButton) imageButton.classList.remove("disabled"); // Enable image label
    if (videoButton) videoButton.classList.remove("disabled"); // Enable video label
  }

  function setPlaintextMode(reason) {
    if (handshakeState === HandshakeState.E2EE_ACTIVE) {
      addWarningLog("Attempted downgrade to plaintext (blocked)");
      return;
    }
    banner.style.display = "block";
    statusIndicator.style.display = "none";
    if (imageButton) imageButton.classList.add("disabled"); // Disable image label
    if (videoButton) videoButton.classList.add("disabled"); // Disable video label
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
      timeString = `${hoursRemaining} hour${hoursRemaining > 1 ? "s" : ""
        } ${mins} minute${mins !== 1 ? "s" : ""}`;
    } else if (minutesRemaining > 0) {
      timeString = `${minutesRemaining} minute${minutesRemaining > 1 ? "s" : ""
        }`;
    } else {
      timeString = `${secondsRemaining} second${secondsRemaining !== 1 ? "s" : ""
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
    if (imageButton) imageButton.classList.add("disabled");
    if (videoButton) videoButton.classList.add("disabled");
  }

  function setEnabled() {
    if (input) input.disabled = false;
    if (imageButton) imageButton.classList.remove("disabled");
    if (videoButton) videoButton.classList.remove("disabled");
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

  function validateVideoEndPayload(payload) {
    if (payload.type !== "VID_END") throw new Error("Wrong inner type");
    if (!payload.id || typeof payload.id !== "string")
      throw new Error("Missing id");
    return true;
  }

  // Video inner payload validation (after decryption)
  function validateVideoMetaPayload(payload) {
    if (payload.type !== "VID_META") throw new Error("Wrong inner type");
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
          "VID_META.signature.publicKey"
        );
      }
    } else if (payload.pub !== undefined) {
      if (typeof payload.pub !== "string") throw new Error("Invalid pub");
      if (sodium) {
        decodeAndValidateBase64(payload.pub, X25519_PUBKEY_BYTES, "VID_META.pub");
      }
    }
    if (!payload.mime || !ALLOWED_VIDEO_MIMES.has(payload.mime)) {
      throw new Error("Invalid or disallowed MIME type");
    }
    if (
      typeof payload.size !== "number" ||
      payload.size <= 0 ||
      payload.size > MAX_VIDEO_BYTES
    ) {
      throw new Error("Invalid size");
    }
    if (
      typeof payload.chunkSize !== "number" ||
      payload.chunkSize > MAX_VIDEO_CHUNK_BYTES
    ) {
      throw new Error("Invalid chunkSize");
    }
    if (typeof payload.chunks !== "number" || payload.chunks <= 0) {
      throw new Error("Invalid chunks count");
    }
    return true;
  }

  function validateVideoChunkPayload(payload) {
    if (payload.type !== "VID_CHUNK") throw new Error("Wrong inner type");
    if (!payload.id || typeof payload.id !== "string")
      throw new Error("Missing id");
    if (typeof payload.i !== "number" || payload.i < 0)
      throw new Error("Invalid chunk index");
    if (!payload.b || typeof payload.b !== "string")
      throw new Error("Missing chunk data");
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
  // METADATA STRIPPING (CLIENT-SIDE PRIVACY)
  // =============================================================================

  function sanitizeFilename(mimeType) {
    const names = {
      "image/jpeg": "image.jpg", "image/jpg": "image.jpg",
      "image/png": "image.png", "image/webp": "image.webp", "image/gif": "image.gif",
      "video/mp4": "video.mp4", "video/webm": "video.webm",
      "video/ogg": "video.ogg", "video/quicktime": "video.mp4",
    };
    return names[mimeType] || "file";
  }

  async function detectAnimatedGif(file) {
    const buf = await file.slice(0, 4096).arrayBuffer();
    const b = new Uint8Array(buf);
    let count = 0;
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i] === 0x21 && b[i + 1] === 0xF9 && ++count > 1) return true;
    }
    return false;
  }

  // Binary PNG chunk stripper — removes tEXt/iTXt/zTXt/tIME/eXIf chunks.
  // Applied after canvas re-encode to catch anything the browser preserves or adds.
  function stripPngChunks(bytes) {
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (bytes.length < 8) return bytes;
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== sig[i]) return bytes;
    }
    const STRIP = new Set(["tEXt", "iTXt", "zTXt", "tIME", "eXIf"]);
    const chunks = [bytes.slice(0, 8)];
    let pos = 8;
    while (pos + 12 <= bytes.length) {
      const len = ((bytes[pos] << 24) | (bytes[pos+1] << 16) | (bytes[pos+2] << 8) | bytes[pos+3]) >>> 0;
      const type = String.fromCharCode(bytes[pos+4], bytes[pos+5], bytes[pos+6], bytes[pos+7]);
      const total = 12 + len;
      if (!STRIP.has(type)) chunks.push(bytes.slice(pos, pos + total));
      pos += total;
      if (type === "IEND") break;
    }
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  async function stripImageMetadata(file) {
    // Animated GIF: pass-through (canvas would break animation)
    if (file.type === "image/gif") {
      const isAnimated = await detectAnimatedGif(file);
      if (isAnimated) {
        addSystemLog("[privacy] Animated GIF: metadata stripping skipped to preserve animation");
        return { bytes: new Uint8Array(await file.arrayBuffer()), mime: "image/gif" };
      }
      // Static GIF → re-encode as PNG via canvas
    }

    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = rej;
        el.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);

      const outputMime = file.type === "image/gif" ? "image/png" : file.type;
      const blob = await new Promise((res) => canvas.toBlob(res, outputMime, 0.92));
      if (!blob) throw new Error("canvas.toBlob returned null");
      let result = new Uint8Array(await blob.arrayBuffer());
      if (outputMime === "image/png") result = stripPngChunks(result);
      return { bytes: result, mime: outputMime };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function stripMp4Metadata(bytes) {
    function readU32(b, pos) {
      return ((b[pos] << 24) | (b[pos+1] << 16) | (b[pos+2] << 8) | b[pos+3]) >>> 0;
    }
    function writeU32(b, pos, val) {
      b[pos]   = (val >>> 24) & 0xff;
      b[pos+1] = (val >>> 16) & 0xff;
      b[pos+2] = (val >>> 8)  & 0xff;
      b[pos+3] =  val         & 0xff;
    }
    function boxName(b, pos) {
      return String.fromCharCode(b[pos+4], b[pos+5], b[pos+6], b[pos+7]);
    }

    // Walk top-level boxes and remove udta/meta; recurse into moov.
    function processBoxList(src, start, end) {
      const out = [];
      let pos = start;
      while (pos < end) {
        if (pos + 8 > end) break;
        let size = readU32(src, pos);
        const name = boxName(src, pos);
        let hdrSize = 8;
        let actualSize;

        if (size === 1) {
          // 64-bit extended size — copy as-is (unusual for metadata boxes)
          if (pos + 16 > end) break;
          actualSize = Number(
            (BigInt(readU32(src, pos+8)) << 32n) | BigInt(readU32(src, pos+12))
          );
          hdrSize = 16;
        } else if (size === 0) {
          actualSize = end - pos;
        } else {
          actualSize = size;
        }

        if (actualSize < 8 || pos + actualSize > end) break;

        if (name === "udta" || name === "meta") {
          // Drop this box entirely
          pos += actualSize;
          continue;
        }

        if (name === "moov") {
          // Recurse: process moov children, rewrite box
          const innerStart = pos + hdrSize;
          const innerEnd = pos + actualSize;
          const innerOut = processBoxList(src, innerStart, innerEnd);

          // Also zero timestamps in mvhd/tkhd/mdhd within moov children
          const processed = zeroMp4Timestamps(innerOut);

          const newSize = hdrSize + processed.length;
          const newBox = new Uint8Array(newSize);
          newBox.set(src.slice(pos, pos + hdrSize));
          writeU32(newBox, 0, newSize);
          newBox.set(processed, hdrSize);
          out.push(newBox);
          pos += actualSize;
          continue;
        }

        out.push(src.slice(pos, pos + actualSize));
        pos += actualSize;
      }
      return mergeChunks(out);
    }

    function zeroMp4Timestamps(bytes) {
      // Walk boxes and zero creation_time/modification_time in mvhd, tkhd, mdhd
      const out = [];
      let pos = 0;
      while (pos < bytes.length) {
        if (pos + 8 > bytes.length) { out.push(bytes.slice(pos)); break; }
        let size = readU32(bytes, pos);
        const name = boxName(bytes, pos);
        let actualSize = (size === 0) ? bytes.length - pos : size;
        if (actualSize < 8 || pos + actualSize > bytes.length) { out.push(bytes.slice(pos)); break; }

        if (name === "mvhd" || name === "tkhd" || name === "mdhd") {
          const box = bytes.slice(pos, pos + actualSize).slice(); // copy
          const version = box[8];
          if (version === 0) {
            // creation_time at offset 12, modification_time at 16 (4 bytes each)
            writeU32(box, 12, 0);
            writeU32(box, 16, 0);
          } else {
            // version 1: 8-byte fields at offset 12 and 20
            for (let i = 12; i < 28; i++) box[i] = 0;
          }
          out.push(box);
        } else if (name === "trak" || name === "mdia") {
          // Recurse into track/media containers
          const inner = zeroMp4Timestamps(bytes.slice(pos + 8, pos + actualSize));
          const newBox = new Uint8Array(8 + inner.length);
          newBox.set(bytes.slice(pos, pos + 8));
          writeU32(newBox, 0, 8 + inner.length);
          newBox.set(inner, 8);
          out.push(newBox);
        } else {
          out.push(bytes.slice(pos, pos + actualSize));
        }
        pos += actualSize;
      }
      return mergeChunks(out);
    }

    function mergeChunks(chunks) {
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    }

    return processBoxList(bytes, 0, bytes.length);
  }

  function stripWebmMetadata(bytes) {
    // EBML vint reader — returns { value, width }
    function readVint(b, pos) {
      const first = b[pos];
      if (first === 0) return { value: 0, width: 1 };
      let width = 1;
      let mask = 0x80;
      while (!(first & mask) && width <= 8) { width++; mask >>= 1; }
      let value = first & (mask - 1);
      for (let i = 1; i < width; i++) value = (value * 256) + b[pos + i];
      return { value, width };
    }

    // Read EBML element ID (variable-width, no leading-bit mask removal)
    function readElemId(b, pos) {
      const first = b[pos];
      let width = 1;
      let mask = 0x80;
      while (!(first & mask) && width <= 4) { width++; mask >>= 1; }
      let value = first;
      for (let i = 1; i < width; i++) value = (value * 256) + b[pos + i];
      return { value, width };
    }

    function readDataSize(b, pos) {
      return readVint(b, pos);
    }

    function encodeVint(value, minWidth) {
      // Find minimum width
      let width = minWidth || 1;
      while (width < 8) {
        const maxVal = (1 << (7 * width)) - 2;
        if (value <= maxVal) break;
        width++;
      }
      const out = new Uint8Array(width);
      let v = value;
      for (let i = width - 1; i > 0; i--) { out[i] = v & 0xff; v >>= 8; }
      out[0] = v | (0x80 >> (width - 1));
      return out;
    }

    // Element IDs of interest
    const ID_SEGMENT   = 0x18538067;
    const ID_SEEKHEAD  = 0x114D9B74;
    const ID_INFO      = 0x1549A966;
    const ID_TAGS      = 0x1254C367;
    const ID_WRITINGAPP  = 0x5741;
    const ID_MUXINGAPP   = 0x4D80;
    const ID_DATEUTC     = 0x4461;
    const ID_TITLE       = 0x7BA9;
    const INFO_STRIP_IDS = new Set([ID_WRITINGAPP, ID_MUXINGAPP, ID_DATEUTC, ID_TITLE]);

    function processSegment(src, start, end) {
      const out = [];
      let pos = start;
      while (pos < end) {
        if (pos + 2 > end) break;
        const idInfo = readElemId(src, pos);
        const idEnd = pos + idInfo.width;
        if (idEnd + 1 > end) break;
        const sizeInfo = readDataSize(src, idEnd);
        const dataStart = idEnd + sizeInfo.width;
        const dataSize = sizeInfo.value;
        if (dataStart + dataSize > end) break;

        const id = idInfo.value;

        if (id === ID_SEEKHEAD) {
          // Remove SeekHead — stale after removals; browsers play fine without it
          pos = dataStart + dataSize;
          continue;
        }

        if (id === ID_TAGS) {
          // Remove Tags element entirely
          pos = dataStart + dataSize;
          continue;
        }

        if (id === ID_INFO) {
          // Rewrite Info, removing privacy-sensitive sub-elements
          const filteredData = filterInfoChildren(src, dataStart, dataStart + dataSize);
          const idBytes = src.slice(pos, idEnd);
          const newSizeVint = encodeVint(filteredData.length, sizeInfo.width);
          const elem = new Uint8Array(idBytes.length + newSizeVint.length + filteredData.length);
          elem.set(idBytes, 0);
          elem.set(newSizeVint, idBytes.length);
          elem.set(filteredData, idBytes.length + newSizeVint.length);
          out.push(elem);
          pos = dataStart + dataSize;
          continue;
        }

        out.push(src.slice(pos, dataStart + dataSize));
        pos = dataStart + dataSize;
      }
      return mergeWebmChunks(out);
    }

    function filterInfoChildren(src, start, end) {
      const out = [];
      let pos = start;
      while (pos < end) {
        if (pos + 2 > end) break;
        const idInfo = readElemId(src, pos);
        const idEnd = pos + idInfo.width;
        if (idEnd + 1 > end) break;
        const sizeInfo = readDataSize(src, idEnd);
        const dataStart = idEnd + sizeInfo.width;
        const dataSize = sizeInfo.value;
        if (dataStart + dataSize > end) break;
        if (!INFO_STRIP_IDS.has(idInfo.value)) {
          out.push(src.slice(pos, dataStart + dataSize));
        }
        pos = dataStart + dataSize;
      }
      return mergeWebmChunks(out);
    }

    function mergeWebmChunks(chunks) {
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    }

    // Find and process Segment element
    let pos = 0;
    const out = [];
    while (pos < bytes.length) {
      if (pos + 2 > bytes.length) break;
      const idInfo = readElemId(bytes, pos);
      const idEnd = pos + idInfo.width;
      if (idEnd + 1 > bytes.length) break;
      const sizeInfo = readDataSize(bytes, idEnd);
      const dataStart = idEnd + sizeInfo.width;
      let dataSize = sizeInfo.value;
      // Handle unknown-size segment (all 1s vint)
      const isUnknownSize = dataSize >= (Math.pow(2, 7 * sizeInfo.width) - 1);
      if (isUnknownSize) dataSize = bytes.length - dataStart;
      const dataEnd = dataStart + dataSize;

      if (idInfo.value === ID_SEGMENT) {
        const filteredData = processSegment(bytes, dataStart, Math.min(dataEnd, bytes.length));
        const idBytes = bytes.slice(pos, idEnd);
        const newSizeVint = encodeVint(filteredData.length, sizeInfo.width);
        const elem = new Uint8Array(idBytes.length + newSizeVint.length + filteredData.length);
        elem.set(idBytes, 0);
        elem.set(newSizeVint, idBytes.length);
        elem.set(filteredData, idBytes.length + newSizeVint.length);
        out.push(elem);
      } else {
        out.push(bytes.slice(pos, Math.min(dataEnd, bytes.length)));
      }
      pos = dataEnd;
      if (isUnknownSize) break;
    }
    return mergeWebmChunks(out);
  }

  async function stripVideoMetadata(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (file.type === "video/mp4" || file.type === "video/quicktime")
        return { bytes: stripMp4Metadata(bytes), mime: "video/mp4" };
      if (file.type === "video/webm")
        return { bytes: stripWebmMetadata(bytes), mime: "video/webm" };
    } catch (err) {
      addSystemLog("[privacy] Video metadata stripping failed (" + err.message + "), sending original");
    }
    if (file.type === "video/ogg")
      addSystemLog("[privacy] Ogg video metadata stripping not supported");
    return { bytes, mime: file.type };
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
      // Create entry container (block-level to ensure vertical stacking)
      const entry = document.createElement("div");
      entry.style.margin = "15px 0";
      entry.style.display = "block";

      // Create thumbnail wrapper
      const wrapper = document.createElement("div");
      wrapper.className = "image-thumbnail-wrapper";
      wrapper.title = "Click to view full size";

      const img = document.createElement("img");
      img.src = objectUrl;
      img.className = "image-thumbnail";
      img.alt = fileName;

      wrapper.appendChild(img);

      // Click handler to open lightbox
      wrapper.onclick = () => {
        openImageModal(objectUrl, fileName);
      };

      // Create label div for below the image
      const label = document.createElement("div");
      label.style.fontSize = "12px";
      label.style.color = "var(--ash)";
      label.style.marginTop = "4px";
      const senderLabel = getSenderLabel(senderPubB64);
      label.textContent = `${senderLabel}: [image] ${fileName}`;

      entry.appendChild(wrapper);
      entry.appendChild(label);

      img.onload = () => {
        log.scrollTop = log.scrollHeight;
      };

      img.onerror = () => {
        addWarningLog("Failed to load image preview");
      };

      log.appendChild(entry);

      // Cleanup object URL after 15 minutes (extended since it's used in modal)
      setTimeout(() => URL.revokeObjectURL(objectUrl), 900000);
    } catch (err) {
      addLog("[error] Failed to display image: " + err.message, true);
      console.error("Image display error:", err);
    }
  }

  // =============================================================================
  // LIGHTBOX MODAL HANDLERS
  // =============================================================================

  let currentModalUrl = "";
  let currentModalFilename = "";

  function openImageModal(url, filename) {
    if (!imageModal || !modalImg) return;

    currentModalUrl = url;
    currentModalFilename = filename;

    modalImg.src = url;
    imageModal.classList.add("show");
    document.body.style.overflow = "hidden"; // Prevent scrolling
  }

  function closeImageModal() {
    if (!imageModal) return;
    imageModal.classList.remove("show");
    document.body.style.overflow = ""; // Restore scrolling
  }

  if (modalClose) {
    modalClose.onclick = closeImageModal;
  }

  if (imageModal) {
    // Close on backdrop click
    imageModal.onclick = (e) => {
      if (e.target === imageModal) closeImageModal();
    };
  }

  if (modalSave) {
    modalSave.onclick = () => {
      if (!currentModalUrl) return;
      const a = document.createElement("a");
      a.href = currentModalUrl;
      a.download = currentModalFilename || "image";
      a.click();
    };
  }

  // Handle Esc key
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeImageModal();
  });

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

    let transferId; // Declare transferId here for scope in catch block
    activeTransfers++;
    updateInputState();

    try {
      // Generate random transfer ID
      transferId = sodium.to_hex(sodium.randombytes_buf(16));

      // Strip metadata and read bytes
      addSystemLog("Stripping image metadata...");
      const { bytes, mime: strippedMime } = await stripImageMetadata(file);

      // Re-validate size after canvas re-encode
      if (bytes.length > MAX_IMAGE_BYTES) {
        addWarningLog(`Image too large after processing (${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);
        return false;
      }

      // Calculate chunks
      const chunkSize = MAX_IMAGE_CHUNK_BYTES;
      const numChunks = Math.ceil(bytes.length / chunkSize);

      addSystemLog(
        `Sending image: ${sanitizeFilename(strippedMime)} (${(bytes.length / 1024).toFixed(
          1
        )}KB, ${numChunks} chunks)`
      );

      // Send IMG_META
      const metaPayload = {
        type: "IMG_META",
        id: transferId,
        name: sanitizeFilename(strippedMime),
        mime: strippedMime,
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
          seq: 0, // Server will assign actual seq
          n: metaNonce,
          c: metaCipher,
        }))
      ) {
        throw new Error("Connection lost during metadata phase");
      }

      updateProgressBar(transferId, 0, `Uploading: ${file.name}`);

      // Wait for WebSocket buffer to drain before sending chunks
      if (!(await waitForBufferDrain())) {
        throw new Error("Connection failed (write buffer full)");
      }

      // Send chunks with connection checks
      for (let i = 0; i < numChunks; i++) {
        // Check connection before each chunk
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error(`Connection lost at chunk ${i}/${numChunks}`);
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

        if (!(await sendEnvelope("IMG_CHUNK", {
          v: PROTOCOL_VERSION,
          seq: 0, // Server will assign actual seq
          n: chunkNonce,
          c: chunkCipher,
        }))
        ) {
          throw new Error(`Server rejected chunk ${i}/${numChunks}`);
        }

        updateProgressBar(transferId, ((i + 1) / numChunks) * 100, `Uploading: ${file.name}`);

        // Wait for buffer to drain before next chunk
        if (!(await waitForBufferDrain())) {
          throw new Error(`Connection stalled at chunk ${i + 1}/${numChunks}`);
        }

        // Pacing to prevent overwhelming the server buffer or DB transactions
        await new Promise((resolve) => setTimeout(resolve, 15));
      }

      // Final connection check
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Connection lost before IMG_END");
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
          seq: 0, // Server will assign actual seq
          n: endNonce,
          c: endCipher,
        }))
      ) {
        throw new Error("Failed to finalize image transfer");
      }

      removeProgressBar(transferId);
      addSystemLog("Image sent successfully");

      // Display preview for sender too (use stripped bytes, not original file)
      displayImagePreview(
        { type: strippedMime },
        bytes,
        sanitizeFilename(strippedMime),
        bytes.length,
        getLocalPublicKeyB64()
      );

      return true;
    } catch (err) {
      addErrorLog(`Image upload failed: ${err.message}. Please try again.`);
      if (transferId) removeProgressBar(transferId);
      return false;
    } finally {
      activeTransfers--;
      updateInputState();
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

      activeTransfers++;
      updateInputState();

      addSystemLog(
        `Receiving image: ${payload.name} (${(payload.size / 1024).toFixed(
          1
        )}KB, ${payload.chunks} chunks)`
      );

      updateProgressBar(payload.id, 0, `Downloading: ${payload.name}`);
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

      updateProgressBar(
        payload.id,
        (transfer.chunks.size / transfer.meta.chunks) * 100,
        `Downloading: ${transfer.meta.name}`
      );

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
        addErrorLog(
          `Received incomplete image "${transfer.meta.name}" (${transfer.chunks.size}/${transfer.meta.chunks} chunks). The sender might have been disconnected or overwhelmed.`
        );
        removeProgressBar(payload.id);
        if (incomingImages.has(payload.id)) {
          incomingImages.delete(payload.id);
          activeTransfers = Math.max(0, activeTransfers - 1);
          updateInputState();
        }
        return;
      }

      // Assemble image
      const imageBytes = new Uint8Array(transfer.meta.size);
      let offset = 0;
      for (let i = 0; i < transfer.meta.chunks; i++) {
        const chunk = transfer.chunks.get(i);
        if (!chunk) {
          addErrorLog(`Failed to assemble image: missing chunk ${i + 1}`);
          if (incomingImages.has(payload.id)) {
            incomingImages.delete(payload.id);
            activeTransfers = Math.max(0, activeTransfers - 1);
            updateInputState();
          }
          removeProgressBar(payload.id);
          return;
        }
        imageBytes.set(chunk, offset);
        offset += chunk.length;
      }

      // Create blob and display
      // const blob = new Blob([imageBytes], { type: transfer.meta.mime }); // blob is handled in displayImagePreview

      // Display preview using helper
      displayImagePreview(
        { type: transfer.meta.mime },
        imageBytes,
        transfer.meta.name,
        transfer.meta.size,
        extractSenderPublicKey(transfer.meta)
      );

      // Cleanup
      if (incomingImages.has(payload.id)) {
        incomingImages.delete(payload.id);
        activeTransfers = Math.max(0, activeTransfers - 1);
        updateInputState();
      }
      removeProgressBar(payload.id);
    } catch (err) {
      addWarningLog("Invalid IMG_END: " + err.message);
    }
  }

  // =============================================================================
  // VIDEO TRANSFER - SENDER SIDE
  // =============================================================================

  /**
   * Display a video preview in the chat log
   */
  function displayVideoPreview(
    file,
    videoBytes,
    fileName,
    fileSize,
    senderPubB64 = null
  ) {
    try {
      const mimeType = file.type || "video/mp4";
      const blob =
        file instanceof Blob
          ? file
          : new Blob([videoBytes], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);

      const entry = document.createElement("div");
      entry.style.margin = "15px 0";
      entry.style.display = "block";

      const wrapper = document.createElement("div");
      wrapper.className = "image-thumbnail-wrapper"; // Reuse thumbnail wrapper style

      const video = document.createElement("video");
      video.src = objectUrl;
      video.className = "video-preview";
      video.controls = true;
      video.preload = "metadata";

      wrapper.appendChild(video);

      const label = document.createElement("div");
      label.style.fontSize = "12px";
      label.style.color = "var(--ash)";
      label.style.marginTop = "4px";
      const senderLabel = getSenderLabel(senderPubB64);
      label.textContent = `${senderLabel}: [video] ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`;

      entry.appendChild(wrapper);
      entry.appendChild(label);

      video.onloadedmetadata = () => {
        log.scrollTop = log.scrollHeight;
      };

      log.appendChild(entry);

      // Cleanup object URL after 30 minutes for videos
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1800000);
    } catch (err) {
      addLog("[error] Failed to display video: " + err.message, true);
    }
  }

  async function sendVideo(file) {
    if (handshakeState !== HandshakeState.E2EE_ACTIVE) {
      addWarningLog("Videos require end-to-end encryption");
      return false;
    }

    if (!file || !file.type) {
      addWarningLog("Invalid file");
      return false;
    }

    if (!ALLOWED_VIDEO_MIMES.has(file.type)) {
      addWarningLog("Unsupported video type: " + file.type);
      return false;
    }

    if (file.size > MAX_VIDEO_BYTES) {
      addWarningLog(`Video too large (max ${MAX_VIDEO_BYTES / 1024 / 1024}MB)`);
      return false;
    }

    let transferId;
    activeTransfers++;
    updateInputState();

    try {
      transferId = sodium.to_hex(sodium.randombytes_buf(16));

      addSystemLog("Stripping video metadata...");
      const { bytes, mime: strippedMime } = await stripVideoMetadata(file);

      const chunkSize = 96 * 1024; // Use larger 96KB chunks for video to reduce DB overhead
      const numChunks = Math.ceil(bytes.length / chunkSize);

      addSystemLog(`Sending video: ${sanitizeFilename(strippedMime)} (${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);

      const metaPayload = {
        type: "VID_META",
        id: transferId,
        name: sanitizeFilename(strippedMime),
        mime: strippedMime,
        size: bytes.length,
        chunkSize: chunkSize,
        chunks: numChunks,
        signature: { publicKey: getLocalPublicKeyB64() },
      };

      const { nonce: metaNonce, ciphertext: metaCipher } = encryptPayload(metaPayload);

      if (!(await sendEnvelope("VID_META", {
        v: PROTOCOL_VERSION,
        seq: 0,
        n: metaNonce,
        c: metaCipher,
      }))) {
        throw new Error("Connection lost during metadata phase");
      }

      updateProgressBar(transferId, 0, `Uploading Video: ${file.name}`);

      for (let i = 0; i < numChunks; i++) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error(`Connection lost at chunk ${i}/${numChunks}`);
        }

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, bytes.length);
        const chunkBytes = bytes.slice(start, end);

        const chunkPayload = {
          type: "VID_CHUNK",
          id: transferId,
          i: i,
          b: sodium.to_base64(chunkBytes),
        };

        const { nonce: chunkNonce, ciphertext: chunkCipher } = encryptPayload(chunkPayload);

        if (!(await sendEnvelope("VID_CHUNK", {
          v: PROTOCOL_VERSION,
          seq: 0,
          n: chunkNonce,
          c: chunkCipher,
        }))) {
          throw new Error(`Server rejected chunk ${i}/${numChunks}`);
        }

        updateProgressBar(transferId, ((i + 1) / numChunks) * 100, `Uploading Video: ${file.name}`);
        if (!(await waitForBufferDrain())) {
          throw new Error(`Connection stalled at chunk ${i + 1}/${numChunks}`);
        }
        // Increased pacing for larger video chunks to help Tor circuits keep up
        await new Promise((resolve) => setTimeout(resolve, i % 3 === 0 ? 50 : 10));
      }

      const endPayload = { type: "VID_END", id: transferId };
      const { nonce: endNonce, ciphertext: endCipher } = encryptPayload(endPayload);

      if (!(await sendEnvelope("VID_END", {
        v: PROTOCOL_VERSION,
        seq: 0,
        n: endNonce,
        c: endCipher,
      }))) {
        throw new Error("Failed to finalize video transfer");
      }

      removeProgressBar(transferId);
      addLog("[video sent]");
      displayVideoPreview({ type: strippedMime }, bytes, sanitizeFilename(strippedMime), bytes.length, getLocalPublicKeyB64());
      return true;
    } catch (err) {
      addErrorLog(`Video upload failed: ${err.message}`);
      if (transferId) removeProgressBar(transferId);
      return false;
    } finally {
      activeTransfers--;
      updateInputState();
    }
  }

  // =============================================================================
  // VIDEO TRANSFER - RECEIVER SIDE
  // =============================================================================

  function handleVideoMeta(data) {
    try {
      validateEncryptedEnvelope(data);
      if (typeof data.seq === "number" && data.seq > lastSeenSeq) lastSeenSeq = data.seq;
      const payload = decryptPayload(data.n, data.c);
      validateVideoMetaPayload(payload);

      if (incomingVideos.has(payload.id)) return;

      incomingVideos.set(payload.id, {
        meta: payload,
        chunks: new Map(),
        receivedBytes: 0,
        startTime: Date.now(),
      });

      activeTransfers++;
      updateInputState();
      addSystemLog(`Receiving video: ${payload.name} (${(payload.size / 1024 / 1024).toFixed(1)}MB)`);
      updateProgressBar(payload.id, 0, `Downloading Video: ${payload.name}`);
    } catch (err) {
      addWarningLog("Invalid VID_META: " + err.message);
    }
  }

  function handleVideoChunk(data) {
    try {
      validateEncryptedEnvelope(data);
      if (typeof data.seq === "number" && data.seq <= lastSeenSeq) noteReplayActivity();
      if (typeof data.seq === "number" && data.seq > lastSeenSeq) lastSeenSeq = data.seq;

      const payload = decryptPayload(data.n, data.c);
      validateVideoChunkPayload(payload);

      const transfer = incomingVideos.get(payload.id);
      if (!transfer) return;

      if (payload.i < 0 || payload.i >= transfer.meta.chunks) return;
      if (transfer.chunks.has(payload.i)) return;

      const chunkBytes = sodium.from_base64(payload.b);
      transfer.chunks.set(payload.i, chunkBytes);
      transfer.receivedBytes += chunkBytes.length;
      if (!historyReplayActive) resetVideoTransferIdleTimer(payload.id);

      updateProgressBar(
        payload.id,
        (transfer.chunks.size / transfer.meta.chunks) * 100,
        `Downloading Video: ${transfer.meta.name}`
      );
    } catch (err) {
      addWarningLog("Invalid VID_CHUNK: " + err.message);
    }
  }

  function handleVideoEnd(data) {
    try {
      validateEncryptedEnvelope(data);
      if (typeof data.seq === "number" && data.seq > lastSeenSeq) lastSeenSeq = data.seq;
      const payload = decryptPayload(data.n, data.c);
      validateVideoEndPayload(payload);

      const transfer = incomingVideos.get(payload.id);
      if (!transfer) return;

      if (transfer.chunks.size !== transfer.meta.chunks) {
        addErrorLog(`Received incomplete video "${transfer.meta.name}"`);
        removeProgressBar(payload.id);
      } else {
        const videoBytes = new Uint8Array(transfer.meta.size);
        let offset = 0;
        for (let i = 0; i < transfer.meta.chunks; i++) {
          const chunk = transfer.chunks.get(i);
          videoBytes.set(chunk, offset);
          offset += chunk.length;
        }
        displayVideoPreview({ type: transfer.meta.mime }, videoBytes, transfer.meta.name, transfer.meta.size, extractSenderPublicKey(transfer.meta));
        removeProgressBar(payload.id);
      }

      incomingVideos.delete(payload.id);
      activeTransfers = Math.max(0, activeTransfers - 1);
      updateInputState();
    } catch (err) {
      addWarningLog("Invalid VID_END: " + err.message);
    }
  }

  function resetVideoTransferIdleTimer(transferId) {
    const transfer = incomingVideos.get(transferId);
    if (!transfer) return;
    transfer.startTime = Date.now();
  }

  /**
   * Garbage collect incomplete image transfers (timeout)
   */
  function resetImageTransferIdleTimer(transferId) {
    const transfer = incomingImages.get(transferId);
    if (!transfer) return;
    transfer.startTime = Date.now();
  }

  function cleanupStaleTransfers() {
    const now = Date.now();
    for (const [id, transfer] of incomingImages.entries()) {
      if (now - transfer.startTime > IMAGE_TRANSFER_TIMEOUT) {
        addWarningLog("Image transfer timeout: " + transfer.meta.name);
        removeProgressBar(id);
        incomingImages.delete(id);
        activeTransfers = Math.max(0, activeTransfers - 1);
        updateInputState();
      }
    }
    for (const [id, transfer] of incomingVideos.entries()) {
      if (now - transfer.startTime > VIDEO_TRANSFER_TIMEOUT) {
        addWarningLog("Video transfer timeout: " + transfer.meta.name);
        removeProgressBar(id);
        incomingVideos.delete(id);
        activeTransfers = Math.max(0, activeTransfers - 1);
        updateInputState();
      }
    }
  }

  // Run cleanup periodically
  setInterval(cleanupStaleTransfers, 30000); // Every 30s

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

    // Wait if buffer is getting large (> 1MB - allowing ~64 16KB chunks in flight)
    const MAX_BUFFER = 1024 * 1024;
    let iterations = 0;
    const MAX_ITERATIONS = 6000; // 30 second timeout (6000 * 5ms)

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
      await sendEnvelope("MSG", {
        v: PROTOCOL_VERSION,
        seq: 0, // Server will assign actual seq
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
        case "VID_META":
          handleVideoMeta(envelope.d);
          break;
        case "VID_CHUNK":
          handleVideoChunk(envelope.d);
          break;
        case "VID_END":
          handleVideoEnd(envelope.d);
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
      // Reset active transfers on disconnect to avoid stuck UI
      if (activeTransfers > 0) {
        activeTransfers = 0;
        incomingImages.clear();
        updateInputState();
      }
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
      input.style.height = "auto"; // Reset height after sending
    }
  };

  // Auto-expand textarea & Handle Enter key
  if (input) {
    input.addEventListener("input", function () {
      this.style.height = "auto";
      const newHeight = Math.min(this.scrollHeight, 200);
      this.style.height = newHeight + "px";
      // Show scrollbar only if max-height is reached
      this.style.overflowY = this.scrollHeight > 200 ? "auto" : "hidden";
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.dispatchEvent(new Event("submit"));
      }
    });
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

  // Video file selection
  if (videoInput) {
    videoInput.onchange = async function () {
      const file = videoInput.files[0];
      if (file) {
        await sendVideo(file);
        videoInput.value = ""; // Clear selection
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
  // Session Forwarding Button
  if (forwardButton) {
    forwardButton.onclick = async function () {
      const sessionId = sessionIdInput.value.trim();
      if (!sessionId) {
        alert("Please enter a Session ID");
        return;
      }

      forwardButton.disabled = true;
      forwardStatus.textContent = "⌛ Enabling forwarding...";

      try {
        const response = await fetch("/bot/forward", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            roomToken: roomToken,
            sessionId: sessionId,
            senderPublicKey: localPublicKeyB64,
          }),
        });

        if (response.ok) {
          forwardStatus.textContent = "✅ Forwarding enabled to: " + sessionId;
          forwardStatus.style.color = "var(--slime)";
          sessionIdInput.disabled = true;
          forwardButton.textContent = "Active";
          addSystemLog("Bot forwarding initiated for room");
        } else {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || "Bot service error");
        }
      } catch (err) {
        forwardButton.disabled = false;
        forwardStatus.textContent = "❌ Error: " + err.message;
        forwardStatus.style.color = "#ff6b6b";
      }
    };

    // Auto-trigger if session parameter is present
    if (sessionParam) {
      sessionIdInput.value = sessionParam;
      // Wait a bit for initialization to complete
      setTimeout(() => {
        if (forwardButton.onclick) {
          forwardButton.onclick();
        }
      }, 1000);
    }
  }

  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  async function initialize() {
    try {
      if (typeof window.sodium === "undefined") {
        throw new Error("libsodium not loaded");
      }

      await window.sodium.ready;
      sodium = window.sodium;

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
        } catch (err) {
          addWarningLog("Invalid priv param, generating fresh keypair");
          debugLog("priv param error: " + err.message);
          myKeypair = sodium.crypto_kx_keypair();
        }
      } else {
        const seed = sodium.crypto_generichash(32, "creator|" + roomToken);
        myKeypair = sodium.crypto_kx_seed_keypair(seed);
        sodium.memzero(seed);
      }

      localPublicKey = myKeypair.publicKey;
      localPublicKeyB64 = sodium.to_base64(localPublicKey);
      refreshChatLabels();

      // Derive deterministic room key (allows cross-device + replay)
      if (deriveRoomKey()) {
        // Activate E2EE immediately - don't wait for peer
        setE2EEActive();
      } else {
        throw new Error("Failed to derive room key");
      }

      debugLog("Handshake state: " + handshakeState);

      // Fetch room expiry info
      await fetchRoomExpiry();

      // Restore bot session if active
      try {
        const botResp = await fetch(`/bot/status?roomToken=${roomToken}`);
        if (botResp.ok) {
          const botData = await botResp.json();
          if (botData.sessionId) {
            sessionIdInput.value = botData.sessionId;
            forwardStatus.textContent = "✅ Forwarding active (restored)";
            forwardStatus.style.color = "var(--slime)";
            sessionIdInput.disabled = true;
            forwardButton.textContent = "Active";
            forwardButton.disabled = true;
          }
        }
      } catch (err) {
        debugLog("Failed to restore bot session: " + err.message);
      }

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
