# Quick Test Guide - E2EE with Cross-Device Support

## 🚀 Test Room Ready

```
http://127.0.0.1:4000/#6b6f4e2500f48a1bdc1d8b3aa9eafc8e
```

**Note:** Create a new room with `curl -X POST http://127.0.0.1:4000/create` if this one expired.

---

## ⚡ Quick Tests (Console-Based)

### Test 1: Normal Operation

1. Open URL in a browser
2. Should show immediately:
   ```
   [system] Loading cryptography library...
   [system] Cryptography library loaded
   [system] Generated ephemeral keypair
   [system] Room encryption key ready
   [system] 🔒 E2EE active
   [connected]
   ```
3. Open same URL in another browser/device
4. Send messages - automatically encrypted
5. ✅ Works!

### Test 1b: Cross-Device & Message History

1. Send messages in browser A
2. Close browser B completely
3. Reopen same URL in browser B (or different device)
4. Message history appears and is decrypted automatically
5. ✅ Cross-device access works!

---

### Test 2: Block Plaintext After E2EE

**After E2EE active, in browser console:**

```javascript
// Try to send plaintext
ws.send(JSON.stringify({ t: "CHAT", d: { text: "attack" } }));
```

**Expected in receiver:**

```
[warning] ⛔ Received plaintext after E2EE active (ignored)
[system] Possible downgrade attack detected
```

✅ **Downgrade blocked!**

---

### Test 3: Invalid Message Types

```javascript
// Unknown type
ws.send(JSON.stringify({ t: "HACK", d: {} }));
```

**Expected:**

```
[warning] Invalid envelope: Unknown message type: HACK
```

✅ **Type validation works!**

---

### Test 3b: Encrypted Image Transfer

1. Click the 📷 button
2. Select an image (up to 5MB)
3. Watch in console:
   ```
   [system] Sending image: photo.jpg (123.4KB, 8 chunks)
   [system] Image sent
   ```
4. Receiver sees encrypted image preview with download button
5. ✅ Encrypted images work!

---

### Test 4: Malformed Crypto

```javascript
// Wrong pubkey length
ws.send(
  JSON.stringify({
    t: "HELLO",
    d: { v: 1, pub: btoa("x") },
  })
);
```

**Expected:**

```
[warning] Invalid HELLO message: HELLO.pub: expected 32 bytes, got 1
```

✅ **Schema validation works!**

---

### Test 5: Oversized Message

```javascript
// 200 KB message
ws.send(
  JSON.stringify({
    t: "CHAT",
    d: { text: "A".repeat(200000) },
  })
);
```

**Expected:**

```
[warning] Oversized message ignored (exceeds size limit)
```

✅ **Size limits enforced!**

---

## 🔒 Implementation Features

| Feature                      | Status                    |
| ---------------------------- | ------------------------- |
| Deterministic room keys      | ✅ Implemented            |
| Cross-device access          | ✅ Enabled                |
| Message history replay       | ✅ Automatic              |
| Encrypted image transfer     | ✅ Chunked (max 5MB)      |
| Explicit state machine       | ✅ Implemented            |
| No-downgrade policy          | ✅ Enforced               |
| Message type allow-list      | ✅ Active (7 types)       |
| Schema validation            | ✅ All types              |
| Size limits                  | ✅ Enforced               |
| Safe error handling          | ✅ Never crashes          |
| Debug mode                   | ✅ Available (DEBUG flag) |

---

## 📊 Architecture

**Key Derivation**: Deterministic (room token → encryption key)
**Trade-off**: Cross-device + history vs. forward secrecy
**Result**: Same URL = same decryption key

---

## 🎯 Key Features

1. **Immediate E2EE**: Activates on page load, no peer wait
2. **Cross-Device**: Open same URL on phone/laptop/tablet
3. **Message History**: Automatic replay after reconnection
4. **Encrypted Images**: Chunked transfer, E2EE-only
5. **Downgrade Protection**: Can't send/receive plaintext after E2EE
6. **Input Validation**: All messages validated before processing
7. **DoS Protection**: Size limits prevent resource exhaustion
8. **Error Safety**: Comprehensive error handling, never crashes

---

**Ready to test!** Open the test room above in two browsers. 🚀
