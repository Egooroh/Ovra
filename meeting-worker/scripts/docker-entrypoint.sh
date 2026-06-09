#!/bin/sh
set -e

# Clean up stale locks from previous container runs
rm -rf /tmp/.X99-lock /tmp/pulse-* /var/run/pulse/

# Start virtual display
Xvfb :99 -screen 0 1280x720x24 -ac &
export DISPLAY=:99

# Start PulseAudio in system mode (required when running as root in Docker)
pulseaudio --system --daemonize --disallow-exit --no-cpu-limit || true
sleep 1

# Apply Prisma migrations and start orchestrator
npx prisma migrate deploy
exec node dist/orchestrator/index.js
