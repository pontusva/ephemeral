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

1. **Open the room URL in two browsers** (or one regular + one incognito):

   ```
   http://127.0.0.1:4000/#<room-token>
   ```

2. **Watch the handshake:**

   - Both clients load libsodium
   - Both generate ephemeral X25519 keypairs
   - Both exchange HELLO messages
   - Keys are derived automatically
   - Banner disappears
   - "🔒 E2EE active" indicator shows

3. **Send messages:**
   - Type in one browser → encrypted automatically
   - Other browser decrypts and displays
   - Server only sees base64-encoded ciphertext

## 🎯 What Was Implemented

### Protocol

- **Key Agreement**: X25519 (ECDH)
- **Key Derivation**: HKDF-like using libsodium KDF
- **Encryption**: XChaCha20-Poly1305 (AEAD)
- **Nonce**: 24 random bytes per message
- **Room Binding**: Keys bound to room token via salt

### Message Types

- `HELLO` - Key exchange (public key)
- `READY` - Handshake complete signal
- `MSG` - Encrypted message (nonce + ciphertext)
- `CHAT` - Plaintext fallback

### Security Properties

- ✅ End-to-end encrypted
- ✅ Forward secrecy (ephemeral keys)
- ✅ Server-ignorant (crypto-agnostic relay)
- ✅ Authenticated encryption (MAC)
- ✅ Room-bound keys
- ✅ No CDN dependencies
- ✅ Tor-compatible

### Files Modified

1. `ui/app.js` - Complete E2EE implementation
2. `ui/index.html` - Added libsodium + status UI
3. `ui/vendor/sodium.js` - Vendored libsodium (1.7MB)
4. `internal/httpx/router.go` - Added `/vendor/` route
5. `internal/httpx/ws.go` - Envelope validation (already done)
6. `internal/ws/hub.go` - BroadcastExcept (already done)

## 📚 Documentation

- **Full implementation details**: `E2EE-IMPLEMENTATION.md`
- **Previous changes**: `IMPLEMENTATION.md`

## ✅ All Acceptance Criteria Met

- [x] Two browsers exchange keys and derive shared secret
- [x] Warning banner hides when E2EE active
- [x] "🔒 E2EE active" indicator shows
- [x] Messages sent as encrypted MSG envelopes
- [x] Receiver decrypts successfully
- [x] Reload resets keys (ephemeral)
- [x] Fallback to plaintext if libsodium fails
- [x] Server remains crypto-agnostic
- [x] No CDN dependencies
- [x] Tor-compatible architecture

🎉 **E2EE Implementation Complete!**
