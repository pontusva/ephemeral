FROM oven/bun:latest

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Expose port (though it's mostly a client for the websocket)
EXPOSE 3000

# Run the bot
CMD ["bun", "index.ts"]
