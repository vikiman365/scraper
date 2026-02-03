# Use the official Apify image
FROM apify/actor-node:20

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm --quiet set progress=false \
    && npm install --only=prod --no-optional \
    && echo "Installed NPM packages:" \
    && npm list \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

# Copy all files
COPY . ./

# Create the "src" directory if it doesn't exist
RUN mkdir -p src

# Run the actor

CMD ["npm", "start", "--silent"]

