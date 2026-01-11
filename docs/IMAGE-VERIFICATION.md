# ✅ Encrypted Image Transfer - Verification Checklist

## 📋 Pre-Flight Checklist

### Code Changes

- [x] `ui/app.js` - Added image protocol (~1100 lines total)

  - [x] New message types: IMG_META, IMG_CHUNK, IMG_END
  - [x] Updated allow-list
  - [x] Image validation functions
  - [x] Chunking implementation (sender)
  - [x] Reassembly implementation (receiver)
  - [x] GC for stale transfers
  - [x] All encrypted payloads

- [x] `ui/index.html` - Added image button UI
  - [x] Image button with disabled state
  - [x] Hidden file input
  - [x] CSS styling

### No Server Changes

- [x] `internal/httpx/ws.go` - Unchanged ✅
- [x] `internal/ws/hub.go` - Unchanged ✅
- [x] `internal/rooms/` - Unchanged ✅
- [x] Server remains crypto-agnostic relay ✅

### Linter Status

- [x] No linter errors in `ui/app.js` ✅
- [x] No linter errors in `ui/index.html` ✅

---

## 🧪 Test Plan

### Test Room

```
http://127.0.0.1:4000/#ddc29a4cf2f8dafd0c84a2f8981e18fa
```

---

### ✅ Test 1: E2EE Handshake Still Works

**Objective:** Verify existing E2EE handshake not broken by changes

**Steps:**

1. Open room in Browser A
2. Open room in Browser B
3. Wait 2-3 seconds

**Expected:**

- Both show: `[system] Cryptography library loaded`
- Both show: `[system] Generated ephemeral keypair`
- Both show: `[system] Received peer public key`
- Both show: `🔒 E2EE active` (green banner)
- Yellow warning banner hidden
- Image button **enabled** in both

**Pass Criteria:**

- ✅ Green banner visible
- ✅ Yellow banner hidden
- ✅ Image button clickable

---

### ✅ Test 2: Encrypted Text Messages Still Work

**Objective:** Verify text messaging not broken

**Steps:**

1. Continue from Test 1 (E2EE active)
2. Type "Hello" in Browser A
3. Press Send

**Expected:**

```
Browser A:
  < Hello

Browser B:
  > Hello
```

**Pass Criteria:**

- ✅ Message appears immediately in sender
- ✅ Message appears in receiver (< 100ms)
- ✅ No "[plaintext]" suffix
- ✅ No decryption errors

---

### ✅ Test 3: Plaintext Mode Blocks Images

**Objective:** Verify images require E2EE

**Steps:**

1. Open room in single browser (no peer)
2. Wait for connection
3. Observe image button state

**Expected:**

- Yellow warning banner visible
- `⚠️ End-to-end encryption requires JavaScript. You are in plaintext mode.`
- Image button **grayed out / disabled**
- Cannot click image button

**Pass Criteria:**

- ✅ Button visually disabled
- ✅ Click does nothing
- ✅ No file picker opens

---

### ✅ Test 4: Send Small Image (Happy Path)

**Objective:** Verify encrypted image transfer works

**Steps:**

1. Continue from Test 2 (two browsers, E2EE active)
2. Click "📷 Image" button in Browser A
3. Select PNG or JPEG under 500KB
4. Watch logs

**Expected:**

**Browser A (sender):**

```
[system] Sending image: photo.jpg (245.8KB, 8 chunks)
[system] Image sent
```

**Browser B (receiver):**

```
[system] Receiving image: photo.jpg (245.8KB, 8 chunks)
[image] photo.jpg
<img preview appears>
[system] Image received
```

**Pass Criteria:**

- ✅ Sender logs show "Sending image" + "Image sent"
- ✅ Receiver logs show "Receiving image" + "Image received"
- ✅ Image preview appears in receiver
- ✅ Image displays correctly (not corrupted)
- ✅ No errors in console (F12 → Console)

---

### ✅ Test 5: Verify Encryption (Network Inspection)

**Objective:** Confirm no plaintext images on wire

**Steps:**

1. Open Browser A DevTools (F12)
2. Go to Network tab → WS (WebSocket)
3. Send image (from Test 4)
4. Click on WebSocket connection
5. Inspect Messages tab

**Expected:**

```json
// Should see ONLY encrypted envelopes:
{"t":"IMG_META","d":{"v":1,"n":"xS7k9L2m...","c":"9fJ3kL8d..."}}
{"t":"IMG_CHUNK","d":{"v":1,"n":"pQ9kL4mS...","c":"7xJ2kL9f..."}}
{"t":"IMG_CHUNK","d":{"v":1,"n":"mK8sL3nT...","c":"2dF7jK4s..."}}
...
{"t":"IMG_END","d":{"v":1,"n":"qR5tM2nP...","c":"3gH9lM5t..."}}
```

**Pass Criteria:**

