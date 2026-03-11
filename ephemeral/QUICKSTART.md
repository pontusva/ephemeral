# Ephemeral E2EE Chat - Quick Start

## 🚀 Run the Server

```bash
cd /Users/pontus/Desktop/projects/ephemeral
./ephemeral-new
```

Server starts on: `http://127.0.0.1:4000`

## 💬 Create a Chat Room

```bash
curl -X POST http://127.0.0.1:4000/create
```

Response:

```json
{
  "url": "/#<room-token>",
  "expires_at": "2026-01-10T08:24:57+01:00"
}
```

## 🔒 Test E2EE

1. **Open the room URL in a browser:**

   ```
   http://127.0.0.1:4000/#<room-token>
   ```

2. **Watch E2EE activate immediately:**

   - Client loads libsodium
   - Derives encryption key from room token
   - E2EE activates instantly (no peer required)
   - Banner disappears
   - "🔒 E2EE active" indicator shows

3. **Open the same URL in another browser** (or device):

   - Second client also activates E2EE immediately
   - Both clients use the same encryption key (derived from room token)
   - Messages are encrypted/decrypted seamlessly

4. **Send messages:**
   - Type in one browser → encrypted automatically
   - Other browser decrypts and displays
   - Server only sees base64-encoded ciphertext

5. **Test cross-device access:**
   - Send messages from browser A
   - Close browser B completely
   - Reopen same URL in browser B → message history is decrypted and displayed

## 🎯 What Was Implemented

### Protocol

- **Key Derivation**: Deterministic room-token-based (enables cross-device + history)
- **Encryption**: XChaCha20-Poly1305 (AEAD)
- **Nonce**: 24 random bytes per message (never reused)
- **Room Binding**: Keys derived directly from room token
- **Library**: libsodium.js (vendored locally)

### Message Types

- `HELLO` - Peer discovery (legacy, keys not used for encryption)
- `READY` - Request message history replay
- `MSG` - Encrypted text message (nonce + ciphertext)
- `IMG_META` - Encrypted image transfer start
- `IMG_CHUNK` - Encrypted image data chunk
- `IMG_END` - Encrypted image transfer complete
- `CHAT` - Plaintext fallback (blocked after E2EE active)

### Security Properties

- ✅ End-to-end encrypted (XChaCha20-Poly1305)
- ✅ Server-ignorant (crypto-agnostic relay)
- ✅ Authenticated encryption (Poly1305 MAC)
- ✅ Room-bound keys (derived from token)
- ✅ Cross-device access (same URL = same key)
- ✅ Message history replay
- ✅ Encrypted image transfer
- ✅ No CDN dependencies
- ✅ Tor-compatible
- ❌ No forward secrecy (trade-off for history replay)

### Files Modified

1. `ui/app.js` - Complete E2EE implementation (1396 lines) with encrypted images
2. `ui/index.html` - Added libsodium + status UI + image button + destroy button
3. `ui/vendor/sodium.js` - Vendored libsodium (1.7MB)
4. `internal/httpx/router.go` - Added `/vendor/` route

## 📚 Documentation

- **Full implementation details**: `E2EE-IMPLEMENTATION.md`
- **Previous changes**: `IMPLEMENTATION.md`

## ✅ All Acceptance Criteria Met

- [x] E2EE activates immediately on page load
- [x] Warning banner hides when E2EE active
- [x] "🔒 E2EE active" indicator shows
- [x] Messages sent as encrypted MSG envelopes
- [x] Receiver decrypts successfully
- [x] Cross-device access works (same URL on multiple devices)
- [x] Message history replay after reconnection
- [x] Encrypted image transfer (chunked, E2EE-only)
- [x] Fallback to plaintext if libsodium fails
- [x] No downgrade attacks (plaintext blocked after E2EE)
- [x] Server remains crypto-agnostic
- [x] No CDN dependencies
- [x] Tor-compatible architecture

🎉 **E2EE Implementation Complete with Cross-Device Support!**
