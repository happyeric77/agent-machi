# Build the web assets, then embed them in a static Go binary.
FROM node:22-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
COPY --from=web /src/dist/ ./internal/web/dist/
RUN CGO_ENABLED=0 go build -o /agent-machi ./cmd/agent-machi

# Demo image: the binary serves the town and its own bridge on one origin.
FROM alpine:3.20
RUN adduser -D -u 10001 agent
COPY --from=build /agent-machi /usr/local/bin/agent-machi
ENV FAKE=1 \
    FAKE_SCENARIO=demo \
    AGENT_MACHI_NO_OPEN=1 \
    AGENT_MACHI_EVENTS_LOG=/tmp/events.jsonl \
    PORT=8731
USER agent
EXPOSE 8731
CMD ["agent-machi"]
