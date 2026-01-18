package httpx

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ephemeral/internal/rooms"
	"ephemeral/internal/ws"

	"github.com/coder/websocket"
)

// Envelope represents the JSON message structure {t: "TYPE", d: {...}}
// Server validates only the presence of 't' and relays raw bytes.
// Payload 'd' is opaque and crypto-agnostic.
type Envelope struct {
	Type    string          `json:"t"`
	Payload json.RawMessage `json:"d"`
}

type roomHub struct {
	hub   *ws.Hub
	count int
}

var hubs = make(map[string]*roomHub)

func wsHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.URL.Path, "/ws/")
		if token == "" {
			http.Error(w, "missing token", http.StatusBadRequest)
			return
		}

		// Check room still exists & not expired
		ok, err := rooms.Exists(db, token)
		if err != nil || !ok {
			http.Error(w, "room expired", http.StatusNotFound)
			return
		}

		// Get or create hub
		rh := hubs[token]
		if rh == nil {
			rh = &roomHub{hub: ws.NewHub()}
			hubs[token] = rh
		}

		// Enforce max 2 participants
		if rh.count >= 2 {
			http.Error(w, "room full", http.StatusForbidden)
			return
		}

		wsconn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			return
		}
		// Set read limit to 10MB to handle large encrypted image chunks
		wsconn.SetReadLimit(8 * 1024 * 1024) // 10 MB
		defer wsconn.Close(websocket.StatusNormalClosure, "")

		conn := ws.NewConn()
		rh.count++
		rh.hub.Add(conn)

		lastSeenSeq := 0
		if after := r.URL.Query().Get("after_seq"); after != "" {
			if n, err := strconv.Atoi(after); err == nil && n >= 0 {
				lastSeenSeq = n
			}
		}
		if after := r.URL.Query().Get("after"); after != "" {
			if n, err := strconv.Atoi(after); err == nil && n >= 0 {
				lastSeenSeq = n
			}
		}

		defer func() {
			rh.hub.Remove(conn)
			rh.count--

			// Clean up in-memory hub when last client disconnects
			// (Room persists in DB for history replay until expiry)
			if rh.count == 0 {
				delete(hubs, token)
			}
		}()

		// --- writer loop (server → client) ---
		go func() {
			for msg := range conn.Send() {
				_ = wsconn.Write(r.Context(), websocket.MessageText, msg)
			}
		}()

		historySent := false
		sendHistory := func() error {
			if historySent {
				return nil
			}

			rows, err := rooms.GetMessagesSince(db, token, lastSeenSeq)
			if err != nil {
				return err
			}

			for _, row := range rows {
				envelope := struct {
					Type string `json:"t"`
					Data struct {
						Version    int    `json:"v"`
						Seq        int    `json:"seq"`
						Nonce      string `json:"n"`
						Ciphertext string `json:"c"`
					} `json:"d"`
				}{
					Type: row.MessageType,
					Data: struct {
						Version    int    `json:"v"`
						Seq        int    `json:"seq"`
						Nonce      string `json:"n"`
						Ciphertext string `json:"c"`
					}{
						Version:    1,
						Seq:        row.Seq,
						Nonce:      base64.RawURLEncoding.EncodeToString(row.Nonce),
						Ciphertext: base64.RawURLEncoding.EncodeToString(row.Ciphertext),
					},
				}

				payload, err := json.Marshal(envelope)
				if err != nil {
					return err
				}
				conn.EnqueueReliable(payload)

				// Pace history replay to avoid overwhelming the client socket
				// and triggering disconnects or buffer overflows.
				time.Sleep(5 * time.Millisecond)
			}

			historySent = true
			return nil
		}

		sendProtocolError := func(code, message string) {
			payload, err := json.Marshal(map[string]interface{}{
				"t": "ERROR",
				"d": map[string]string{
					"code":    code,
					"message": message,
				},
			})
			if err != nil {
				return
			}
			_ = wsconn.Write(r.Context(), websocket.MessageText, payload)
		}

		// --- reader loop (client → server) ---
		for {
			_, data, err := wsconn.Read(r.Context())
			if err != nil {
				return
			}

			// 🔥 destroy on expiry
			ok, _ := rooms.Exists(db, token)
			if !ok {
				return
			}

			// Validate envelope structure (but remain crypto-agnostic)
			// We only check that the message has a 't' field, then relay raw bytes
			var envelope Envelope
			if err := json.Unmarshal(data, &envelope); err != nil {
				// Invalid JSON or missing structure - skip silently
				continue
			}
			if envelope.Type == "" {
				// Missing 't' field - skip silently
				continue
			}

			if envelope.Type == "READY" {
				// Parse lastSeenSeq from READY payload if present
				var readyPayload struct {
					LastSeenSeq int `json:"lastSeenSeq"`
				}
				if err := json.Unmarshal(envelope.Payload, &readyPayload); err == nil && readyPayload.LastSeenSeq > 0 {
					lastSeenSeq = readyPayload.LastSeenSeq
				}

				if err := sendHistory(); err != nil {
					log.Println("history replay failed:", err)
				}
				// Don't relay READY to other peers (history is per-client)
				continue
			}

			// Persist MSG, IMG_META, IMG_CHUNK, IMG_END for history replay
			if envelope.Type == "MSG" || envelope.Type == "IMG_META" || envelope.Type == "IMG_CHUNK" || envelope.Type == "IMG_END" {
				var payload struct {
					Seq        int    `json:"seq"`
					Nonce      string `json:"nonce"`
					Ciphertext string `json:"ciphertext"`
					Version    int    `json:"v"`
					N          string `json:"n"`
					C          string `json:"c"`
				}
				if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
					continue
				}

				nonce := payload.Nonce
				if nonce == "" {
					nonce = payload.N
				}
				ciphertext := payload.Ciphertext
				if ciphertext == "" {
					ciphertext = payload.C
				}

				if payload.Seq < 0 || nonce == "" || ciphertext == "" {
					log.Println("invalid MSG payload")
					sendProtocolError("MSG_REJECTED", "invalid sequence or payload")
					continue
				}

				nonceBytes, err := decodeBase64(nonce)
				if err != nil {
					log.Println("invalid MSG nonce encoding")
					sendProtocolError("MSG_REJECTED", "invalid or duplicate seq")
					continue
				}
				cipherBytes, err := decodeBase64(ciphertext)
				if err != nil {
					log.Println("invalid MSG ciphertext encoding")
					sendProtocolError("MSG_REJECTED", "invalid or duplicate seq")
					continue
				}

				assignedSeq, err := rooms.InsertMessage(
					db,
					token,
					nonceBytes,
					cipherBytes,
					time.Now().Unix(),
					envelope.Type,
				)
				if err != nil {
					log.Printf("InsertMessage failed for %s: %v\n", envelope.Type, err)
					sendProtocolError("MSG_REJECTED", "failed to persist message")
					continue
				}

				// Update the relayed envelope with the server-assigned sequence
				// This ensures all clients have a consistent global ordering
				payload.Seq = assignedSeq
				updatedPayload, _ := json.Marshal(payload)
				envelope.Payload = updatedPayload
				updatedEnvelope, _ := json.Marshal(envelope)

				// Relay successfully persisted and re-sequenced message
				rh.hub.BroadcastExcept(updatedEnvelope, conn)
				continue
			}

			// Relay other non-persisted messages
			rh.hub.BroadcastExcept(data, conn)
		}
	}
}

func decodeBase64(value string) ([]byte, error) {
	if value == "" {
		return nil, base64.CorruptInputError(0)
	}
	if b, err := base64.StdEncoding.DecodeString(value); err == nil {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(value); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(value); err == nil {
		return b, nil
	}
	return base64.RawURLEncoding.DecodeString(value)
}
