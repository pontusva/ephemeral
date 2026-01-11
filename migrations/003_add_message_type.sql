-- Add message_type column to support different message types (MSG, IMG_META, IMG_CHUNK, IMG_END)
ALTER TABLE ephemeral_messages
ADD COLUMN message_type TEXT;