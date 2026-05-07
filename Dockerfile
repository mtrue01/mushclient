FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /app/data/logs
EXPOSE 3000
ENV HOST=0.0.0.0
CMD ["node", "server.js"]
