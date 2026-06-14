# Use an official Node.js runtime
FROM node:18-bullseye-slim

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of your backend code
COPY . .

# Start your Node server (change 'index.js' if your main file is named differently)
CMD ["node", "server.js"]
