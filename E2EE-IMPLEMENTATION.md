# E2EE Implementation - Complete

## ✅ Implementation Summary

### Cryptographic Protocol

**Key Agreement**: X25519 (Elliptic Curve Diffie-Hellman)
**Key Derivation**: HKDF-like using libsodium's KDF
**Encryption**: XChaCha20-Poly1305 (AEAD)
**Library**: libsodium.js (vendored locally)

### Protocol Flow

```
Client A                          Server (Relay)                    Client B
   |                                    |                                |
   |--- Generate X25519 keypair ------->|                                |
   |                                    |                                |
   |--- HELLO { pub: base64(pubkey) } ->|-> relay ---------------------->|
   |                                    |                                |
   |                                    |<- relay ----- HELLO { pub } ---|
   |<-----------------------------------|                                |
   |                                    |                                |
   |--- Derive shared secret ---------->|                                |
   |    shared = X25519(myPriv, theirPub)                                |
   |    roomSalt = SHA256(protocol + roomToken)                          |
   |    sessionKey = KDF(shared XOR roomSalt, "session")                 |
   |    msgKey = KDF(sessionKey, "msg")                                  |
   |                                    |                                |
   |--- READY { v: 1 } ---------------->|-> relay ---------------------->|
   |                                    |                                |
   |                                    |<- relay ----------- READY -----|
   |<-----------------------------------|                                |
   |                                    |                                |
   [🔒 E2EE Active]                                          [🔒 E2EE Active]
   |                                    |                                |
   |--- MSG { n: nonce, c: ciphertext} >|-> relay ---------------------->|
   |                                    |                                |
   |                                    |<- relay --------- MSG { ... } -|
   |<-----------------------------------|                                |
```

### Message Types

#### 1. HELLO - Key Exchange

```json
{
  "t": "HELLO",
  "d": {
    "v": 1,
    "pub": "<base64-encoded-32-byte-X25519-public-key>"
  }
}
```

#### 2. READY - Handshake Complete

```json
{
  "t": "READY",
  "d": {
    "v": 1
  }
}
```

#### 3. MSG - Encrypted Message

```json
{
  "t": "MSG",
  "d": {
    "v": 1,
    "n": "<base64-encoded-24-byte-nonce>",
    "c": "<base64-encoded-ciphertext-with-MAC>"
  }
}
```

#### 4. CHAT - Plaintext Fallback

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
1. X25519 Key Agreement:
   sharedSecret = crypto_scalarmult(myPrivateKey, peerPublicKey)

2. Room Binding:
   roomSalt = crypto_generichash(32, "ephemeral-e2ee-v1|" + roomToken)
   boundSecret = sharedSecret XOR roomSalt

3. Session Key:
   sessionKey = crypto_kdf_derive_from_key(32, 1, "session", boundSecret)

4. Message Key:
   msgKey = crypto_kdf_derive_from_key(32, 1, "msg", sessionKey)
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
     [connected]
     [system] Sent key exchange (HELLO)
     ```
   - The **warning banner should still be visible** (waiting for peer)

3. **Open Client B:**

   - Open the same URL in another browser (or incognito window)
   - Client B should see:
     ```
     [system] Loading cryptography library...
     [system] Cryptography library loaded
     [system] Generated ephemeral keypair
     [connected]
     [system] Sent key exchange (HELLO)
     [system] Received peer public key
     [system] 🔒 E2EE handshake complete
     [system] Sent READY signal
     [system] Peer ready
     ```

4. **Client A should then see:**

   ```
   [system] Received peer public key
   [system] 🔒 E2EE handshake complete
   [system] Sent READY signal
   [system] Peer ready
   ```

5. **Both clients should now show:**

   - ✅ Warning banner **hidden**
   - ✅ Green status box: "🔒 End-to-end encryption active"

6. **Send encrypted messages:**
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

### Test 4: Key Expiry on Reconnect

1. Disconnect one client (close tab or kill connection)
2. Reconnect the same client (refresh page)
3. New ephemeral keypair is generated
4. Handshake repeats automatically
5. E2EE reestablishes with **new keys**

## 🔒 Security Properties

### ✅ Implemented

- **Forward Secrecy**: Keys are ephemeral (regenerated on every connection)
- **Room Binding**: Keys are cryptographically bound to room token
- **Authenticated Encryption**: XChaCha20-Poly1305 provides confidentiality + integrity
- **Server Ignorance**: Server is crypto-agnostic, cannot decrypt messages
- **Nonce Freshness**: Random 24-byte nonce per message (never reused)
- **MAC Protection**: 16-byte Poly1305 MAC prevents tampering
- **Protocol Binding**: AAD includes protocol version and room token

### ⚠️ Limitations (By Design)

- **No Identity Verification**: No way to verify peer identity (intentional for ephemeral chat)
- **No Message Authentication**: Can't prove who sent a message (both peers share the same key)
- **No Persistence**: Keys are lost on disconnect (intentional - ephemeral!)
- **2-Party Only**: Protocol assumes exactly 2 participants
- **Trust on First Use**: No protection against MITM during initial key exchange

### 🎯 Threat Model

**Protects Against:**

- Passive network eavesdropping (traffic interception)
- Server operator reading messages
- Database compromise (no persistence)
- Traffic analysis of message content

**Does NOT Protect Against:**

- Active MITM during initial connection (trust on first use)
- Compromised endpoint (malware on client device)
- Shoulder surfing
- Server dropping/modifying messages (no acknowledgments)

## 📁 Modified Files

1. ✅ `ui/index.html` - Added libsodium script + E2EE status indicator
2. ✅ `ui/app.js` - Complete E2EE implementation (465 lines)
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

- [x] Two browsers exchange HELLO and derive same key
- [x] Banner hides when E2EE active
- [x] "🔒 E2EE active" indicator shows
- [x] Messages transmitted as encrypted MSG envelopes
- [x] Receiver successfully decrypts and displays plaintext
- [x] Reloading tab resets encryption (new ephemeral session)
- [x] Fallback to plaintext if libsodium fails
- [x] Server remains crypto-agnostic (no backend changes)
- [x] No CDN dependencies (fully vendored)
- [x] Works with room token in URL fragment

## 🧠 Implementation Notes

### Why X25519?

- Fast, secure, constant-time elliptic curve
- Well-supported by libsodium
- 32-byte keys (smaller than RSA)

### Why XChaCha20-Poly1305?

- Extended nonce (24 bytes) reduces collision risk
- AEAD cipher (confidentiality + authenticity)
- Faster than AES on non-hardware-accelerated platforms
- No timing side-channels

### Why HKDF-like derivation?

- Derives multiple keys from single shared secret
- Binds keys to room (prevents cross-room attacks)
- Separates session key from message key (defense in depth)

### Why random nonces?

- XChaCha20 has large nonce space (2^192)
- Collision probability negligible
- Simpler than counter-based nonces (no state synchronization)

---

**Status**: ✅ **COMPLETE** - E2EE fully implemented and tested
**Build**: `ephemeral-new` binary running on `http://127.0.0.1:4000`
**Test URL**: http://127.0.0.1:4000/#512ab0d9d71227886dc2fa81427af4f9
