# Quick Test Guide - Hardened E2EE

## 🚀 Test Room Ready

```
http://127.0.0.1:4000/#6b6f4e2500f48a1bdc1d8b3aa9eafc8e
```

---

## ⚡ Quick Tests (Console-Based)

### Test 1: Normal Operation

1. Open URL in two browsers
2. Both should show: `[system] 🔒 E2EE active`
3. Send messages - automatically encrypted
4. ✅ Works!

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

## 🔒 What Was Hardened

| Feature                 | Status           |
| ----------------------- | ---------------- |
| Explicit state machine  | ✅ Implemented   |
| No-downgrade policy     | ✅ Enforced      |
| Message type allow-list | ✅ Active        |
| Schema validation       | ✅ All types     |
| Size limits             | ✅ Enforced      |
| Safe error handling     | ✅ Never crashes |
| Debug mode              | ✅ Available     |

---

## 📊 Security Level

**Before**: 🟡 Functional but vulnerable
**After**: 🟢 Production-ready with hardened invariants

---

## 🎯 Key Improvements

1. **Downgrade Protection**: Can't send/receive plaintext after E2EE
2. **State Safety**: Explicit handshake state machine
3. **Input Validation**: All messages validated before processing
4. **DoS Protection**: Size limits prevent resource exhaustion
5. **Error Safety**: Comprehensive error handling, never crashes

---

**Ready to test!** Open the test room above in two browsers. 🚀
