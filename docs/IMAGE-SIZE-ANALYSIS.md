# Image Transfer Size Analysis

## 📊 Message Size Breakdown

### For 16KB raw chunk:

```
Raw image bytes:           16,384 bytes (16 KB)
Base64 encoding:          21,846 bytes (+33%)
JSON wrapper:             21,900 bytes
Encryption overhead:      21,916 bytes (+16 bytes MAC)
Nonce (base64):              32 bytes (24 bytes → 32)
Version + structure:         50 bytes
Final JSON envelope:      ~22,000 bytes (22 KB)
```

### For 32KB raw chunk (old):

```
Raw image bytes:           32,768 bytes (32 KB)
Base64 encoding:          43,691 bytes
JSON wrapper:             43,750 bytes
Encryption overhead:      43,766 bytes
Nonce + structure:           82 bytes
Final JSON envelope:      ~44,000 bytes (44 KB)
```

## 🔧 Changes Made

### 1. Reduced Chunk Size

- **Old:** 32 KB raw → ~44 KB encrypted envelope
- **New:** 16 KB raw → ~22 KB encrypted envelope

**Why:** Smaller messages are more likely to go through without overwhelming the WebSocket.

### 2. Conservative Buffer Threshold

- **Old:** Wait if buffer > 256 KB
- **New:** Wait if buffer > 64 KB

**Why:** Be more aggressive about waiting for the buffer to drain.

### 3. Increased Delay

- **Old:** 20ms between chunks
- **New:** 50ms between chunks

**Why:** Give the server and network more time to process each chunk.

### 4. Added Diagnostics

- Log actual message sizes
- Log buffer state
- Timeout protection on buffer drain

## 🐛 Possible Root Causes

### 1. Server Message Size Limit

The Go `websocket` library may have a default max message size. Check:

```go
// In ws.go, when accepting connection:
wsconn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
    CompressionMode: websocket.CompressionDisabled,
    // May need: MessageSizeLimit: 1024 * 1024, // 1MB
})
```

### 2. Network Buffer Overflow

If sending too fast, the TCP buffer fills up and websocket closes.

**Solution:** Our buffer drain logic should handle this.

### 3. Nginx/Proxy Limits

If there's a reverse proxy, it may have limits:

- `client_max_body_size`
- `proxy_buffering`

**Not applicable here:** Direct connection to Go server.

## 🧪 Test Commands

### Enable Debug Mode

In browser console:

```javascript
// Temporarily enable debug logging
const DEBUG = true;
```

Then send image. Look for:

```
[debug] Sending IMG_CHUNK: 22143 bytes, buffer before: 0
[debug] Sending IMG_CHUNK: 22087 bytes, buffer before: 22143
...
```

### Check Connection State

In console during transfer:

```javascript
console.log("WebSocket state:", ws.readyState);
console.log("Buffered amount:", ws.bufferedAmount);
```

## ✅ Expected Behavior Now

For 804KB image:

- Chunks: ceil(804KB / 16KB) = **51 chunks** (was 26)
- Time: 51 × 50ms = **~2.5 seconds**
- Size per message: **~22KB** (was ~44KB)

```
[system] Sending image: 1.jpg (804.8KB, 51 chunks)
← No "Cannot send" warnings
[system] Image sent

Receiver:
[system] Receiving image: 1.jpg (804.8KB, 51 chunks)
[image] 1.jpg
<preview>
[system] Image received
```

## 🔍 If Still Failing

1. **Check server logs** - Are messages arriving?
2. **Try tiny image** (< 100KB) - Does it work?
3. **Check browser console** - Any errors?
4. **Network tab** - At which chunk does WS disconnect?

## 🚀 Next Steps

Try sending the image again. The smaller chunks and longer delays should prevent the connection from closing.

If it still fails on chunk 1, the issue is likely:

- First chunk itself is too large
- Server rejecting the message
- Need to configure server-side message size limits
