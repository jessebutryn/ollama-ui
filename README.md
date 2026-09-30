# Ollama UI

A lightweight ChatGPT-style web interface for a local [Ollama](https://ollama.com) server, served by nginx in a Docker container.

## Run

```sh
docker compose up -d --build
```

Then open http://localhost:3000.

The container uses host networking and proxies `/api/*` to Ollama at `http://127.0.0.1:11434`, so Ollama needs no extra configuration.

## Configuration

Environment variables (set in `docker-compose.yml`):

| Variable      | Default                  | Purpose                      |
|---------------|--------------------------|------------------------------|
| `OLLAMA_URL`  | `http://127.0.0.1:11434` | Where the Ollama API lives   |
| `LISTEN_PORT` | `3000`                   | Port the UI is served on     |

### Without host networking (e.g. Docker Desktop on macOS/Windows)

Replace `network_mode: host` with a port mapping and point at the host gateway:

```yaml
    ports:
      - "3000:3000"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      OLLAMA_URL: http://host.docker.internal:11434
```

On Linux this also requires Ollama to listen on more than loopback (`OLLAMA_HOST=0.0.0.0` in the Ollama service environment).

## Features

- Streaming responses with a stop button
- Markdown, syntax-highlighted code blocks with copy buttons
- Model picker populated from your installed models
- Chat history in the sidebar (stored in your browser's localStorage)
- Collapsible "thinking" output for reasoning models (e.g. qwen3, gemma4)
- Image attachments (upload or paste) for vision models
- System prompt and temperature settings
- Regenerate last reply
