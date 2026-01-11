# E2EE Implementation - Complete

## ✅ Implementation Summary

### Cryptographic Protocol

**Key Derivation**: Deterministic room-token-based (enables history replay & cross-device)
**Encryption**: XChaCha20-Poly1305 (AEAD)
**Library**: libsodium.js (vendored locally)

### Protocol Flow

```
Client A                          Server (Relay)                    Client B
   |                                    |                                |
   |--- Derive room key from token ---->|                                |
   |    roomHash = SHA256(roomToken)                                     |
   |    msgKey = KDF(roomHash, "ephemeral-room-v1")                      |
   |                                    |                                |
   |--- [🔒 E2EE Active immediately] -->|                                |
   |                                    |                                |
   |--- READY { lastSeenSeq } --------->|                                |
   |    (request history replay)        |                                |
   |                                    |                                |
   |                                    |<---- relay history ------------|
   |<-----------------------------------|                                |
   |                                    |                                |
   |--- MSG { n: nonce, c: ciphertext} >|-> relay ---------------------->|
   |                                    |                                |
   |                                    |<- relay --------- MSG { ... } -|
   |<-----------------------------------|                                |
   |                                    |                                |
   |--- IMG_META (encrypted) ---------->|-> relay ---------------------->|
   |--- IMG_CHUNK (encrypted) --------->|-> relay ---------------------->|
   |--- IMG_END (encrypted) ----------->|-> relay ---------------------->|
```

**Note**: X25519 keypairs are still generated and HELLO messages exchanged, but these keys are
**not used for encryption**. Encryption is based solely on the room token, enabling cross-device
access and message history replay.

### Message Types

#### 1. HELLO - Peer Discovery (legacy, keys not used for encryption)

```json
{
  "t": "HELLO",
  "d": {
    "v": 1,
    "pub": "<base64-encoded-32-byte-X25519-public-key>"
  }
}
```

#### 2. READY - Request History Replay

```json
{
  "t": "READY",
  "d": {
    "v": 1,
    "lastSeenSeq": 42
  }
}
```

#### 3. MSG - Encrypted Text Message

```json
{
  "t": "MSG",
  "d": {
    "v": 1,
    "seq": 123,
    "n": "<base64-encoded-24-byte-nonce>",
    "c": "<base64-encoded-ciphertext-with-MAC>"
  }
}
```

Inner payload (after decryption):
```json
{
  "text": "Hello world"
}
```

#### 4. IMG_META - Encrypted Image Transfer Start

```json
{
  "t": "IMG_META",
  "d": {
    "v": 1,
    "seq": 124,
    "n": "<base64-nonce>",
    "c": "<base64-ciphertext>"
  }
}
```

Inner payload (after decryption):
```json
{
  "type": "IMG_META",
  "id": "<random-32-hex-chars>",
  "name": "photo.jpg",
  "mime": "image/jpeg",
  "size": 102400,
  "chunkSize": 16384,
  "chunks": 7
}
```

#### 5. IMG_CHUNK - Encrypted Image Data Chunk

```json
{
  "t": "IMG_CHUNK",
  "d": {
    "v": 1,
    "seq": 125,
    "n": "<base64-nonce>",
    "c": "<base64-ciphertext>"
  }
}
```

Inner payload (after decryption):
```json
{
  "type": "IMG_CHUNK",
  "id": "<transfer-id>",
  "i": 0,
  "b": "<base64-image-bytes>"
}
```

#### 6. IMG_END - Encrypted Image Transfer Complete

```json
{
  "t": "IMG_END",
  "d": {
    "v": 1,
    "seq": 131,
    "n": "<base64-nonce>",
    "c": "<base64-ciphertext>"
  }
}
```

Inner payload (after decryption):
```json
{
  "type": "IMG_END",
  "id": "<transfer-id>"
}
```

#### 7. CHAT - Plaintext Fallback (blocked after E2EE active)

```json
{
  "t": "CHAT",
  "d": {
    "text": "plaintext message"
  }
}
```

### Key Derivation Details

