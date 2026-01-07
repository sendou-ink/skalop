# Skalop

Chat microservice for sendou.ink

## Getting started

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

## Docker

Build the image:

```bash
bun run docker:build
```

Start Redis:

```bash
bun run docker:redis
```

Run the container:

```bash
REDIS_URL=redis://host.docker.internal:6379 SKALOP_TOKEN=your-token SESSION_SECRET=secret PORT=3000 bun run docker:start
```
