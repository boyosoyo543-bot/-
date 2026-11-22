FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /data/auth_info

ENV NODE_ENV=production
ENV AUTH_FOLDER=/data/auth_info

EXPOSE 3000

CMD ["npm", "start"]
  
