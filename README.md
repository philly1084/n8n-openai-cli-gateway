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
- `GET /v1/models`

Also exposed under `/openai/v1/*` for in-cluster compatibility URLs.

Model execution is delegated to configurable CLI providers (Gemini via OpenCode OAuth plugin, Antigravity CLI, Codex CLI, or any other command-line model runner). The gateway keeps n8n on one API key while provider logins are handled on the backend.

## Why this fits your setup

- n8n receives a normal OpenAI-style API base URL + API key.
- Backend handles provider auth flows through admin endpoints and background login jobs.
- Login output logs include URLs/codes so you can copy/paste over SSH from a remote server.
- Built for Kubernetes and GitHub workflows.

## Project layout

- `src/` API server, provider system, auth/login job manager.
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
- optional `auth.loginCommand` and `auth.statusCommand`.

Supported template variables in commands:

- `{{model}}` requested model id from API
- `{{provider_model}}` provider-specific model id
- `{{prompt}}` flattened prompt text
- `{{prompt_file}}` path to temp prompt file
- `{{request_file}}` path to temp request JSON
- `{{request_id}}`
- `{{provider_id}}`

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

## 4) Point n8n at this gateway

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

- raw stdout becomes assistant text.

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

After deploy:

- In-cluster base URL for n8n: `http://n8n-openai-cli-gateway.n8n-openai-gateway.svc.cluster.local/v1`
- External ingress URL (if enabled): `https://gateway.example.com/v1`
- Auth header:
  - `Authorization: Bearer <n8nApiKey>`
  - or `x-api-key: <n8nApiKey>`
