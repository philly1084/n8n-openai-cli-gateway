# n8n OpenAI CLI Gateway

[![Build and Push](https://github.com/philly1084/n8n-openai-cli-gateway/actions/workflows/build.yml/badge.svg)](https://github.com/philly1084/n8n-openai-cli-gateway/actions/workflows/build.yml)
[![Docker Image Version (latest semver)](https://img.shields.io/docker/v/ghcr.io/philly1084/n8n-openai-cli-gateway?sort=semver)](https://ghcr.io/philly1084/n8n-openai-cli-gateway)
[![Multi-Architecture](https://img.shields.io/badge/multi--arch-linux%2Famd64%20%7C%20linux%2Farm64-blue)](https://github.com/philly1084/n8n-openai-cli-gateway/pkgs/container/n8n-openai-cli-gateway)

OpenAI-compatible gateway for n8n with multi-architecture support (amd64/arm64).

OpenAI-compatible gateway for n8n that exposes:

- `POST /v1/chat/completions`
- `POST /v1/messages` (alias of chat completions)
- `POST /v1/message` (alias of chat completions)
- `POST /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/documents/generations`
- `POST /v1/files/generations` (alias of document generation)
- `POST /v1/presentations/generations` (alias of document generation)
- `GET /v1/models`

Also exposed under `/openai/v1/*` for in-cluster compatibility URLs.

Model execution is delegated to configurable providers, including CLI runners (Gemini via OpenCode OAuth plugin, Antigravity CLI, Codex CLI) and OpenAI-compatible remote APIs such as Groq. The gateway keeps n8n on one API key while provider auth is handled on the backend.

## Why this fits your setup

- n8n receives a normal OpenAI-style API base URL + API key.
- Backend handles provider auth flows through admin endpoints and background login jobs.
- Login output logs include URLs/codes so you can copy/paste over SSH from a remote server.
- Built for Kubernetes and GitHub workflows.

## Project layout

- `src/` API server, provider system, auth/login job manager.
  - `routes/` OpenAI-compatible and admin API endpoints.
  - `providers/` Provider interface, CLI implementation, and registry.
  - `jobs/` Background login job execution.
  - `stats/` Model health tracking and failure classification.
  - `scripts/` CLI tools and bridges (codex-appserver-bridge, gateway-cli).
  - `utils/` Command execution, ID generation, prompt building, template replacement.
- `config/providers.example.yaml` provider command templates.
- `kubernetes/` deployment/config examples.
- `Dockerfile` production container build.

## Requirements

- Node.js 20+
- Provider CLIs available in runtime image/host (`opencode`, `gemini`, `antigravity`, `codex`, etc.)
- A real providers config file at `config/providers.yaml`

## 1) Configure providers

Copy and edit the template:

```powershell
Copy-Item config/providers.example.yaml config/providers.yaml
```

Each provider defines:

- `models` exposed to n8n.
- `responseCommand` to run model inference.
- optional `auth.loginCommand`, `auth.statusCommand`, and `auth.rateLimitCommand`.
- optional per-model `fallbackModels` list of model ids to try when a provider command fails.

The gateway also supports `type: openai` providers for OpenAI-compatible remote APIs such as Groq. Those providers can auto-discover models from `/models` at startup and register them automatically.

Supported template variables in commands:

- `{{model}}` requested model id from API
- `{{provider_model}}` provider-specific model id
- `{{reasoning_effort}}` normalized reasoning effort (`low`, `medium`, `high`, `xhigh`) when provided
- `{{prompt}}` flattened prompt text
- `{{prompt_file}}` path to temp prompt file
- `{{request_file}}` path to temp request JSON
- `{{request_id}}`
- `{{provider_id}}`

Fallback behavior:

- The gateway first runs the requested model id.
- If that model's command exits with an error and `fallbackModels` are configured, it tries each fallback id in order.
- Fallbacks can cross providers (for example Gemini -> Codex or Codex -> Gemini).

### Codex OAuth app-server bridge

The repository includes `src/scripts/codex-appserver-bridge.ts`, which runs Codex through `codex app-server` (stdio JSON-RPC) and converts results to the gateway `json_contract`.

Use this in provider config:

```yaml
responseCommand:
  executable: node
  args:
    - dist/scripts/codex-appserver-bridge.js
    - --model
    - "{{provider_model}}"
  input: request_json_stdin
  output: json_contract
  timeoutMs: 240000
```

Optional environment variables:

- `CODEX_APPSERVER_MODEL_PROVIDER` (default `openai`)
- `CODEX_APPSERVER_TIMEOUT_MS` (default `240000`)
- `OPENAI_REASONING_EFFORT` default reasoning effort when requests omit it

### Groq API with model discovery

Use the OpenAI-compatible provider type when you want Groq models to be pulled automatically from the upstream `/models` endpoint:

```yaml
- id: groq-api
  type: openai
  description: Groq API - auto-discovers chat-usable models at startup
  baseUrl: https://api.groq.com/openai/v1
  apiKeyEnv: GROQ_API_KEY
  timeoutMs: 60000
  discovery:
    enabled: true
  models:
    - id: groq/compound
      providerModel: groq/compound
      fallbackModels:
        - openai/gpt-oss-20b
        - llama-3.3-70b-versatile
    - id: groq/compound-mini
      providerModel: groq/compound-mini
    - id: openai/gpt-oss-120b
      providerModel: openai/gpt-oss-120b
    - id: openai/gpt-oss-20b
      providerModel: openai/gpt-oss-20b
    - id: llama-3.3-70b-versatile
      providerModel: llama-3.3-70b-versatile
    - id: llama-3.1-8b-instant
      providerModel: llama-3.1-8b-instant
```

By default, discovery filters out obvious non-chat models such as Whisper, TTS, transcription, and guardrail entries. Restarting the gateway refreshes the discovered list.

## 2) Run locally

```powershell
npm install
$env:N8N_API_KEY="replace-me"
$env:ADMIN_API_KEY="replace-me-admin"
$env:PROVIDERS_CONFIG_PATH="config/providers.yaml"
npm run dev
```

Health check:

```powershell
curl http://localhost:8080/healthz
```

## 3) Login flows over SSH

Start login job:

```bash
curl -X POST http://localhost:8080/admin/providers/gemini-cli/login \
  -H "x-admin-key: replace-me-admin"
```

Poll logs (contains URL/code):

```bash
curl http://localhost:8080/admin/jobs/<job_id> \
  -H "x-admin-key: replace-me-admin"
```

List recent login jobs:

```bash
curl "http://localhost:8080/admin/jobs?limit=20" \
  -H "x-admin-key: replace-me-admin"
```

Check auth status:

```bash
curl -X POST http://localhost:8080/admin/providers/gemini-cli/status \
  -H "x-admin-key: replace-me-admin"
```

Model-level health/fallback stats:

```bash
curl http://localhost:8080/admin/stats/models \
  -H "x-admin-key: replace-me-admin"
```

Single model stats:

```bash
curl http://localhost:8080/admin/stats/models/gpt-5-codex \
  -H "x-admin-key: replace-me-admin"
```

Check rate limits for all providers:

```bash
curl http://localhost:8080/admin/rate-limits \
  -H "x-admin-key: replace-me-admin"
```

Check rate limits for specific provider:

```bash
curl http://localhost:8080/admin/rate-limits/gemini-cli \
  -H "x-admin-key: replace-me-admin"
```

## 4) Gateway CLI Tool

A CLI tool is included for querying the gateway from the command line:

```bash
# Check health
npx tsx dist/scripts/gateway-cli.js health

# List providers (shows which support rate limiting)
npx tsx dist/scripts/gateway-cli.js providers -k <admin-key>

# Check all rate limits
npx tsx dist/scripts/gateway-cli.js rate-limits -k <admin-key>

# Check specific provider rate limits
npx tsx dist/scripts/gateway-cli.js rate-limits -k <admin-key> -p gemini-cli

# Output as JSON
npx tsx dist/scripts/gateway-cli.js rate-limits -k <admin-key> -f json
```

Environment variables for CLI:
- `GATEWAY_URL` - Gateway URL (default: http://localhost:8080)
- `ADMIN_API_KEY` - Admin API key

## 5) Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `N8N_API_KEY` or `N8N_API_KEYS` | API key(s) for n8n access (comma-separated for multiple) | `sk-n8n-xxx` |
| `ADMIN_API_KEY` | API key for admin endpoints | `sk-admin-xxx` |
| `PROVIDERS_CONFIG_PATH` | Path to providers.yaml | `config/providers.yaml` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `8080` | Server port |
| `LOG_LEVEL` | `info` | Fastify log level (trace/debug/info/warn/error/fatal) |
| `MAX_JOB_LOG_LINES` | `300` | Max log lines to retain per login job |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown timeout (milliseconds) |
| `RATE_LIMIT_MAX` | `100` | Max requests per rate limit window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (milliseconds) |
| `MAX_REQUEST_BODY_SIZE` | `10485760` | Max request body size in bytes (10MB) |
| `OPENAI_REASONING_EFFORT` | provider default | Default reasoning effort for chat/responses requests |
| `OPENAI_API_KEY` | unset | API key for OpenAI `type: openai` providers, including image generation |
| `GROQ_API_KEY` | unset | API key for Groq `type: openai` providers |

Kimi is configured through the local `kimi` CLI via an ACP bridge in the current examples. It does not use `KIMI_API_KEY`; authenticate once in the provider home by running `kimi` in a TTY and then `/login` (some older CLI builds still use `/setup`).

### Reasoning flags

The gateway accepts these request forms:

- `reasoning_effort: "medium"`
- `reasoningEffort: "medium"`
- `reasoning: { "effort": "medium" }`

Supported values are `low`, `medium`, `high`, and `xhigh`. For `/v1/chat/completions`, use `reasoning_effort` or `reasoningEffort`. For `/v1/responses`, all three forms are accepted.

## 6) Request Tracing

The gateway generates a unique `x-request-id` for every request. This ID is:
- Returned in the response header
- Included in error responses
- Logged with request details (at debug level)

Use this for tracing requests through logs:

```bash
curl -H "x-api-key: <key>" http://localhost:8080/healthz -v
# < x-request-id: req_abc123...
```

## 7) CLI Execution for Software Development

The gateway includes endpoints to execute CLI commands for automated software development workflows. This allows n8n to trigger git operations, Docker builds, and Kubernetes deployments programmatically.

### Available Commands

- **Git**: `clone`, `commit`, `push`
- **Docker**: `build`, `push`
- **Kubernetes**: `kubectl apply`, `helm install`
- **Build tools**: `npm`, `node`, `make`, `terraform`
- **General**: Any command in the allowed whitelist

### Example Workflow

Clone a repository, build a Docker image, and deploy to Kubernetes:

```bash
# 1. Clone repository
curl -X POST http://localhost:8080/admin/cli/git/clone \
  -H "x-admin-key: <admin-key>" \
  -d '{"repo": "https://github.com/user/myapp.git", "dir": "myapp"}'

# 2. Build Docker image
curl -X POST http://localhost:8080/admin/cli/docker/build \
  -H "x-admin-key: <admin-key>" \
  -d '{"tag": "ghcr.io/user/myapp:v1.0.0", "context": "./myapp"}'

# 3. Push to registry
curl -X POST http://localhost:8080/admin/cli/exec \
  -H "x-admin-key: <admin-key>" \
  -d '{"command": "docker", "args": ["push", "ghcr.io/user/myapp:v1.0.0"]}'

# 4. Deploy to Kubernetes
curl -X POST http://localhost:8080/admin/cli/kubectl/apply \
  -H "x-admin-key: <admin-key>" \
  -d '{"dir": "./myapp/k8s", "namespace": "production"}'
```

### Check Job Status

All CLI commands run asynchronously. Get the job ID from the response and poll for results:

```bash
curl http://localhost:8080/admin/cli/jobs/cli_abc123 \
  -H "x-admin-key: <admin-key>"
```

Response includes `stdout`, `stderr`, `exitCode`, and `status` (running/completed/failed/timed_out).

## 8) Point n8n at this gateway

In n8n OpenAI credentials:

- Base URL: `http://<gateway-host>:8080/v1`
- API Key: value of `N8N_API_KEY`

For Agents/Tools use model ids from `GET /v1/models`.

All `/v1/*` and `/openai/v1/*` routes require either:

```http
Authorization: Bearer <N8N_API_KEY>
```

or:

```http
x-api-key: <N8N_API_KEY>
```

## Provider output contract

`responseCommand.output: text`:

- legacy text mode: raw stdout is returned as assistant text, but the gateway may
  promote JSON-like content to a tool-call contract.

`responseCommand.output: text_plain`:

- strict plain text mode: raw stdout becomes assistant text.
- no JSON/tool-call extraction is attempted.

`responseCommand.output: text_contract_final_line`:

- hybrid strict mode for tool experiments.
- the gateway only tries to parse the final non-empty line as a JSON contract.
- if that final line is invalid contract JSON, output is treated as plain text (`finish_reason: "stop"`).

`responseCommand.output: json_contract`:

- command stdout must be JSON (or final line JSON), shape:

```json
{
  "output_text": "assistant answer",
  "tool_calls": [
    {
      "id": "call_1",
      "name": "search_docs",
      "arguments": "{\"query\":\"oauth\"}"
    }
  ],
  "finish_reason": "tool_calls"
}
```

The gateway also accepts `responses` follow-up tool input entries of `type: "function_call_output"` and maps them to tool-role messages for the next model turn.

### Gemini provider guidance

- Use the dedicated Gemini bridge (`dist/scripts/gemini-cli-bridge.js`) for tool turns.
- The bridge normalizes Gemini `stream-json` output into the same JSON tool-call contract used by the Codex and Kimi adapters.

### Image generation provider output

`POST /v1/images/generations` runs the selected model and maps provider output to OpenAI image response format.

For real OpenAI-hosted image generation, prefer a `type: openai` provider pointed at `https://api.openai.com/v1` with `gpt-image-1.5`, `gpt-image-1`, or `gpt-image-1-mini`. Codex CLI models are useful for coding/chat, but not as the primary backend for the Images API.

Accepted provider output patterns:

- plain URL text: `https://...`
- plain data URL text: `data:image/png;base64,...`
- JSON object/array in text:
  - `{"data":[{"url":"https://..."}]}`
  - `{"data":[{"b64_json":"..."}]}`
  - `[{"url":"https://..."}]`
  - `{"images":[{"b64_json":"...","revised_prompt":"..."}]}`

Returned shape:

```json
{
  "created": 0,
  "data": [
    {
      "url": "https://...",
      "b64_json": "...",
      "revised_prompt": "optional"
    }
  ]
}
```

### Document generation provider output

`POST /v1/documents/generations`, `POST /v1/files/generations`, and `POST /v1/presentations/generations` run the selected model and expect document payloads in JSON or base64 form. Use the presentations alias when the provider is producing decks such as `.pptx`.

Accepted provider output patterns:

- raw base64 text
- data URL text such as `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,...`
- JSON object/array in text:
  - `{"data":[{"filename":"deck.pptx","mime_type":"application/vnd.openxmlformats-officedocument.presentationml.presentation","b64_data":"..."}]}`
  - `{"documents":[{"filename":"deck.pptx","base64":"..."}]}`
  - `[{"name":"deck.pptx","b64_json":"..."}]`

Optional design/document fields that are also passed through when present:

- `title`
- `summary`
- `text`
- `markdown`
- `html`
- `page_count`
- `slide_count`
- `theme`
- `template`
- `design_style`
- `preview_url`
- `preview_b64_json`
- `slides` as an array of `{title, subtitle, text, notes, bullets, image_url}`

Request body:

```json
{
  "model": "gemini-2.5-flash",
  "prompt": "Create a 5-slide product overview deck.",
  "file_type": "pptx",
  "filename": "product-overview.pptx"
}
```

Returned shape:

```json
{
  "created": 0,
  "data": [
    {
      "filename": "product-overview.pptx",
      "mime_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "b64_data": "...",
      "title": "Product Overview",
      "slide_count": 5,
      "theme": "modern",
      "design_style": "editorial",
      "slides": [
        {
          "title": "Problem",
          "bullets": ["Fragmented workflow", "High reporting overhead"]
        }
      ]
    }
  ]
}
```

## Kubernetes

Use:

- `kubernetes/deployment.yaml`
- `kubernetes/configmap-example.yaml`
- `kubernetes/rancher-install.yaml` (single-file Rancher import)

Important for OAuth/token persistence:

- `HOME` is mounted to PVC: `/var/lib/gateway-home`
- Provider CLIs should store credentials under this persistent path.
- Deployment is pinned to `arm64` nodes via `nodeSelector`.
  Remove the selector if you publish a multi-arch image and want mixed scheduling.

### Gemini auth bootstrap secret

The Kubernetes manifests now support an optional Secret named `n8n-openai-cli-gateway-gemini-auth`.
If the PVC does not already contain `/var/lib/gateway-home/.gemini/oauth_creds.json`, an init container
will seed `/var/lib/gateway-home/.gemini/` from that Secret on startup. Existing PVC auth is left untouched.

This is the repeatable way to bring Gemini auth forward to a fresh cluster or a fresh PVC.

Create or refresh the Secret from a running gateway pod:

```bash
chmod +x scripts/bootstrap-gemini-auth-secret.sh
./scripts/bootstrap-gemini-auth-secret.sh
```

Create or refresh the Secret from a local Gemini CLI directory:

```bash
./scripts/bootstrap-gemini-auth-secret.sh --source-dir "$HOME/.gemini"
```

Windows PowerShell:

```powershell
.\scripts\bootstrap-gemini-auth-secret.ps1
.\scripts\bootstrap-gemini-auth-secret.ps1 -SourceDir "$HOME\.gemini"
```

After updating the Secret, restart the deployment if you want a fresh PVC to be seeded on next start:

```bash
kubectl rollout restart deployment/n8n-openai-cli-gateway -n n8n-openai-gateway
```

## Build image

```bash
docker build -t n8n-openai-cli-gateway:latest .
```

If provider CLIs are not in PATH, extend `Dockerfile` to install them in the runtime image.

For Linux arm64 builds and pushes:

```bash
docker buildx build \
  --platform linux/arm64 \
  -t ghcr.io/your-org/n8n-openai-cli-gateway:latest \
  --push .
```

To bake CLI packages into the image:

```bash
docker buildx build \
  --platform linux/arm64 \
  --build-arg EXTRA_NPM_GLOBAL_PACKAGES="@openai/codex @google/gemini-cli opencode-ai" \
  -t ghcr.io/your-org/n8n-openai-cli-gateway:latest \
  --push .
```

Use only CLI packages that publish Linux arm64 binaries.

### OpenCode OAuth for Gemini

If you use the `opencode-gemini-auth` plugin, mount this config at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth@latest"]
}
```

Then run login interactively in the pod:

```bash
kubectl -n n8n-openai-gateway exec -it deploy/n8n-openai-cli-gateway -- opencode auth login
```

## Rancher Install

Use `kubernetes/rancher-install.yaml` as a single import in Rancher:

1. In Rancher, go to your target cluster and choose `Import YAML`.
2. Paste `kubernetes/rancher-install.yaml`.
3. Change:
   - `ghcr.io/your-org/n8n-openai-cli-gateway:latest`
   - secret values `n8nApiKey` and `adminApiKey`
   - ingress host `gateway.example.com`
   - `providers.yaml` contents for your real CLI commands/models
4. Deploy.

Optional for Gemini CLI:

- Create the `n8n-openai-cli-gateway-gemini-auth` Secret before first start if you want Rancher to seed Gemini OAuth state into a new PVC automatically.
- Use `scripts/bootstrap-gemini-auth-secret.sh` or `scripts/bootstrap-gemini-auth-secret.ps1` to export that Secret from an existing working environment.

After deploy:

- In-cluster base URL for n8n: `http://n8n-openai-cli-gateway.n8n-openai-gateway.svc.cluster.local/v1`
- External ingress URL (if enabled): `https://gateway.example.com/v1`
- Auth header:
  - `Authorization: Bearer <n8nApiKey>`
  - or `x-api-key: <n8nApiKey>`

### Add Groq to the Rancher bundle

If you already use the bundled Rancher manifest, generate a merged copy with Groq added.

Ubuntu/Linux:

```bash
chmod +x scripts/merge-rancher-groq.sh
./scripts/merge-rancher-groq.sh \
  --input kubernetes/rancher-install.yaml \
  --output kubernetes/rancher-install-groq.yaml \
  --groq-api-key "replace-with-your-groq-api-key"
```

PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/merge-rancher-groq.ps1 `
  -InputPath kubernetes/rancher-install.yaml `
  -OutputPath kubernetes/rancher-install-groq.yaml `
  -GroqApiKey "replace-with-your-groq-api-key"
```

That writes `kubernetes/rancher-install-groq.yaml` with:

- `groqApiKey` added to the gateway secret
- `GROQ_API_KEY` added to the gateway deployment
- a Groq provider block added to the embedded `providers.yaml`

The generated Groq models match the current Groq docs production/system IDs:

- `groq/compound`
- `groq/compound-mini`
- `openai/gpt-oss-120b`
- `openai/gpt-oss-20b`
- `llama-3.3-70b-versatile`
- `llama-3.1-8b-instant`

Do not import `kubernetes/groq-rancher-overlay.yaml` directly into Rancher as a standalone manifest. Rancher applies imported YAML as full Kubernetes resources, and that file is only suitable as a patch-style overlay, not a complete deployment object.