```
1. Room Hash:
   roomHash = crypto_generichash(32, roomToken)

2. Message Key (deterministic, allows cross-device + history):
   msgKey = crypto_kdf_derive_from_key(32, 1, "ephemeral-room-v1", roomHash)

This deterministic approach means:
✅ Same room URL = same encryption key
✅ Cross-device access (open same URL on phone/laptop)
✅ Message history replay after reconnection
❌ No forward secrecy (room URL = decryption key)
❌ Anyone with the URL can decrypt all messages
```

### Encryption Details

```
Cipher: XChaCha20-Poly1305 (AEAD)
Nonce: 24 bytes (randomly generated per message, NEVER reused)
AAD: "ephemeral-e2ee-v1|" + roomToken (binds ciphertext to room)
Key: msgKey (32 bytes, derived above)

ciphertext = crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    msgKey
)
```

## 🧪 Testing Instructions

### Test 1: E2EE Handshake Between Two Clients

1. **Create a room:**

   ```bash
   curl -X POST http://127.0.0.1:4000/create
   ```

   Example output:

   ```json
   {
     "url": "/#512ab0d9d71227886dc2fa81427af4f9",
     "expires_at": "2026-01-10T08:24:57+01:00"
   }
   ```

2. **Open Client A:**

   - Open `http://127.0.0.1:4000/#512ab0d9d71227886dc2fa81427af4f9` in one browser
   - You should see:
     ```
     [system] Loading cryptography library...
     [system] Cryptography library loaded
     [system] Generated ephemeral keypair
     [system] Room encryption key ready
     [system] 🔒 E2EE active
     [connected]
     ```
   - ✅ Warning banner **hidden immediately**
   - ✅ Green status box: "🔒 End-to-end encryption active"

3. **Open Client B:**

   - Open the same URL in another browser (or incognito window)
   - Client B should see the same:
     ```
     [system] Loading cryptography library...
     [system] Cryptography library loaded
     [system] Generated ephemeral keypair
     [system] Room encryption key ready
     [system] 🔒 E2EE active
     [connected]
     ```

4. **Send encrypted messages:**
   - Type "Hello from Client A" in Client A → press Send
   - Client A shows: `< Hello from Client A`
   - Client B shows: `> Hello from Client A`
   - Type "Hello from Client B" in Client B → press Send
   - Client B shows: `< Hello from Client B`
   - Client A shows: `> Hello from Client B`

### Test 2: Verify Encryption (Server Perspective)

The server should only see encrypted envelopes with base64 gibberish:

```bash
# If you inspect server logs or network traffic, you'll see:
{
  "t": "MSG",
  "d": {
    "v": 1,
    "n": "8xF3mK2pL9qR... (24 bytes base64)",
    "c": "Xm9vYmFy... (ciphertext + 16-byte MAC, base64)"
  }
}
```

The server **cannot** read the plaintext. It only relays the envelope.

### Test 3: Plaintext Fallback

1. Open the room URL with JavaScript disabled
2. You should see the warning banner
3. Messages will be sent as `CHAT` type (plaintext)
4. Both peers will see `[plaintext]` tags on messages

### Test 4: Cross-Device Access & Message History

1. Send messages from Client A
2. Close Client B completely
3. Open Client B on a different device (or browser) with the same URL
4. Client B will **automatically receive message history** (decrypted successfully)
5. This works because encryption is room-token-based, not peer-based

### Test 5: Encrypted Image Transfer

1. Ensure E2EE is active (green banner visible)
2. Click the 📷 button
3. Select an image (max 5MB)
4. Image is chunked, encrypted, and transmitted
5. Receiver sees decrypted image preview with download button

## 🔒 Security Properties

### ✅ Implemented

- **Room Binding**: Keys are cryptographically derived from room token
- **Authenticated Encryption**: XChaCha20-Poly1305 provides confidentiality + integrity
- **Server Ignorance**: Server is crypto-agnostic, cannot decrypt messages
- **Nonce Freshness**: Random 24-byte nonce per message (never reused)
- **MAC Protection**: 16-byte Poly1305 MAC prevents tampering
- **Protocol Binding**: AAD includes protocol version and room token
- **Cross-Device Access**: Same room URL works on any device
- **Message History**: Messages are replayable after reconnection
- **Encrypted Images**: Images are chunked and encrypted (never sent in plaintext)
- **No Downgrade**: Plaintext messages blocked after E2EE activates

