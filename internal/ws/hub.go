package ws

import "sync"

type Conn struct {
	send chan []byte
}

func NewConn() *Conn {
	return &Conn{
		send: make(chan []byte, 8),
	}
}

func (c *Conn) Send() <-chan []byte {
	return c.send
}

func (c *Conn) Enqueue(msg []byte) {
	select {
	case c.send <- msg:
	default:
	}
}

type Hub struct {
	mu    sync.Mutex
	conns map[*Conn]struct{}
}

func NewHub() *Hub {
	return &Hub{
		conns: make(map[*Conn]struct{}),
	}
}

func (h *Hub) Add(c *Conn) {
	h.mu.Lock()
	h.conns[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) Remove(c *Conn) {
	h.mu.Lock()
	delete(h.conns, c)
	h.mu.Unlock()
	close(c.send)
}

func (h *Hub) Broadcast(msg []byte) {
	h.mu.Lock()
	for c := range h.conns {
		select {
		case c.send <- msg:
		default:
		}
	}
	h.mu.Unlock()
}

// BroadcastExcept sends a message to all connections except the sender
func (h *Hub) BroadcastExcept(msg []byte, sender *Conn) {
	h.mu.Lock()
	for c := range h.conns {
		if c == sender {
			continue // Skip the sender
		}
		select {
		case c.send <- msg:
		default:
		}
	}
	h.mu.Unlock()
}
