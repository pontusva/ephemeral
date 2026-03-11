package notify

import (
	"fmt"
	"log"
	"os/exec"
)

func Emit(event, roomID, detail string) {
	msg := fmt.Sprintf("[%s] %s %s", event, roomID, detail)
	log.Printf("notify emit: %s %s %s", event, roomID, detail)

	go func(m string) {
		cmd := exec.Command("/usr/local/bin/ephemeral-notify.sh", m)
		if out, err := cmd.CombinedOutput(); err != nil {
			log.Printf("notify failed: %v output=%s", err, string(out))
		}
	}(msg)
}
