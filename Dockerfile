# Use the same base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# COPY the package files from the subfolder to the current directory in container
# Note the path change here:
COPY apps/server/package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the server code
COPY apps/server/ .

# Build your TypeScript (if applicable)
RUN npm run build

# Expose the port
EXPOSE 3001

# Start the app
CMD ["npm", "start"]