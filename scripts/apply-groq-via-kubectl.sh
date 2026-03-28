#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="n8n-openai-gateway"
CONFIGMAP_NAME="n8n-openai-cli-gateway-config"
DEPLOYMENT_NAME="n8n-openai-cli-gateway"
SECRET_NAME="n8n-openai-cli-gateway-groq"
GROQ_API_KEY=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/apply-groq-via-kubectl.sh --groq-api-key YOUR_KEY [--namespace n8n-openai-gateway]

What it does:
  1. Fetches the current providers.yaml from the gateway ConfigMap
  2. Appends the Groq provider block if it is not already present
  3. Applies the updated ConfigMap back to the cluster
  4. Creates/updates a secret containing GROQ_API_KEY
  5. Injects GROQ_API_KEY into the gateway deployment
  6. Restarts the deployment and waits for rollout
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --groq-api-key)
      GROQ_API_KEY="${2:-}"
      shift 2
      ;;
    --namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$GROQ_API_KEY" ]]; then
  echo "--groq-api-key is required." >&2
  usage >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
providers_file="$tmp_dir/providers.yaml"

echo "Fetching current providers config from namespace $NAMESPACE..."
kubectl get configmap "$CONFIGMAP_NAME" \
  -n "$NAMESPACE" \
  -o jsonpath='{.data.providers\.yaml}' > "$providers_file"

if ! grep -q '^  - id: groq-api$' "$providers_file"; then
  cat >> "$providers_file" <<'EOF'

  - id: groq-api
    type: cli
    description: Groq API via curl using Groq production chat models
    models:
      - id: groq/compound
        providerModel: groq/compound
        fallbackModels:
          - openai/gpt-oss-20b
          - llama-3.3-70b-versatile
      - id: groq/compound-mini
        providerModel: groq/compound-mini
        fallbackModels:
          - openai/gpt-oss-20b
      - id: openai/gpt-oss-120b
        providerModel: openai/gpt-oss-120b
        fallbackModels:
          - openai/gpt-oss-20b
          - llama-3.3-70b-versatile
      - id: openai/gpt-oss-20b
        providerModel: openai/gpt-oss-20b
        fallbackModels:
          - llama-3.1-8b-instant
      - id: llama-3.3-70b-versatile
        providerModel: llama-3.3-70b-versatile
        fallbackModels:
          - openai/gpt-oss-20b
          - llama-3.1-8b-instant
      - id: llama-3.1-8b-instant
        providerModel: llama-3.1-8b-instant
      # Preview models from Groq docs. Uncomment if you want them exposed.
      # - id: meta-llama/llama-4-scout-17b-16e-instruct
      #   providerModel: meta-llama/llama-4-scout-17b-16e-instruct
      # - id: qwen/qwen3-32b
      #   providerModel: qwen/qwen3-32b
    responseCommand:
      executable: sh
      args:
        - -lc
        - |
          REQUEST_JSON="$(cat)"
          PROMPT="$(
            printf "%s" "$REQUEST_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const req=JSON.parse(d);const msgs=Array.isArray(req.messages)?req.messages:[];const norm=v=>typeof v==="string"?v:JSON.stringify(v??"");const text=msgs.map(m=>{const role=String(m&&m.role?m.role:"user").toUpperCase();const content=norm(m&&Object.prototype.hasOwnProperty.call(m,"content")?m.content:"");return role+":\n"+content;}).join("\n\n");process.stdout.write((typeof req.prompt==="string"&&req.prompt.trim()?req.prompt:text).trim());}catch{process.stdout.write("");}});'
          )"
          curl -fsS https://api.groq.com/openai/v1/chat/completions \
            -H "Authorization: Bearer $GROQ_API_KEY" \
            -H "Content-Type: application/json" \
            -d "$(printf '{"model":"%s","messages":[{"role":"user","content":%s}],"stream":false}' "{{provider_model}}" "$(printf "%s" "$PROMPT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(String(d))));')")"
      input: request_json_stdin
      output: json_contract
      timeoutMs: 120000
    auth:
      statusCommand:
        executable: sh
        args:
          - -lc
          - |
            test -n "${GROQ_API_KEY:-}" || { echo '{"ok":false,"error":"GROQ_API_KEY not set"}'; exit 1; }
            curl -fsS https://api.groq.com/openai/v1/models \
              -H "Authorization: Bearer $GROQ_API_KEY" >/dev/null
            echo '{"ok":true}'
        timeoutMs: 15000
EOF
  echo "Appended Groq provider block to providers.yaml."
else
  echo "Groq provider block already present in providers.yaml."
fi

echo "Applying updated ConfigMap..."
kubectl create configmap "$CONFIGMAP_NAME" \
  -n "$NAMESPACE" \
  --from-file=providers.yaml="$providers_file" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

echo "Creating/updating Groq secret..."
kubectl create secret generic "$SECRET_NAME" \
  -n "$NAMESPACE" \
  --from-literal=GROQ_API_KEY="$GROQ_API_KEY" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

echo "Injecting GROQ_API_KEY into deployment..."
kubectl set env deployment/"$DEPLOYMENT_NAME" \
  -n "$NAMESPACE" \
  --containers=gateway \
  --from=secret/"$SECRET_NAME"

echo "Restarting deployment so the new ConfigMap is picked up..."
kubectl rollout restart deployment/"$DEPLOYMENT_NAME" -n "$NAMESPACE"
kubectl rollout status deployment/"$DEPLOYMENT_NAME" -n "$NAMESPACE" --timeout=180s

echo
echo "Groq has been applied. Check the exposed models with:"
echo "kubectl exec -n $NAMESPACE deploy/$DEPLOYMENT_NAME -- curl -s http://localhost:8080/v1/models -H 'x-api-key: YOUR_N8N_API_KEY'"
