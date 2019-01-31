FROM node

WORKDIR /usr/share/app
COPY package.json .
COPY src/ .

RUN npm install
CMD ["node", "/usr/share/app/index.js"]