- ✅ No plaintext filenames visible
- ✅ No plaintext image bytes visible
- ✅ Only base64 `n` and `c` fields
- ✅ All messages have type `IMG_META`, `IMG_CHUNK`, or `IMG_END`

---

### ✅ Test 6: Oversized Image Rejection

**Objective:** Verify size limit enforcement

**Steps:**

1. Prepare image > 5MB (or use large video file)
2. With E2EE active, click "📷 Image"
3. Select large file

**Expected:**

```
[warning] Image too large (max 5MB)
```

**Pass Criteria:**

- ✅ Warning message appears
- ✅ No transfer initiated
- ✅ UI still responsive

---

### ✅ Test 7: Unsupported Format Rejection

**Objective:** Verify MIME type validation

**Steps:**

1. With E2EE active, click "📷 Image"
2. Try to select .txt, .pdf, or .mp4 file

**Expected:**

- File picker filters out non-image files
- OR warning: `[warning] Unsupported image type: ...`

**Pass Criteria:**

- ✅ Non-images not selectable
- ✅ OR warning shown if bypassed

---

### ✅ Test 8: Multiple Images in Sequence

**Objective:** Verify state management

**Steps:**

1. With E2EE active in two browsers
2. Send 3 different images in quick succession

**Expected:**

- All 3 images transfer successfully
- All 3 previews appear in correct order
- No state confusion
- No memory leaks

**Pass Criteria:**

- ✅ All images display correctly
- ✅ No errors in console
- ✅ Correct order maintained

---

### ✅ Test 9: Large Image (Chunking Stress Test)

**Objective:** Verify chunking for large files

**Steps:**

1. Prepare image ~4MB (just under limit)
2. Send with E2EE active

**Expected:**

```
[system] Sending image: large.jpg (3.9MB, 122 chunks)
[system] Image sent

// Receiver:
[system] Receiving image: large.jpg (3.9MB, 122 chunks)
[image] large.jpg
<preview>
[system] Image received
```

**Pass Criteria:**

- ✅ Many chunks processed (100+)
- ✅ No timeouts
- ✅ Image assembles correctly
- ✅ Preview displays full quality

---

### ✅ Test 10: Incomplete Transfer (Timeout Test)

**Objective:** Verify GC cleanup works

**Steps:**

1. Open browser console
2. With E2EE active, manually send IMG_META:

```javascript
// Find the WebSocket connection
// Construct and send IMG_META without chunks
// Wait 60+ seconds
```

**Expected:**

```
[warning] Image transfer timeout: test.jpg
```

**Pass Criteria:**

- ✅ Timeout warning after 60s
- ✅ State cleaned up (no memory leak)
- ✅ UI still responsive

---

## 📊 Test Results Summary

| Test                  | Status | Notes   |
| --------------------- | ------ | ------- |
| 1. E2EE Handshake     | ⬜     | Pending |
| 2. Text Messages      | ⬜     | Pending |
| 3. Plaintext Block    | ⬜     | Pending |
| 4. Happy Path Image   | ⬜     | Pending |
| 5. Network Encryption | ⬜     | Pending |
| 6. Oversized Reject   | ⬜     | Pending |
| 7. Format Reject      | ⬜     | Pending |
| 8. Multiple Images    | ⬜     | Pending |
| 9. Large Image        | ⬜     | Pending |
| 10. Timeout GC        | ⬜     | Pending |

**Legend:**

- ⬜ Pending
- ✅ Pass
- ❌ Fail
- ⚠️ Partial

---

## 🐛 Known Limitations (By Design)

1. **No persistence** - Images lost on page refresh (ephemeral)
2. **No resumable transfers** - Refresh = start over
3. **No thumbnails** - Full resolution only
4. **No compression** - Sends original file
5. **No progress bar** - Just logs
6. **No batch select** - One image at a time
7. **No drag-drop** - Button only
8. **No audio/video** - Images only

**These are intentional per requirements! ✅**

---

## 🚀 Quick Test Command

```bash
# Create fresh test room
curl -s -X POST http://127.0.0.1:4000/create | \
  python3 -c "import sys, json; data=json.load(sys.stdin); print('Test:', 'http://127.0.0.1:4000' + data['url'])"

# Open URL in two browsers
# Send test image
# Verify encrypted transfer!
```

---

## ✅ Final Verification

Before marking complete, verify:

- [ ] Server still running on `http://127.0.0.1:4000`
- [ ] No Go compilation errors
- [ ] No JavaScript console errors
- [ ] Image button visible in UI
- [ ] Button disabled before E2EE
- [ ] Button enabled after E2EE
- [ ] File picker accepts images
- [ ] Small image transfers successfully
- [ ] Preview displays correctly
- [ ] Network shows only encrypted data

---

**Status:** 📝 **READY FOR USER TESTING**

All code complete, documented, and ready for manual verification! 🎉
