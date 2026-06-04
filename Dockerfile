# --- build stage ---
FROM golang:1.26-alpine AS build
WORKDIR /src

# Cache dependencies first.
COPY go.mod go.sum ./
RUN go mod download

# Build a static binary.
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/server ./cmd/server

# --- runtime stage ---
FROM alpine:3.20
RUN adduser -D -u 10001 ovra
WORKDIR /app
COPY --from=build /out/server /app/server
# workspace.yaml is mounted/copied at deploy time; keep a default if present.
COPY workspace.yaml /app/workspace.yaml
USER ovra
EXPOSE 8080
ENTRYPOINT ["/app/server"]