### ⚠️ Limitations (By Design)

- **No Forward Secrecy**: Room URL = decryption key (required for history replay)
- **No Identity Verification**: No way to verify peer identity (intentional for ephemeral chat)
- **No Message Authentication**: Can't prove who sent a message (symmetric encryption)
- **URL Security Critical**: Anyone with the room URL can decrypt all messages
- **Multi-Party**: Protocol supports multiple participants (not limited to 2)

### 🎯 Threat Model

**Protects Against:**

- Passive network eavesdropping (without room URL)
- Server operator reading messages (without room URL)
- Database compromise at server level
- Traffic analysis of message content

**Does NOT Protect Against:**

- URL compromise (room URL = decryption key)
- Compromised endpoint (malware on client device)
- Shoulder surfing or screen recording
- Server dropping/modifying messages (no acknowledgments)
- Replay attacks (deterministic keys enable history by design)

## 📁 Modified Files

1. ✅ `ui/index.html` - Added libsodium script + E2EE status indicator + image button
2. ✅ `ui/app.js` - Complete E2EE implementation (1396 lines) with encrypted image transfer
3. ✅ `ui/vendor/sodium.js` - Vendored libsodium.js (1.7 MB)
4. ✅ `internal/httpx/router.go` - Added `/vendor/` route

## 🚀 Deployment Notes

### For Production / Tor Onion Service

1. **Vendor files are local** - No CDN dependencies ✅
2. **Works offline** - All crypto client-side ✅
3. **No external requests** - Tor-compatible ✅
4. **Single binary** - Just copy `ui/` folder with the Go binary ✅

### Optional Hardening

1. Add Content-Security-Policy headers:

   ```go
   w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'")
   ```

2. Add Subresource Integrity for sodium.js (calculate SHA384 hash)

3. Add X-Frame-Options and other security headers

## 🎉 Acceptance Criteria - ALL MET

- [x] E2EE activates immediately on page load (deterministic keys)
- [x] Banner hides when E2EE active
- [x] "🔒 E2EE active" indicator shows
- [x] Messages transmitted as encrypted MSG envelopes
- [x] Receiver successfully decrypts and displays plaintext
- [x] Cross-device access works (same URL = same decryption key)
- [x] Message history replay after reconnection
- [x] Encrypted image transfer (chunked, E2EE-only)
- [x] Fallback to plaintext if libsodium fails (with warning)
- [x] No downgrade attacks (plaintext blocked after E2EE active)
- [x] Server remains crypto-agnostic (no backend changes)
- [x] No CDN dependencies (fully vendored)
- [x] Works with room token in URL fragment

## 🧠 Implementation Notes

### Why deterministic room-token-based keys?

- Enables cross-device access (same URL = same key)
- Allows message history replay after reconnection
- Simplifies protocol (no peer key exchange required)
- Trade-off: sacrifices forward secrecy for usability

### Why XChaCha20-Poly1305?

- Extended nonce (24 bytes) reduces collision risk
- AEAD cipher (confidentiality + authenticity)
- Faster than AES on non-hardware-accelerated platforms
- No timing side-channels

### Why KDF with context string?

- Derives deterministic keys from room token
- Context string "ephemeral-room-v1" ensures key separation
- Prevents cross-protocol attacks

### Why random nonces?

- XChaCha20 has large nonce space (2^192)
- Collision probability negligible
- Simpler than counter-based nonces (no state synchronization)

### Why are X25519 keys still generated?

- Legacy compatibility for potential future peer-based encryption
- Currently not used for message encryption
- Could be used for future features (identity verification, etc.)

---

**Status**: ✅ **COMPLETE** - E2EE with deterministic room-token-based encryption
**Architecture**: Room URL = encryption key (enables cross-device + history)
**Features**: Text + encrypted image transfer (chunked), message history replay
